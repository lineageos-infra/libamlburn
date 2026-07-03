import { describe, expect, test } from 'vitest'
import { Request } from '../src/constants'
import { Device } from '../src/device'
import { AmlcError, AmlUsbError, BulkCmdError, MediaWriteError, TplCmdError } from '../src/errors'
import { UsbTransport } from '../src/transport'
import { amlsChecksum } from '../src/utils/checksum'

type ControlOutCall = { request: number; value: number; index: number; data?: Uint8Array }
type ControlInCall = { request: number; value: number; index: number; length: number }

function ascii(text: string, padTo = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(Math.max(text.length, padTo))
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
  return bytes
}

function createFakeTransport() {
  const controlsOut: ControlOutCall[] = []
  const controlsIn: ControlInCall[] = []
  const bulkSent: Uint8Array[] = []
  const controlInQueue: Uint8Array<ArrayBuffer>[] = []
  const bulkInQueue: (Uint8Array<ArrayBuffer> | Error)[] = []

  const transport = {
    connect: () => Promise.resolve(),
    controlOut: (request: number, value: number, index: number, data?: Uint8Array<ArrayBuffer>) => {
      controlsOut.push({ request, value, index, ...(data ? { data: data.slice() } : {}) })
      return Promise.resolve(data?.length ?? 0)
    },
    controlIn: (request: number, value: number, index: number, length: number) => {
      controlsIn.push({ request, value, index, length })
      const reply = controlInQueue.shift()
      if (!reply) return Promise.reject(new Error('no control reply queued'))
      return Promise.resolve(reply)
    },
    bulkOut: (data: Uint8Array<ArrayBuffer>) => {
      bulkSent.push(data.slice())
      return Promise.resolve()
    },
    bulkIn: () => {
      const reply = bulkInQueue.shift()
      if (reply === undefined) return Promise.reject(new Error('no bulk reply queued'))
      if (reply instanceof Error) return Promise.reject(reply)
      return Promise.resolve(reply)
    },
    close: () => Promise.resolve(),
    onDisconnect: () => {}
  } satisfies UsbTransport

  return { transport, controlsOut, controlsIn, bulkSent, controlInQueue, bulkInQueue }
}

function createDevice() {
  const fake = createFakeTransport()
  const device = new Device(fake.transport, { timeout: 100 })
  return { device, ...fake }
}

describe('identify', () => {
  test('parses the 8-byte response', async () => {
    const { device, controlsIn, controlInQueue } = createDevice()
    controlInQueue.push(new Uint8Array([0, 9, 0, 16, 0, 0, 0, 0]))

    const info = await device.identify()

    expect(controlsIn).toEqual([{ request: Request.IDENTIFY_HOST, value: 0, index: 0, length: 8 }])
    expect(info.stageName).toBe('TPL')
  })
})

describe('run', () => {
  test('splits the address and sets the keep-power flag by default', async () => {
    const { device, controlsOut } = createDevice()

    await device.run(0xd9000010)

    const call = controlsOut[0]!
    expect(call.request).toBe(Request.RUN_IN_ADDR)
    expect(call.value).toBe(0xd900)
    expect(call.index).toBe(0x0010)
    expect([...call.data!]).toEqual([0x10 | 0x10, 0x00, 0x00, 0xd9])
  })

  test('omits the keep-power flag when disabled', async () => {
    const { device, controlsOut } = createDevice()

    await device.run(0xd9000000, false)

    expect([...controlsOut[0]!.data!]).toEqual([0x00, 0x00, 0x00, 0xd9])
  })
})

describe('memory read/write', () => {
  test('writeSimpleMemory rejects more than 64 bytes', async () => {
    const { device } = createDevice()
    await expect(device.writeSimpleMemory(0, new Uint8Array(65))).rejects.toThrow(AmlUsbError)
  })

  test('writeMemory chunks into 64-byte control transfers', async () => {
    const { device, controlsOut } = createDevice()
    const data = new Uint8Array(130).map((_, i) => i % 256)

    await device.writeMemory(0xd9000000, data)

    expect(controlsOut).toHaveLength(3)
    expect(controlsOut.map((c) => c.data!.length)).toEqual([64, 64, 2])
    expect(controlsOut.map((c) => ({ value: c.value, index: c.index }))).toEqual([
      { value: 0xd900, index: 0x0000 },
      { value: 0xd900, index: 0x0040 },
      { value: 0xd900, index: 0x0080 }
    ])
    expect(controlsOut[2]!.data![0]).toBe(128)
  })

  test('readMemory reassembles chunked reads (pyamlboot regression)', async () => {
    const { device, controlsIn, controlInQueue } = createDevice()
    controlInQueue.push(
      new Uint8Array(64).fill(1),
      new Uint8Array(64).fill(2),
      new Uint8Array([3, 3])
    )

    const data = await device.readMemory(0x1000, 130)

    expect(data).toHaveLength(130)
    expect(data[0]).toBe(1)
    expect(data[64]).toBe(2)
    expect(data[128]).toBe(3)
    expect(controlsIn.map((c) => c.length)).toEqual([64, 64, 2])
    expect(controlsIn.map((c) => c.index)).toEqual([0x1000, 0x1040, 0x1080])
  })

  test('readReg decodes little-endian', async () => {
    const { device, controlInQueue } = createDevice()
    controlInQueue.push(new Uint8Array([0x78, 0x56, 0x34, 0x12]))

    await expect(device.readReg(0xc8100000)).resolves.toBe(0x12345678)
  })

  test('writeReg packs a MODIFY_MEM opcode-0 payload', async () => {
    const { device, controlsOut } = createDevice()

    await device.writeReg(0xc110419c, 0xb1)

    const call = controlsOut[0]!
    expect(call.request).toBe(Request.MODIFY_MEM)
    expect(call.value).toBe(0)
    const view = new DataView(call.data!.buffer)
    expect(view.getUint32(0, true)).toBe(0xc110419c)
    expect(view.getUint32(4, true)).toBe(0xb1)
  })
})

describe('writeLargeMemory', () => {
  test('sends the setup transfer then one bulk write per block', async () => {
    const { device, controlsOut, bulkSent } = createDevice()
    const data = new Uint8Array(128).map((_, i) => i)

    await device.writeLargeMemory(0x200c000, data, { blockLength: 64 })

    expect(controlsOut).toHaveLength(1)
    const call = controlsOut[0]!
    expect(call.request).toBe(Request.WR_LARGE_MEM)
    expect(call.value).toBe(64) // blockLength
    expect(call.index).toBe(2) // blockCount
    const view = new DataView(call.data!.buffer)
    expect(view.getUint32(0, true)).toBe(0x200c000)
    expect(view.getUint32(4, true)).toBe(128)

    expect(bulkSent).toHaveLength(2)
    expect(bulkSent[0]).toEqual(data.slice(0, 64))
    expect(bulkSent[1]).toEqual(data.slice(64))
  })

  test('rejects unaligned data without appendZeros', async () => {
    const { device } = createDevice()
    await expect(device.writeLargeMemory(0, new Uint8Array(100))).rejects.toThrow(
      'multiple of the block length'
    )
  })

  test('appendZeros pads the final block to a full multiple (pyamlboot fix)', async () => {
    const { device, controlsOut, bulkSent } = createDevice()
    const data = new Uint8Array(100).fill(0xaa)

    await device.writeLargeMemory(0, data, { blockLength: 64, appendZeros: true })

    expect(controlsOut[0]!.index).toBe(2) // blockCount includes the padded block
    expect(new DataView(controlsOut[0]!.data!.buffer).getUint32(4, true)).toBe(128)
    expect(bulkSent[1]).toHaveLength(64)
    expect([...bulkSent[1]!.slice(36)]).toEqual(new Array(28).fill(0))
  })

  test('splits transfers above 65535 blocks', async () => {
    const { device, controlsOut } = createDevice()
    const total = 65535 + 10
    const data = new Uint8Array(total)

    await device.writeLargeMemory(0x1000, data, { blockLength: 1 })

    expect(controlsOut).toHaveLength(2)
    expect(controlsOut[0]!.index).toBe(65535)
    expect(controlsOut[1]!.index).toBe(10)
    expect(new DataView(controlsOut[1]!.data!.buffer).getUint32(0, true)).toBe(0x1000 + 65535)
  })

  test('reports progress and accepts a Blob', async () => {
    const { device } = createDevice()
    const progress: number[] = []

    await device.writeLargeMemory(0, new Blob([new Uint8Array(128)]), {
      blockLength: 64,
      onProgress: (p) => progress.push(p.bytesTransferred)
    })

    expect(progress).toEqual([128])
  })
})

describe('readLargeMemory', () => {
  test('reads one bulk block at a time after the setup transfer', async () => {
    const { device, controlsOut, bulkInQueue } = createDevice()
    bulkInQueue.push(new Uint8Array(64).fill(1), new Uint8Array(64).fill(2))

    const data = await device.readLargeMemory(0xd9040004, 128, { blockLength: 64 })

    expect(controlsOut[0]!.request).toBe(Request.RD_LARGE_MEM)
    expect(controlsOut[0]!.value).toBe(64)
    expect(controlsOut[0]!.index).toBe(2)
    expect(data).toHaveLength(128)
    expect(data[127]).toBe(2)
  })

  test('rejects unaligned lengths', async () => {
    const { device } = createDevice()
    await expect(device.readLargeMemory(0, 100)).rejects.toThrow('multiple of the block length')
  })

  test('throws on a short bulk-in packet instead of truncating', async () => {
    const { device, bulkInQueue } = createDevice()
    bulkInQueue.push(new Uint8Array(32))

    await expect(device.readLargeMemory(0, 64, { blockLength: 64 })).rejects.toThrow(
      /short bulk read/
    )
  })
})

describe('bulk commands', () => {
  test('bulkCmd sends a NUL-terminated command and reads status', async () => {
    const { device, controlsOut, bulkInQueue } = createDevice()
    bulkInQueue.push(ascii('success', 512))

    const reply = await device.bulkCmd('printenv')

    const call = controlsOut[0]!
    expect(call.request).toBe(Request.BULKCMD)
    expect(call.value).toBe(0)
    expect(call.index).toBe(2)
    expect([...call.data!].slice(-1)).toEqual([0])
    expect(reply).toHaveLength(512)
  })

  test('checkBulkCmd resolves on success', async () => {
    const { device, bulkInQueue } = createDevice()
    bulkInQueue.push(ascii('success', 512))

    await expect(device.checkBulkCmd('low_power')).resolves.toBe('success')
  })

  test('checkBulkCmd polls through Continue:34 busy replies', async () => {
    const { device, bulkInQueue } = createDevice()
    bulkInQueue.push(ascii('Continue:34', 512), ascii('Continue:34', 512), ascii('success', 512))

    await expect(device.checkBulkCmd('disk_initial 0', { busyRetryDelay: 0 })).resolves.toBe(
      'success'
    )
    expect(bulkInQueue).toHaveLength(0)
  })

  test('checkBulkCmd allows one more poll after a busy pause as long as the timeout', async () => {
    const { device, bulkInQueue } = createDevice()
    bulkInQueue.push(ascii('Continue:34', 512), ascii('success', 512))

    // the busy pause alone exhausts the deadline; the retry must still happen
    await expect(
      device.checkBulkCmd('save_setting', { timeout: 30, busyRetryDelay: 40 })
    ).resolves.toBe('success')
  })

  test('checkBulkCmd throws BulkCmdError on an unexpected response', async () => {
    const { device, bulkInQueue } = createDevice()
    bulkInQueue.push(ascii('failed:no space', 512))

    await expect(device.checkBulkCmd('download get_status')).rejects.toThrow(BulkCmdError)
  })

  test('bulkCmd rejects over-long commands', async () => {
    const { device } = createDevice()
    await expect(device.bulkCmd('x'.repeat(127))).rejects.toThrow(AmlUsbError)
  })
})

describe('TPL commands', () => {
  test('checkTplCommand verifies the status response', async () => {
    const { device, controlsOut, controlInQueue } = createDevice()
    controlInQueue.push(ascii('success', 0x40))

    await device.checkTplCommand('    echo 1234')

    expect(controlsOut[0]!.request).toBe(Request.TPL_CMD)
    expect(controlsOut[0]!.index).toBe(1) // subcode
  })

  test('checkTplCommand throws TplCmdError on failure', async () => {
    const { device, controlInQueue } = createDevice()
    controlInQueue.push(ascii('failed', 0x40))

    await expect(device.checkTplCommand('echo 1234')).rejects.toThrow(TplCmdError)
  })
})

describe('media writes', () => {
  test('writeMedia sends the 32-byte header then the data', async () => {
    const { device, controlsOut, bulkSent } = createDevice()
    const data = new Uint8Array(256).map((_, i) => i)

    await device.writeMedia(data, { seq: 5, retryTimes: 1 })

    const call = controlsOut[0]!
    expect(call.request).toBe(Request.WRITE_MEDIA)
    expect(call.value).toBe(1)
    expect(call.index).toBe(0xffff)
    expect(call.data).toHaveLength(32)
    const view = new DataView(call.data!.buffer)
    expect(view.getUint32(0, true)).toBe(1) // retryTimes
    expect(view.getUint32(4, true)).toBe(256) // length
    expect(view.getUint32(8, true)).toBe(5) // seq
    expect(view.getUint32(12, true)).toBe(amlsChecksum(data))
    expect(bulkSent[0]).toEqual(data)
  })

  test('writeMediaStream chunks into 64 KiB blocks with incrementing seq', async () => {
    const { device, controlsOut, bulkSent, bulkInQueue } = createDevice()
    const total = 0x10000 + 100
    const source = new Uint8Array(total).fill(0x42)
    bulkInQueue.push(ascii('OK!!', 0x200), ascii('OK!!', 0x200))
    const progress: number[] = []

    await device.writeMediaStream(source, { onProgress: (p) => progress.push(p.bytesTransferred) })

    expect(controlsOut).toHaveLength(2)
    expect(new DataView(controlsOut[0]!.data!.buffer).getUint32(8, true)).toBe(0)
    expect(new DataView(controlsOut[1]!.data!.buffer).getUint32(8, true)).toBe(1)
    expect(bulkSent.map((b) => b.length)).toEqual([0x10000, 100])
    expect(progress).toEqual([0x10000, total])
  })

  test('writeMediaStream retries a block through Continue:32', async () => {
    const { device, bulkInQueue } = createDevice()
    bulkInQueue.push(ascii('Continue:32', 0x200), ascii('OK!!', 0x200))

    await expect(
      device.writeMediaStream(new Uint8Array(64), { busyRetryDelay: 0 })
    ).resolves.toBeUndefined()
  })

  test('writeMediaStream resends a block on a bad ack, then fails', async () => {
    const { device, controlsOut, bulkInQueue } = createDevice()
    bulkInQueue.push(ascii('ERR!', 0x200), ascii('ERR!', 0x200))

    await expect(
      device.writeMediaStream(new Uint8Array(64), { resendTimes: 1, resendDelay: 0 })
    ).rejects.toThrow(MediaWriteError)

    // the resent attempt carries retryTimes=1 in its header
    expect(new DataView(controlsOut[1]!.data!.buffer).getUint32(0, true)).toBe(1)
  })

  test('readMedia issues the setup control read then bulk-reads the payload', async () => {
    const { device, controlsIn, controlInQueue, bulkInQueue } = createDevice()
    controlInQueue.push(new Uint8Array(16))
    bulkInQueue.push(new Uint8Array([1, 2, 3, 4]))

    const data = await device.readMedia(4)

    expect(controlsIn[0]).toEqual({ request: Request.READ_MEDIA, value: 4, index: 1, length: 16 })
    expect([...data]).toEqual([1, 2, 3, 4])
  })

  test('readMedia rejects sizes that do not fit the 16-bit wValue', async () => {
    const { device } = createDevice()
    await expect(device.readMedia(0x10000)).rejects.toThrow(AmlUsbError)
  })
})

function amlcRequest(length: number, offset: number): Uint8Array<ArrayBuffer> {
  const block = ascii('AMLC', 512)
  const view = new DataView(block.buffer)
  view.setUint32(8, length, true)
  view.setUint32(12, offset, true)
  return block
}

describe('AMLC', () => {
  test('getBootAMLC parses the request and acks with OKAY', async () => {
    const { device, controlsOut, bulkSent, bulkInQueue } = createDevice()
    bulkInQueue.push(amlcRequest(0x10000, 0x200))

    const request = await device.getBootAMLC()

    expect(controlsOut[0]!.request).toBe(Request.GET_AMLC)
    expect(controlsOut[0]!.value).toBe(0x200)
    expect(request).toEqual({ length: 0x10000, offset: 0x200 })
    expect(bulkSent).toHaveLength(1)
    expect([...bulkSent[0]!.slice(0, 4)]).toEqual([...'OKAY'].map((c) => c.charCodeAt(0)))
  })

  test('getBootAMLC rejects an invalid tag', async () => {
    const { device, bulkInQueue } = createDevice()
    bulkInQueue.push(ascii('JUNK', 512))

    await expect(device.getBootAMLC()).rejects.toThrow(AmlcError)
  })

  test('writeAMLCData writes chunks then the AMLS trailer', async () => {
    const { device, controlsOut, bulkSent, bulkInQueue } = createDevice()
    const data = new Uint8Array(300).map((_, i) => i % 251)
    bulkInQueue.push(ascii('OKAY', 16), ascii('OKAY', 16))

    await device.writeAMLCData(3, 0x8000, data)

    // data chunk: offset 0, writeLength-1 in wIndex
    expect(controlsOut[0]!.request).toBe(Request.WRITE_AMLC)
    expect(controlsOut[0]!.value).toBe(0)
    expect(controlsOut[0]!.index).toBe(299)
    expect(bulkSent[0]).toEqual(data)

    // AMLS trailer at the AMLC offset: 16-byte header + data[16..512]
    expect(controlsOut[1]!.value).toBe(0x8000 / 0x200)
    const amls = bulkSent[1]!
    expect(controlsOut[1]!.index).toBe(amls.length - 1)
    expect(amls).toHaveLength(16 + 284)
    expect([...amls.slice(0, 4)]).toEqual([...'AMLS'].map((c) => c.charCodeAt(0)))
    expect(amls[4]).toBe(3) // seq
    expect(new DataView(amls.buffer).getUint32(8, true)).toBe(amlsChecksum(data))
    expect([...amls.slice(16)]).toEqual([...data.slice(16, 512)])
  })

  test('writeAMLCData throws on a bad ack', async () => {
    const { device, bulkInQueue } = createDevice()
    bulkInQueue.push(ascii('FAIL', 16))

    await expect(device.writeAMLCData(0, 0, new Uint8Array(32))).rejects.toThrow(AmlcError)
  })

  test('bootAMLC serves requests until BL2 repeats itself', async () => {
    const { device, bulkSent, bulkInQueue } = createDevice()
    const image = new Uint8Array(0x400).map((_, i) => i % 256)

    bulkInQueue.push(
      amlcRequest(0x200, 0), // first request
      ascii('OKAY', 16), // data chunk ack
      ascii('OKAY', 16), // AMLS ack
      amlcRequest(0x200, 0x200), // second request
      ascii('OKAY', 16),
      ascii('OKAY', 16),
      amlcRequest(0x200, 0x200) // repeated -> BL2 done
    )

    const progress: number[] = []
    await device.bootAMLC(image, { onProgress: (p) => progress.push(p.bytesTransferred) })

    // 3 OKAY request-acks + (data chunk + AMLS) x2
    expect(bulkSent).toHaveLength(7)
    expect(progress).toEqual([0x200, 0x400])
    expect(bulkSent[1]).toEqual(image.slice(0, 0x200))
  })

  test('bootAMLC throws when the image runs out', async () => {
    const { device, bulkInQueue } = createDevice()
    bulkInQueue.push(amlcRequest(0x200, 0x10000)) // beyond the 64-byte image

    await expect(device.bootAMLC(new Uint8Array(64))).rejects.toThrow('unexpected end of image')
  })
})

describe('misc primitives', () => {
  test('nop issues a data-less control transfer', async () => {
    const { device, controlsOut } = createDevice()

    await device.nop()

    expect(controlsOut).toEqual([{ request: Request.NOP, value: 0, index: 0 }])
  })

  test('sendPassword accepts a string', async () => {
    const { device, controlsOut } = createDevice()

    await device.sendPassword('secret')

    expect(controlsOut[0]!.request).toBe(Request.PASSWORD)
    expect([...controlsOut[0]!.data!]).toEqual([...'secret'].map((c) => c.charCodeAt(0)))
  })

  test('wraps a raw USBDevice in a WebUsbTransport', () => {
    const usbDevice = { controlTransferIn: () => {} } as unknown as USBDevice
    const device = new Device(usbDevice)
    expect(device.usbDevice).toBe(usbDevice)
  })
})
