import { DeviceFilters } from './constants'
import { Device, DeviceOptions } from './device'
import { AmlUsbError } from './errors'

/**
 * Prompt the user to pick an Amlogic device in USB boot mode.
 * Call {@link Device.initialize} on the result before using it.
 */
export async function requestDevice(options?: Partial<DeviceOptions>): Promise<Device> {
  if (typeof navigator === 'undefined' || !navigator.usb) {
    throw new AmlUsbError('WebUSB is not available in this browser')
  }

  const usbDevice = await navigator.usb.requestDevice({ filters: DeviceFilters })
  return new Device(usbDevice, options)
}
