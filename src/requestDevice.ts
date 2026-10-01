import { AdnlDevice } from './adnl/device'
import { DeviceFilters, PRODUCT_ADNL, PRODUCT_GX_CHIP, VENDOR_AMLOGIC } from './constants'
import { Device, DeviceOptions } from './devices'
import { AmlUsbError } from './errors'
import { OptimusDevice } from './optimus/device'

export function isBurnModeDevice(usbDevice: USBDevice): boolean {
  return (
    usbDevice.vendorId === VENDOR_AMLOGIC &&
    (usbDevice.productId === PRODUCT_GX_CHIP || usbDevice.productId === PRODUCT_ADNL)
  )
}

/** Wrap a WebUSB device in the driver for the protocol its product id speaks. */
export function createDevice(usbDevice: USBDevice, options?: Partial<DeviceOptions>): Device {
  return usbDevice.productId === PRODUCT_ADNL
    ? new AdnlDevice(usbDevice, options)
    : new OptimusDevice(usbDevice, options)
}

/**
 * Prompt the user to pick an Amlogic device in USB burn mode. The result is
 * an {@link OptimusDevice} or {@link AdnlDevice} depending on its product id;
 * narrow on `protocol` before protocol-specific calls.
 * Call `initialize()` on the result before using it.
 */
export async function requestDevice(options?: Partial<DeviceOptions>): Promise<Device> {
  if (typeof navigator === 'undefined' || !navigator.usb) {
    throw new AmlUsbError('WebUSB is not available in this browser')
  }

  const usbDevice = await navigator.usb.requestDevice({ filters: DeviceFilters })
  return createDevice(usbDevice, options)
}
