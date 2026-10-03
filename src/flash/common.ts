import type { Device } from '../devices'
import { AmlImageError, AmlUsbError } from '../errors'
import { AmlImage, AmlImageItem } from '../image'

/** disk_initial argument: how much of the device to wipe before flashing */
export const WipeMode = {
  None: 0,
  KeepKeys: 1,
  ForceKeepKeys: 2,
  All: 3,
  ForceAll: 4
} as const
export type WipeMode = (typeof WipeMode)[keyof typeof WipeMode]

export type BurnStage =
  | 'password'
  | 'erase-bootloader'
  | 'secure-check'
  | 'spl'
  | 'uboot'
  | 'disk-initial'
  | 'partition'
  | 'verify'
  | 'finish'

export type BurnProgress = {
  stage: BurnStage
  partition?: string
  bytesTransferred?: number
  totalBytes?: number
}

/** Delays and timeouts of the burn flow; overridable so tests can zero them. */
export type BurnTimings = {
  /** pause between burn steps */
  stepDelay: number
  /** wait after sending the unlock password */
  passwordDelay: number
  /** pause between the two PLL register writes */
  regDelay: number
  /** wait for BL2 to come up after running the SPL */
  splRunDelay: number
  /** wait after handing control to U-Boot via the para block */
  ubootRunDelay: number
  /** settle time after streaming U-Boot before re-identifying */
  ubootSettleDelay: number
  /** ADNL: wait for BL2 after `boot`, and before re-asking a waiting CBW */
  bl2BootDelay: number
  /** ADNL protocol 6: wait for BL2E after BL2 has its U-Boot */
  bl2eDelay: number
  /** ADNL: settle time once U-Boot answers, before burning */
  tplSettleDelay: number
  /** disk_initial can erase large eMMC devices */
  diskInitialTimeout: number
  /** per-partition sha1 verification runs on the device */
  verifyTimeout: number
  /** pause between polls of a busy (Continue:3x / INFO) reply */
  busyRetryDelay: number
  /** how long to wait for the device to re-enumerate */
  reacquireTimeout: number
}

export const DEFAULT_TIMINGS: BurnTimings = {
  stepDelay: 200,
  passwordDelay: 2000,
  regDelay: 500,
  splRunDelay: 8000,
  ubootRunDelay: 5000,
  ubootSettleDelay: 200,
  bl2BootDelay: 500,
  bl2eDelay: 300,
  tplSettleDelay: 2000,
  diskInitialTimeout: 60_000,
  verifyTimeout: 150_000,
  busyRetryDelay: 3000,
  reacquireTimeout: 10_000
}

export type FlashOptions = {
  wipe?: WipeMode
  /** reboot after flashing rather than powering off on disconnect */
  reboot?: boolean
  /** unlock password for locked boards (Optimus only) */
  password?: Uint8Array
  /** skip the old-bootloader erase step (Optimus only) */
  noEraseBootloader?: boolean
  onProgress?: (progress: BurnProgress) => void
  /**
   * Reopen the device after it re-enumerates mid-flash. Effectively required
   * for browser apps: the default (reacquireDevice) polls
   * navigator.usb.getDevices(), but browsers drop the WebUSB grant of
   * serial-less devices on disconnect, so it throws ReacquireNeededError —
   * catch it and prompt the user with requestDevice() (needs a user gesture).
   */
  reacquire?: () => Promise<Device>
  timings?: Partial<BurnTimings>
}

/** What a protocol's burn flow gets from flashImage */
export type BurnRun = {
  image: AmlImage
  options: FlashOptions
  timings: BurnTimings
  /** reopen the re-enumerated device (already paced by stepDelay) */
  reacquire: () => Promise<Device>
}

export function bootItem(image: AmlImage, secure: boolean, part: 'DDR' | 'UBOOT'): AmlImageItem {
  const item = image.itemGet('USB', secure ? `${part}_ENC` : part)
  if (!item) {
    throw new AmlImageError(
      `the image does not contain any ${secure ? '' : 'non-'}signed ${part} item`
    )
  }
  return item
}

export async function closeQuietly(device: { close(): Promise<void> }) {
  try {
    await device.close()
  } catch {
    // the handle may already be gone after a device-side reset
  }
}

/** @throws AmlUsbError when the device speaks a different protocol than the flow expects */
export function expectProtocol<P extends Device['protocol']>(
  device: Device,
  protocol: P
): Extract<Device, { protocol: P }> {
  if (device.protocol !== protocol) {
    throw new AmlUsbError(`expected an ${protocol} device, got ${device.protocol}`)
  }
  return device as Extract<Device, { protocol: P }>
}
