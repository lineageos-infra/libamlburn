import { flashAdnlImage } from '../adnl/burn'
import { Device, DeviceOptions } from '../devices'
import { AmlUsbError, ReacquireNeededError } from '../errors'
import { AmlImage } from '../image'
import { flashOptimusImage } from '../optimus/burn'
import { createDevice, isBurnModeDevice } from '../requestDevice'
import { delay } from '../utils/timeout'
import { closeQuietly, DEFAULT_TIMINGS, FlashOptions } from './common'

export {
  WipeMode,
  type BurnProgress,
  type BurnStage,
  type BurnTimings,
  type FlashOptions
} from './common'

/**
 * Poll `navigator.usb.getDevices()` until the re-enumerated device answers
 * identify(). This only succeeds when the browser kept the WebUSB grant across
 * the re-enumeration — a policy grant, or a gadget with a serial number. The
 * WebUSB spec drops the grant of a serial-less device on disconnect, and
 * Amlogic burn-mode gadgets report no serial, so browser apps should expect
 * {@link ReacquireNeededError} and recover by prompting with requestDevice()
 * (which needs a user gesture).
 * @throws ReacquireNeededError when no granted candidate ever appeared (the
 * grant was dropped); a plain timeout error when one appeared but never
 * answered identify()
 */
export async function reacquireDevice(
  timeout = 10_000,
  options?: Partial<DeviceOptions>
): Promise<Device> {
  if (typeof navigator === 'undefined' || !navigator.usb) {
    throw new AmlUsbError('cannot reacquire the device: WebUSB is unavailable')
  }

  const start = Date.now()
  let seen = false
  while (Date.now() - start < timeout) {
    const devices = await navigator.usb.getDevices()
    const usbDevice = devices.find(isBurnModeDevice)
    if (usbDevice) {
      seen = true
      const device = createDevice(usbDevice, options)
      try {
        await device.initialize()
        await device.identify()
        return device
      } catch {
        await closeQuietly(device)
      }
    }
    await delay(200)
  }
  if (!seen) throw new ReacquireNeededError()
  throw new AmlUsbError('timed out waiting for the device to re-enumerate')
}

/**
 * Flash a full Amlogic upgrade package with the burn flow of the device's
 * protocol: Optimus (aml-flash-tool parity) or ADNL (pyamlboot adnl.py). The
 * device re-enumerates mid-flow; pass `options.reacquire` to control how it
 * is reopened.
 * @returns the device handle that finished the flash (it may differ from the
 * one passed in)
 */
export async function flashImage(
  device: Device,
  image: AmlImage,
  options: FlashOptions = {}
): Promise<Device> {
  const timings = { ...DEFAULT_TIMINGS, ...options.timings }
  const run = {
    image,
    options,
    timings,
    reacquire: async () => {
      const reacquired = await (
        options.reacquire ?? (() => reacquireDevice(timings.reacquireTimeout, device.deviceOptions))
      )()
      await delay(timings.stepDelay)
      return reacquired
    }
  }
  return device.protocol === 'adnl' ? flashAdnlImage(device, run) : flashOptimusImage(device, run)
}
