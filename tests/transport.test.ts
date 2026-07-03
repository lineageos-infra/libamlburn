import { describe, expect, test, vi } from 'vitest'
import { WebUsbTransport } from '../src/transport'

const USB_CLASS_VENDOR_SPECIFIC = 0xff

function makeDataView(bytes: number[]) {
  return new DataView(new Uint8Array(bytes).buffer)
}

function createFakeUsbDevice(configuration?: unknown) {
  return {
    open: vi.fn().mockResolvedValue(undefined),
    selectConfiguration: vi.fn().mockResolvedValue(undefined),
    claimInterface: vi.fn().mockResolvedValue(undefined),
    selectAlternateInterface: vi.fn().mockResolvedValue(undefined),
    controlTransferOut: vi.fn().mockResolvedValue({ status: 'ok', bytesWritten: 0 }),
    controlTransferIn: vi.fn(),
    transferOut: vi.fn().mockResolvedValue({ status: 'ok' }),
    transferIn: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    configuration
  }
}

/** A configuration whose sole interface is the Amlogic vendor-specific bulk pair. */
function vendorConfig(interfaceNumber: number, alternateSetting: number) {
  return {
    interfaces: [
      {
        interfaceNumber,
        alternates: [
          {
            alternateSetting,
            interfaceClass: USB_CLASS_VENDOR_SPECIFIC,
            endpoints: [
              { direction: 'in', endpointNumber: 1 },
              { direction: 'out', endpointNumber: 2 }
            ]
          }
        ]
      }
    ]
  }
}

describe('WebUsbTransport.connect', () => {
  test('selects the vendor interface by descriptor number', async () => {
    const device = createFakeUsbDevice(vendorConfig(2, 1))
    const transport = new WebUsbTransport(device as unknown as USBDevice)

    await transport.connect(1000)

    expect(device.claimInterface).toHaveBeenCalledWith(2)
    expect(device.selectAlternateInterface).toHaveBeenCalledWith(2, 1)
    expect(transport.inEndpointNum).toBe(1)
    expect(transport.outEndpointNum).toBe(2)
  })

  test('skips selectAlternateInterface when the alternate setting is 0', async () => {
    const device = createFakeUsbDevice(vendorConfig(0, 0))
    const transport = new WebUsbTransport(device as unknown as USBDevice)

    await transport.connect(1000)

    expect(device.claimInterface).toHaveBeenCalledWith(0)
    expect(device.selectAlternateInterface).not.toHaveBeenCalled()
  })

  test('selects configuration 1 when none is active', async () => {
    const device = createFakeUsbDevice(undefined)
    device.selectConfiguration.mockImplementation(() => {
      device.configuration = vendorConfig(0, 0)
      return Promise.resolve()
    })
    const transport = new WebUsbTransport(device as unknown as USBDevice)

    await transport.connect(1000)

    expect(device.selectConfiguration).toHaveBeenCalledWith(1)
  })

  test('throws when no configuration can be selected', async () => {
    const device = createFakeUsbDevice(undefined)
    const transport = new WebUsbTransport(device as unknown as USBDevice)

    await expect(transport.connect(1000)).rejects.toThrow(
      'Unable to select the proper configuration'
    )
  })

  test('throws when no vendor-class bulk endpoints are found', async () => {
    const device = createFakeUsbDevice({
      interfaces: [
        {
          interfaceNumber: 0,
          alternates: [{ alternateSetting: 0, interfaceClass: 0x0a, endpoints: [] }]
        }
      ]
    })
    const transport = new WebUsbTransport(device as unknown as USBDevice)

    await expect(transport.connect(1000)).rejects.toThrow('Unable to locate the bulk endpoints')
  })
})

describe('WebUsbTransport.controlOut', () => {
  test('issues a vendor OUT control transfer', async () => {
    const device = createFakeUsbDevice()
    device.controlTransferOut.mockResolvedValueOnce({ status: 'ok', bytesWritten: 4 })
    const transport = new WebUsbTransport(device as unknown as USBDevice)

    const data = new Uint8Array([1, 2, 3, 4])
    await expect(transport.controlOut(0x34, 0, 2, data, 1000)).resolves.toBe(4)

    expect(device.controlTransferOut).toHaveBeenCalledWith(
      { requestType: 'vendor', recipient: 'device', request: 0x34, value: 0, index: 2 },
      data
    )
  })

  test('passes undefined data for zero-length requests', async () => {
    const device = createFakeUsbDevice()
    const transport = new WebUsbTransport(device as unknown as USBDevice)

    await transport.controlOut(0x36, 0, 0, undefined, 1000)

    expect(device.controlTransferOut).toHaveBeenCalledWith(
      { requestType: 'vendor', recipient: 'device', request: 0x36, value: 0, index: 0 },
      undefined
    )
  })

  test('throws on a non-ok status', async () => {
    const device = createFakeUsbDevice()
    device.controlTransferOut.mockResolvedValueOnce({ status: 'stall' })
    const transport = new WebUsbTransport(device as unknown as USBDevice)

    await expect(transport.controlOut(0x01, 0, 0, undefined, 1000)).rejects.toThrow(
      'control transfer status stall'
    )
  })
})

describe('WebUsbTransport.controlIn', () => {
  test('issues a vendor IN control transfer and converts the DataView', async () => {
    const device = createFakeUsbDevice()
    device.controlTransferIn.mockResolvedValueOnce({
      status: 'ok',
      data: makeDataView([0, 9, 0, 16])
    })
    const transport = new WebUsbTransport(device as unknown as USBDevice)

    expect([...(await transport.controlIn(0x20, 0, 0, 8, 1000))]).toEqual([0, 9, 0, 16])

    expect(device.controlTransferIn).toHaveBeenCalledWith(
      { requestType: 'vendor', recipient: 'device', request: 0x20, value: 0, index: 0 },
      8
    )
  })

  test('throws on a non-ok status', async () => {
    const device = createFakeUsbDevice()
    device.controlTransferIn.mockResolvedValueOnce({ status: 'stall', data: undefined })
    const transport = new WebUsbTransport(device as unknown as USBDevice)

    await expect(transport.controlIn(0x20, 0, 0, 8, 1000)).rejects.toThrow()
  })
})

describe('WebUsbTransport bulk transfers', () => {
  test('bulkOut writes to the out endpoint', async () => {
    const device = createFakeUsbDevice()
    const transport = new WebUsbTransport(device as unknown as USBDevice)
    transport.outEndpointNum = 2

    const data = new Uint8Array([9, 8, 7])
    await transport.bulkOut(data, 1000)

    expect(device.transferOut).toHaveBeenCalledWith(2, data)
  })

  test('bulkOut throws on a non-ok status', async () => {
    const device = createFakeUsbDevice()
    device.transferOut.mockResolvedValueOnce({ status: 'babble' })
    const transport = new WebUsbTransport(device as unknown as USBDevice)

    await expect(transport.bulkOut(new Uint8Array([1]), 1000)).rejects.toThrow(
      'transmit status babble'
    )
  })

  test('bulkIn reads from the in endpoint', async () => {
    const device = createFakeUsbDevice()
    device.transferIn.mockResolvedValueOnce({ status: 'ok', data: makeDataView([1, 2, 3, 4]) })
    const transport = new WebUsbTransport(device as unknown as USBDevice)
    transport.inEndpointNum = 1

    expect([...(await transport.bulkIn(4, 1000))]).toEqual([1, 2, 3, 4])
    expect(device.transferIn).toHaveBeenCalledWith(1, 4)
  })

  test('bulkIn throws on a non-ok status', async () => {
    const device = createFakeUsbDevice()
    device.transferIn.mockResolvedValueOnce({ status: 'stall', data: undefined })
    const transport = new WebUsbTransport(device as unknown as USBDevice)

    await expect(transport.bulkIn(4, 1000)).rejects.toThrow()
  })
})

describe('WebUsbTransport.onDisconnect', () => {
  test('fires the callback only when its own device disconnects', () => {
    const device = createFakeUsbDevice()
    let handler!: (event: { device: unknown }) => void
    const usb = {
      addEventListener: vi.fn((_type: string, listener: (event: { device: unknown }) => void) => {
        handler = listener
      }),
      removeEventListener: vi.fn()
    }
    vi.stubGlobal('navigator', { usb })

    const transport = new WebUsbTransport(device as unknown as USBDevice)
    const callback = vi.fn()
    transport.onDisconnect(callback)

    handler({ device: {} }) // a different device
    expect(callback).not.toHaveBeenCalled()

    handler({ device })
    expect(callback).toHaveBeenCalledTimes(1)
    expect(usb.removeEventListener).toHaveBeenCalled()
  })
})

describe('WebUsbTransport.close', () => {
  test('delegates to the device', async () => {
    const device = createFakeUsbDevice()
    const transport = new WebUsbTransport(device as unknown as USBDevice)

    await transport.close(1000)
    expect(device.close).toHaveBeenCalled()
  })
})
