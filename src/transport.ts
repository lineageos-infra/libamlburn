import { timeoutPromise } from './utils/timeout'

const USB_CLASS_VENDOR_SPECIFIC = 0xff

/**
 * The USB surface the protocol driver runs on. The legacy Amlogic boot
 * protocol needs vendor control transfers in both directions plus a bulk
 * endpoint pair, so — unlike Odin — it cannot be carried over Web Serial.
 * The interface exists as the seam for fake transports in tests.
 */
export interface UsbTransport {
  connect(timeout: number): Promise<void>
  /** Vendor control OUT (bmRequestType 0x40). Resolves the number of bytes written. */
  controlOut(
    request: number,
    value: number,
    index: number,
    data: Uint8Array<ArrayBuffer> | undefined,
    timeout: number
  ): Promise<number>
  /** Vendor control IN (bmRequestType 0xc0). Reads up to `length` bytes. */
  controlIn(
    request: number,
    value: number,
    index: number,
    length: number,
    timeout: number
  ): Promise<Uint8Array<ArrayBuffer>>
  bulkOut(data: Uint8Array<ArrayBuffer>, timeout: number): Promise<void>
  /** Read up to `length` bytes from the bulk IN endpoint. */
  bulkIn(length: number, timeout: number): Promise<Uint8Array<ArrayBuffer>>
  close(timeout: number): Promise<void>
  onDisconnect(callback: () => void): void
}

/** Drives an Amlogic boot-mode device over the WebUSB API. */
export class WebUsbTransport implements UsbTransport {
  readonly device: USBDevice

  outEndpointNum = -1
  inEndpointNum = -1

  constructor(device: USBDevice) {
    this.device = device
  }

  async connect(timeout: number) {
    await timeoutPromise(this.device.open(), '[connect] unable to open device handle', timeout)

    if (!this.device.configuration) {
      await timeoutPromise(
        this.device.selectConfiguration(1),
        '[connect] unable to select device configuration',
        timeout
      )
    }

    if (!this.device.configuration) {
      throw new Error('Unable to select the proper configuration')
    }

    let interfaceNum = -1
    let altInterfaceNum = -1

    for (const usbInterface of this.device.configuration.interfaces) {
      for (const altInterface of usbInterface.alternates) {
        const outEndpoint =
          altInterface.endpoints.find((endpoint) => endpoint.direction === 'out')?.endpointNumber ??
          -1
        const inEndpoint =
          altInterface.endpoints.find((endpoint) => endpoint.direction === 'in')?.endpointNumber ??
          -1

        if (
          altInterface.interfaceClass === USB_CLASS_VENDOR_SPECIFIC &&
          outEndpoint !== -1 &&
          inEndpoint !== -1
        ) {
          altInterfaceNum = altInterface.alternateSetting
          this.outEndpointNum = outEndpoint
          this.inEndpointNum = inEndpoint
          break
        }
      }

      if (altInterfaceNum !== -1) {
        interfaceNum = usbInterface.interfaceNumber
        break
      }
    }

    if (this.outEndpointNum === -1 || this.inEndpointNum === -1) {
      throw new Error('Unable to locate the bulk endpoints')
    }

    await timeoutPromise(
      this.device.claimInterface(interfaceNum),
      '[connect] unable to claim device interface',
      timeout
    )

    if (altInterfaceNum !== 0) {
      await timeoutPromise(
        this.device.selectAlternateInterface(interfaceNum, altInterfaceNum),
        "[connect] unable to select the device's boot interface",
        timeout
      )
    }
  }

  async controlOut(
    request: number,
    value: number,
    index: number,
    data: Uint8Array<ArrayBuffer> | undefined,
    timeout: number
  ) {
    const result = await timeoutPromise(
      this.device.controlTransferOut(
        { requestType: 'vendor', recipient: 'device', request, value, index },
        data
      ),
      '[device] unable to send control transfer',
      timeout
    )
    if (result.status !== 'ok') {
      throw new Error(`control transfer status ${result.status}`)
    }
    return result.bytesWritten
  }

  async controlIn(request: number, value: number, index: number, length: number, timeout: number) {
    const result = await timeoutPromise(
      this.device.controlTransferIn(
        { requestType: 'vendor', recipient: 'device', request, value, index },
        length
      ),
      '[device] unable to receive control transfer',
      timeout
    )
    return toBytes(result)
  }

  async bulkOut(data: Uint8Array<ArrayBuffer>, timeout: number) {
    const result = await timeoutPromise(
      this.device.transferOut(this.outEndpointNum, data),
      '[device] unable to send bulk data',
      timeout
    )
    if (result.status !== 'ok') {
      throw new Error(`transmit status ${result.status}`)
    }
  }

  async bulkIn(length: number, timeout: number) {
    const result = await timeoutPromise(
      this.device.transferIn(this.inEndpointNum, length),
      '[device] unable to receive bulk data',
      timeout
    )
    return toBytes(result)
  }

  async close(timeout: number) {
    await timeoutPromise(this.device.close(), '[close] unable to close device', timeout)
  }

  onDisconnect(callback: () => void) {
    listenForDisconnect(
      navigator.usb,
      (event) => (event as USBConnectionEvent).device === this.device,
      callback
    )
  }
}

/**
 * Register a one-shot `disconnect` listener that fires `callback` only for the
 * matching device, then removes itself.
 */
function listenForDisconnect(
  target: EventTarget,
  matches: (event: Event) => boolean,
  callback: () => void
): void {
  const handler = (event: Event) => {
    if (matches(event)) {
      callback()
      target.removeEventListener('disconnect', handler)
    }
  }
  target.addEventListener('disconnect', handler)
}

function toBytes(result: USBInTransferResult): Uint8Array<ArrayBuffer> {
  if (result.data === undefined || result.status !== 'ok') {
    throw new Error(`receive failed with status ${result.status}`)
  }
  const view = result.data
  const bytes = new Uint8Array(view.byteLength)
  bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
  return bytes
}
