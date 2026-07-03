import {
  AMLC_AMLS_BLOCK_LENGTH,
  AMLC_MAX_BLOCK_LENGTH,
  AMLC_MAX_TRANSFER_LENGTH,
  BULK_REPLY_LEN,
  DEFAULT_ACK_LEN,
  FLAG_KEEP_POWER_ON,
  MAX_LARGE_BLOCK_COUNT,
  Request,
  SIMPLE_MEMORY_CHUNK,
  TPL_STAT_LEN,
  WRITE_MEDIA_BLOCK_SIZE
} from './constants'
import { AmlcError, AmlUsbError, BulkCmdError, MediaWriteError, TplCmdError } from './errors'
import {
  buildAmlsHeader,
  buildLargeMemoryHeader,
  buildOkayPacket,
  buildWriteMediaHeader,
  encodeCommand,
  parseAmlcRequest,
  splitAddress,
  startsWithAscii,
  trimNulls
} from './headers'
import { DeviceInfo } from './info'
import { consoleLogger, Logger, LogLevel } from './logger'
import { UsbTransport, WebUsbTransport } from './transport'
import { asBlob, ImageSource, readBlob } from './utils/blob'
import { concatBytes, encodeAscii, packUint32sLE, readUint32LE } from './utils/bytes'
import { amlsChecksum } from './utils/checksum'
import { delay, timeoutPromise } from './utils/timeout'

export type DeviceOptions = {
  /** whether to enable additional logging (basic logging is already enabled) */
  logging: boolean
  /** the number of milliseconds to time out after */
  timeout: number
  /** where to send log output; defaults to the console */
  logger?: Logger
}

export type Progress = {
  bytesTransferred: number
  totalBytes: number
}

export type ProgressCallback = (progress: Progress) => void

const DEFAULT_DEVICE_OPTIONS: DeviceOptions = {
  logging: false,
  timeout: 5000
}

/** Continue:3x replies mean "busy, poll again after a pause" */
const BUSY_RETRY_DELAY = 3000
const MEDIA_ACK_TIMEOUT = 10_000
const MEDIA_RESEND_DELAY = 200

function isUsbDevice(value: UsbTransport | USBDevice): value is USBDevice {
  return 'controlTransferIn' in value && typeof value.controlTransferIn === 'function'
}

/** Start a read early, marking it handled so a transfer error elsewhere cannot
 * surface it as an unhandled rejection; awaiting it still throws. */
function prefetch<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {})
  return promise
}

function toBytes(data: Uint8Array | string): Uint8Array<ArrayBuffer> {
  if (typeof data !== 'string') {
    // copy so the byteOffset is 0 and the buffer type is concrete
    return new Uint8Array(data)
  }
  return encodeAscii(data)
}

/** An Amlogic SoC in USB boot mode (legacy/Optimus protocol, 1b8e:c003). */
export class Device {
  transport: UsbTransport
  deviceOptions: DeviceOptions

  constructor(transport: UsbTransport | USBDevice, options?: Partial<DeviceOptions>) {
    this.transport = isUsbDevice(transport) ? new WebUsbTransport(transport) : transport
    this.deviceOptions = { ...DEFAULT_DEVICE_OPTIONS, ...options }
  }

  /** The underlying WebUSB device, when connected over WebUSB. */
  get usbDevice(): USBDevice | undefined {
    return this.transport instanceof WebUsbTransport ? this.transport.device : undefined
  }

  _log(level: LogLevel, ...data: unknown[]) {
    if (level === 'debug' && !this.deviceOptions.logging) return
    ;(this.deviceOptions.logger ?? consoleLogger)(level, ...data)
  }

  /** Open and claim the device */
  async initialize() {
    try {
      await this.transport.connect(this.deviceOptions.timeout)
    } catch (errorMsg) {
      this._log('debug', errorMsg)
      throw new AmlUsbError('Unable to open and claim device', { cause: errorMsg })
    }
  }

  async close() {
    await this.transport.close(this.deviceOptions.timeout)
  }

  onDisconnect(callback: () => void) {
    this.transport.onDisconnect(callback)
  }

  private get timeout() {
    return this.deviceOptions.timeout
  }

  // ---- ROM primitives (control transfers only) ----

  /** Read and parse the 8-byte identify response */
  async identify(): Promise<DeviceInfo> {
    const raw = await this.transport.controlIn(Request.IDENTIFY_HOST, 0, 0, 8, this.timeout)
    return new DeviceInfo(raw)
  }

  /** No-operation, for testing connectivity */
  async nop() {
    await this.transport.controlOut(Request.NOP, 0, 0, undefined, this.timeout)
  }

  /** Unlock a password-protected board */
  async sendPassword(password: Uint8Array | string) {
    await this.transport.controlOut(Request.PASSWORD, 0, 0, toBytes(password), this.timeout)
  }

  /** Write up to 64 bytes of memory in a single control transfer */
  async writeSimpleMemory(address: number, data: Uint8Array) {
    if (data.length > SIMPLE_MEMORY_CHUNK) {
      throw new AmlUsbError(`maximum size of ${SIMPLE_MEMORY_CHUNK} bytes`)
    }
    const { value, index } = splitAddress(address)
    await this.transport.controlOut(Request.WRITE_MEM, value, index, toBytes(data), this.timeout)
  }

  /** Write memory in 64-byte control transfer chunks */
  async writeMemory(address: number, data: Uint8Array) {
    for (let offset = 0; offset < data.length; offset += SIMPLE_MEMORY_CHUNK) {
      await this.writeSimpleMemory(
        address + offset,
        data.subarray(offset, offset + SIMPLE_MEMORY_CHUNK)
      )
    }
  }

  /** Read up to 64 bytes of memory in a single control transfer */
  async readSimpleMemory(address: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    if (length === 0) return new Uint8Array()
    if (length > SIMPLE_MEMORY_CHUNK) {
      throw new AmlUsbError(`maximum size of ${SIMPLE_MEMORY_CHUNK} bytes`)
    }
    const { value, index } = splitAddress(address)
    return this.transport.controlIn(Request.READ_MEM, value, index, length, this.timeout)
  }

  /** Read memory in 64-byte control transfer chunks */
  async readMemory(address: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    const chunks: Uint8Array[] = []
    for (let offset = 0; offset < length; offset += SIMPLE_MEMORY_CHUNK) {
      chunks.push(
        await this.readSimpleMemory(
          address + offset,
          Math.min(SIMPLE_MEMORY_CHUNK, length - offset)
        )
      )
    }
    return concatBytes(chunks)
  }

  /** Modify memory with a masked/copy operation (see pyamlboot for opcodes) */
  async modifyMemory(
    opcode: number,
    address1: number,
    data: number,
    mask: number,
    address2: number
  ) {
    const payload = packUint32sLE([address1, data, mask, address2])
    await this.transport.controlOut(Request.MODIFY_MEM, opcode, 0, payload, this.timeout)
  }
  // TODO: masked-register helpers (maskRegAND/OR/NAND, writeRegBits, copyReg, memcpy)
  // are untested in pyamlboot and omitted here

  /** Read a 32-bit little-endian register */
  async readReg(address: number): Promise<number> {
    return readUint32LE(await this.readSimpleMemory(address, 4))
  }

  /** Write a 32-bit register via MODIFY_MEM opcode 0 */
  async writeReg(address: number, value: number) {
    await this.modifyMemory(0, address, value, 0, 0)
  }

  /** Run code at an address */
  async run(address: number, keepPowerOn = true) {
    const { value, index } = splitAddress(address)
    const payload = packUint32sLE([keepPowerOn ? address | FLAG_KEEP_POWER_ON : address])
    await this.transport.controlOut(Request.RUN_IN_ADDR, value, index, payload, this.timeout)
  }

  // ---- large memory (control setup + bulk data) ----

  /**
   * Write a large block of memory, streamed over the bulk OUT endpoint with a
   * programmable block length.
   */
  async writeLargeMemory(
    address: number,
    source: ImageSource,
    options?: { blockLength?: number; appendZeros?: boolean; onProgress?: ProgressCallback }
  ) {
    const { blockLength = 64, appendZeros = false, onProgress } = options ?? {}
    const blob = asBlob(source)
    if (!appendZeros && blob.size % blockLength !== 0) {
      throw new AmlUsbError('large data must be a multiple of the block length')
    }

    // blockCount is carried in the 16-bit wIndex, so cap each transfer
    const maxTransferLength = MAX_LARGE_BLOCK_COUNT * blockLength
    const readChunk = (offset: number) =>
      readBlob(blob, offset, Math.min(maxTransferLength, blob.size - offset))
    let transferred = 0
    let pending: Promise<Uint8Array<ArrayBuffer>> | undefined = prefetch(readChunk(0))

    while (transferred < blob.size) {
      const chunk: Uint8Array<ArrayBuffer> = await pending!
      let data = chunk
      if (chunk.length % blockLength !== 0) {
        data = new Uint8Array(chunk.length + blockLength - (chunk.length % blockLength))
        data.set(chunk)
      }
      const blockCount = data.length / blockLength
      // overlap the next blob read with this chunk's USB transfer
      const nextOffset = transferred + chunk.length
      pending = nextOffset < blob.size ? prefetch(readChunk(nextOffset)) : undefined

      await this.transport.controlOut(
        Request.WR_LARGE_MEM,
        blockLength,
        blockCount,
        buildLargeMemoryHeader(address + transferred, data.length),
        this.timeout
      )
      for (let offset = 0; offset < data.length; offset += blockLength) {
        await this.transport.bulkOut(data.subarray(offset, offset + blockLength), this.timeout)
      }

      transferred = nextOffset
      onProgress?.({ bytesTransferred: transferred, totalBytes: blob.size })
    }
  }

  /** Read a large block of memory, streamed over the bulk IN endpoint. */
  async readLargeMemory(
    address: number,
    length: number,
    options?: { blockLength?: number }
  ): Promise<Uint8Array<ArrayBuffer>> {
    const { blockLength = 64 } = options ?? {}
    if (length % blockLength !== 0) {
      throw new AmlUsbError('large data must be a multiple of the block length')
    }

    const maxTransferLength = MAX_LARGE_BLOCK_COUNT * blockLength
    const chunks: Uint8Array[] = []
    let transferred = 0

    while (transferred < length) {
      const readLength = Math.min(maxTransferLength, length - transferred)
      const blockCount = readLength / blockLength

      await this.transport.controlOut(
        Request.RD_LARGE_MEM,
        blockLength,
        blockCount,
        buildLargeMemoryHeader(address + transferred, readLength),
        this.timeout
      )
      for (let i = 0; i < blockCount; i++) {
        const chunk = await this.transport.bulkIn(blockLength, this.timeout)
        // a short bulk-in packet would silently truncate the result
        if (chunk.length !== blockLength) {
          throw new AmlUsbError(
            `short bulk read: expected ${blockLength} bytes, received ${chunk.length}`
          )
        }
        chunks.push(chunk)
      }

      transferred += readLength
    }

    return concatBytes(chunks)
  }

  // ---- string commands ----

  /** Send a TPL command (early U-Boot control channel) */
  async tplCommand(subcode: number, command: string) {
    await this.transport.controlOut(
      Request.TPL_CMD,
      0,
      subcode,
      encodeCommand(command),
      this.timeout
    )
  }

  /** Read TPL command status */
  async tplStat(timeout?: number): Promise<Uint8Array<ArrayBuffer>> {
    return this.transport.controlIn(Request.TPL_STAT, 0, 0, TPL_STAT_LEN, timeout ?? this.timeout)
  }

  /** Send a TPL command and verify its status response */
  async checkTplCommand(command: string, expect = 'success') {
    await this.tplCommand(1, command)
    const response = trimNulls(await this.tplStat())
    if (response !== expect) {
      throw new TplCmdError(command, response)
    }
  }

  /**
   * Execute an arbitrary string command (a U-Boot command when talking to
   * U-Boot's implementation of the protocol).
   */
  async bulkCmd(
    command: string,
    options?: { readStatus?: boolean; timeout?: number }
  ): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const { readStatus = true, timeout } = options ?? {}
    // wValue/wIndex are ignored by the device; wIndex=2 matches pyamlboot
    await this.transport.controlOut(Request.BULKCMD, 0, 2, encodeCommand(command), this.timeout)
    if (readStatus) {
      return this.bulkCmdStat(timeout)
    }
    return undefined
  }

  /** Read a bulk command status reply */
  async bulkCmdStat(timeout?: number): Promise<Uint8Array<ArrayBuffer>> {
    return this.transport.bulkIn(BULK_REPLY_LEN, timeout ?? this.timeout)
  }

  /**
   * Poll `read` through `Continue:3x` busy replies (and transient errors)
   * until a real reply arrives or the deadline passes. The deadline is
   * checked before each busy pause, so a single busy reply always gets at
   * least one more poll even when the pause is as long as the timeout.
   */
  private async pollThroughBusy(
    read: () => Promise<Uint8Array<ArrayBuffer>>,
    busyPrefix: string,
    timeout: number,
    busyRetryDelay: number,
    timeoutMessage: string
  ): Promise<Uint8Array<ArrayBuffer>> {
    const deadline = Date.now() + timeout
    for (;;) {
      let error: unknown
      try {
        const response = await read()
        if (!startsWithAscii(response, busyPrefix)) return response
      } catch (e) {
        error = e
      }
      if (Date.now() >= deadline) {
        if (error instanceof Error) throw error
        throw new AmlUsbError(timeoutMessage)
      }
      if (error === undefined) await delay(busyRetryDelay)
    }
  }

  /**
   * Execute a string command, polling through `Continue:34` busy replies, and
   * verify the final status.
   * @returns the NUL-trimmed response text (usually 'success')
   */
  async checkBulkCmd(
    command: string,
    options?: { expect?: string; timeout?: number; busyRetryDelay?: number }
  ): Promise<string> {
    const { expect = 'success', timeout = 3000, busyRetryDelay = BUSY_RETRY_DELAY } = options ?? {}
    await this.bulkCmd(command, { readStatus: false })

    const response = await this.pollThroughBusy(
      () => this.bulkCmdStat(timeout),
      'Continue:34',
      timeout,
      busyRetryDelay,
      `bulk command '${command}' timed out`
    )

    const text = trimNulls(response)
    if (text !== expect) {
      throw new BulkCmdError(command, text)
    }
    return text
  }

  // ---- media (partition) streaming ----

  /**
   * Write one block of media data. The write target must have been selected
   * with a `download ...` command first.
   */
  async writeMedia(
    data: Uint8Array<ArrayBuffer>,
    options?: { ackLen?: number; seq?: number; retryTimes?: number }
  ) {
    const { ackLen = DEFAULT_ACK_LEN, seq = 0, retryTimes = 0 } = options ?? {}
    const header = buildWriteMediaHeader(retryTimes, data.length, seq, amlsChecksum(data), ackLen)
    await this.transport.controlOut(Request.WRITE_MEDIA, 1, 0xffff, header, this.timeout)
    await this.transport.bulkOut(data, this.timeout)
  }

  /**
   * Stream an image to the selected media target in 64 KiB blocks with
   * per-block acknowledgements and retries. Issue the `download ...` command
   * first, and `download get_status` after.
   */
  async writeMediaStream(
    source: ImageSource,
    options?: {
      onProgress?: ProgressCallback
      ackLen?: number
      resendTimes?: number
      ackTimeout?: number
      busyRetryDelay?: number
      resendDelay?: number
    }
  ) {
    const blob = asBlob(source)
    const readChunk = (offset: number) =>
      readBlob(blob, offset, Math.min(WRITE_MEDIA_BLOCK_SIZE, blob.size - offset))
    let seq = 0
    let transferred = 0
    let pending: Promise<Uint8Array<ArrayBuffer>> | undefined = prefetch(readChunk(0))

    while (transferred < blob.size) {
      const data: Uint8Array<ArrayBuffer> = await pending!
      // overlap the next blob read with this block's USB write and ack wait
      const nextOffset = transferred + data.length
      pending = nextOffset < blob.size ? prefetch(readChunk(nextOffset)) : undefined
      await this.tryWriteMedia(data, seq, options)
      seq += 1
      transferred = nextOffset
      options?.onProgress?.({ bytesTransferred: transferred, totalBytes: blob.size })
    }
  }

  private async tryWriteMedia(
    data: Uint8Array<ArrayBuffer>,
    seq: number,
    options?: {
      ackLen?: number
      resendTimes?: number
      ackTimeout?: number
      busyRetryDelay?: number
      resendDelay?: number
    }
  ) {
    const {
      ackLen = DEFAULT_ACK_LEN,
      resendTimes = 3,
      ackTimeout = MEDIA_ACK_TIMEOUT,
      busyRetryDelay = BUSY_RETRY_DELAY,
      resendDelay = MEDIA_RESEND_DELAY
    } = options ?? {}

    let retryTimes = 0
    for (;;) {
      let received: Uint8Array | undefined
      try {
        await this.writeMedia(data, { ackLen, seq, retryTimes })
        received = await this.pollThroughBusy(
          () => this.transport.bulkIn(ackLen, this.timeout),
          'Continue:32',
          ackTimeout,
          busyRetryDelay,
          `media write ack timed out at block ${seq}`
        )
      } catch (error) {
        this._log('debug', error)
      }

      if (received !== undefined && startsWithAscii(received, 'OK!!')) {
        return
      }

      retryTimes += 1
      if (retryTimes > resendTimes) {
        throw new MediaWriteError(seq, retryTimes)
      }
      await delay(resendDelay)
    }
  }

  /**
   * Read data from storage. The read source must have been selected with an
   * `upload ...` command first.
   */
  async readMedia(size: number, timeout?: number): Promise<Uint8Array<ArrayBuffer>> {
    // the size is carried in the 16-bit wValue
    if (size > 0xffff) {
      throw new AmlUsbError(`readMedia supports at most ${0xffff} bytes per call`)
    }
    const blocks = Math.ceil(size / 0x1000)
    await this.transport.controlIn(Request.READ_MEDIA, size, blocks, 16, this.timeout)
    return this.transport.bulkIn(size, timeout ?? this.timeout)
  }

  // ---- AMLC/AMLS (BL2-driven U-Boot streaming, G12A/G12B/SM1) ----

  /** Read the next BL2 AMLC data request and acknowledge it */
  async getBootAMLC(): Promise<{ length: number; offset: number }> {
    await this.transport.controlOut(
      Request.GET_AMLC,
      AMLC_AMLS_BLOCK_LENGTH,
      0,
      undefined,
      this.timeout
    )
    const block = await this.transport.bulkIn(AMLC_AMLS_BLOCK_LENGTH, this.timeout)
    const request = parseAmlcRequest(block)
    await this.transport.bulkOut(buildOkayPacket(), this.timeout)
    return request
  }

  /** Write one AMLC sub-transfer (data chunk or AMLS trailer) */
  private async writeAMLCChunk(offset: number, data: Uint8Array<ArrayBuffer>) {
    await this.transport.controlOut(
      Request.WRITE_AMLC,
      Math.floor(offset / AMLC_AMLS_BLOCK_LENGTH),
      data.length - 1,
      undefined,
      this.timeout
    )

    for (let written = 0; written < data.length; written += AMLC_MAX_BLOCK_LENGTH) {
      await this.transport.bulkOut(
        data.subarray(written, written + AMLC_MAX_BLOCK_LENGTH),
        this.timeout
      )
    }

    const ack = await this.transport.bulkIn(16, this.timeout)
    if (!startsWithAscii(ack, 'OKAY')) {
      throw new AmlcError(`invalid AMLC data write ack: '${trimNulls(ack)}'`)
    }
  }

  /** Answer one AMLC data request, finishing with the checksummed AMLS trailer */
  async writeAMLCData(seq: number, amlcOffset: number, data: Uint8Array<ArrayBuffer>) {
    for (let offset = 0; offset < data.length; offset += AMLC_MAX_TRANSFER_LENGTH) {
      await this.writeAMLCChunk(offset, data.subarray(offset, offset + AMLC_MAX_TRANSFER_LENGTH))
    }

    // AMLS carries a checksum over the full block plus a copy of bytes 16..512
    const amls = concatBytes([buildAmlsHeader(seq, amlsChecksum(data)), data.subarray(16, 512)])
    await this.writeAMLCChunk(amlcOffset, amls)
  }

  /**
   * Serve BL2's AMLC requests from an image until it reports completion (the
   * G12A+ path for loading U-Boot).
   */
  async bootAMLC(source: ImageSource, options?: { onProgress?: ProgressCallback }) {
    const blob = asBlob(source)
    let previous = { length: -1, offset: -1 }
    let seq = 0
    let transferred = 0

    for (;;) {
      const request = await this.getBootAMLC()
      this._log('debug', `AMLC dataSize=${request.length}, offset=${request.offset}, seq=${seq}`)

      // BL2 signals completion by repeating the previous request
      if (request.length === previous.length && request.offset === previous.offset) {
        break
      }
      previous = request

      const data = await readBlob(blob, request.offset, request.length)
      if (data.length === 0) {
        throw new AmlcError('unexpected end of image')
      }

      await this.writeAMLCData(seq, request.offset, data)
      seq += 1
      transferred += data.length
      options?.onProgress?.({ bytesTransferred: transferred, totalBytes: blob.size })
    }
  }

  /** Wait until the device answers identify(), or reject after `timeout` ms */
  async waitForIdentify(timeout = 10_000): Promise<DeviceInfo> {
    const poll = async (): Promise<DeviceInfo> => {
      for (;;) {
        try {
          return await this.identify()
        } catch {
          await delay(200)
        }
      }
    }
    return timeoutPromise(poll(), 'timed out waiting for the device to identify', timeout)
  }
}
