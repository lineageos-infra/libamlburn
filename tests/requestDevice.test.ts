import { afterEach, describe, expect, test, vi } from 'vitest'
import { AdnlDevice } from '../src/adnl'
import { DeviceFilters } from '../src/constants'
import { AmlUsbError } from '../src/errors'
import { OptimusDevice } from '../src/optimus'
import { requestDevice } from '../src/requestDevice'

function stubPicker(productId: number) {
  const usbDevice = { vendorId: 0x1b8e, productId, controlTransferIn: () => {} }
  const picker = vi.fn().mockResolvedValue(usbDevice)
  vi.stubGlobal('navigator', { usb: { requestDevice: picker } })
  return { picker, usbDevice }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('requestDevice', () => {
  test('throws when WebUSB is unavailable', async () => {
    vi.stubGlobal('navigator', {})
    await expect(requestDevice()).rejects.toThrow(AmlUsbError)
  })

  test('offers both burn-mode product ids', async () => {
    const { picker } = stubPicker(0xc003)
    await requestDevice()
    expect(picker).toHaveBeenCalledWith({ filters: DeviceFilters })
    expect(DeviceFilters.map((f) => f.productId)).toEqual([0xc003, 0xc004])
  })

  test('wraps an Optimus device', async () => {
    const { usbDevice } = stubPicker(0xc003)
    const device = await requestDevice({ timeout: 123 })
    expect(device).toBeInstanceOf(OptimusDevice)
    expect(device.usbDevice).toBe(usbDevice)
    expect(device.deviceOptions.timeout).toBe(123)
  })

  test('wraps an ADNL device', async () => {
    stubPicker(0xc004)
    const device = await requestDevice()
    expect(device).toBeInstanceOf(AdnlDevice)
    expect(device.protocol).toBe('adnl')
  })
})
