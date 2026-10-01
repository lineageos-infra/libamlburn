import { afterEach, describe, expect, test, vi } from 'vitest'
import { AmlUsbError, ReacquireNeededError } from '../src/errors'
import { reacquireDevice } from '../src/flash'

function fakeUsbDevice(options?: { identifies?: boolean; productId?: number }): USBDevice {
  const { identifies = true, productId = 0xc003 } = options ?? {}
  return {
    vendorId: 0x1b8e,
    productId,
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    claimInterface: vi.fn().mockResolvedValue(undefined),
    selectAlternateInterface: vi.fn().mockResolvedValue(undefined),
    configuration: {
      interfaces: [
        {
          interfaceNumber: 0,
          alternates: [
            {
              alternateSetting: 0,
              interfaceClass: 0xff,
              endpoints: [
                { direction: 'out', endpointNumber: 1 },
                { direction: 'in', endpointNumber: 2 }
              ]
            }
          ]
        }
      ]
    },
    controlTransferIn: identifies
      ? vi.fn().mockResolvedValue({
          status: 'ok',
          data: new DataView(new Uint8Array([0, 9, 0, 16, 0, 0, 0, 0]).buffer)
        })
      : vi.fn().mockRejectedValue(new Error('stall')),
    // ADNL identify: OKAY + protocol 5, stage U-Boot
    transferOut: vi.fn().mockResolvedValue({ status: 'ok', bytesWritten: 15 }),
    transferIn: vi.fn().mockResolvedValue({
      status: 'ok',
      data: new DataView(new Uint8Array([0x4f, 0x4b, 0x41, 0x59, 5, 0, 0, 16]).buffer)
    })
  } as unknown as USBDevice
}

function stubUsb(devices: USBDevice[]) {
  vi.stubGlobal('navigator', {
    usb: { getDevices: vi.fn().mockResolvedValue(devices) }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('reacquireDevice', () => {
  test('throws when WebUSB is unavailable', async () => {
    vi.stubGlobal('navigator', {})
    await expect(reacquireDevice(100)).rejects.toThrow(/WebUSB is unavailable/)
  })

  test('resolves once a granted device answers identify', async () => {
    stubUsb([fakeUsbDevice()])

    const device = await reacquireDevice(1000, { timeout: 100 })

    await expect(device.identify()).resolves.toBeDefined()
  })

  test('throws ReacquireNeededError when the grant was dropped (no candidate ever appears)', async () => {
    vi.useFakeTimers()
    stubUsb([])

    const assertion = expect(reacquireDevice(300)).rejects.toThrow(ReacquireNeededError)
    await vi.advanceTimersByTimeAsync(400)
    await assertion
  })

  test('reacquires an ADNL device as an AdnlDevice', async () => {
    stubUsb([fakeUsbDevice({ productId: 0xc004 })])

    const device = await reacquireDevice(1000, { timeout: 100 })

    expect(device.protocol).toBe('adnl')
  })

  test('non-burn-mode product ids do not count as candidates', async () => {
    vi.useFakeTimers()
    stubUsb([fakeUsbDevice({ productId: 0xc005 })])

    const assertion = expect(reacquireDevice(300)).rejects.toThrow(ReacquireNeededError)
    await vi.advanceTimersByTimeAsync(400)
    await assertion
  })

  test('an unresponsive candidate times out without ReacquireNeededError', async () => {
    vi.useFakeTimers()
    stubUsb([fakeUsbDevice({ identifies: false })])

    const result = reacquireDevice(300, { timeout: 50 })
    const assertion = expect(result).rejects.toThrow(AmlUsbError)
    await vi.advanceTimersByTimeAsync(400)

    await assertion
    await expect(result).rejects.not.toThrow(ReacquireNeededError)
    await expect(result).rejects.toThrow(/timed out waiting for the device to re-enumerate/)
  })
})
