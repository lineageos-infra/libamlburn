import { PRODUCT_GX_CHIP, VENDOR_AMLOGIC } from '../constants'
import { Device, DeviceOptions } from '../device'
import {
  AmlImageError,
  AmlUsbError,
  BulkCmdError,
  PasswordError,
  ReacquireNeededError
} from '../errors'
import { AmlImage, AmlImageItem } from '../image'
import { DeviceInfo } from '../info'
import { packUint32sLE, readUint32LE } from '../utils/bytes'
import { amlsChecksum } from '../utils/checksum'
import { delay } from '../utils/timeout'
import { parsePlatformConfig, Platform } from './platform'

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
  /** disk_initial can erase large eMMC devices */
  diskInitialTimeout: number
  /** per-partition sha1 verification runs on the device */
  verifyTimeout: number
  /** pause between polls of a Continue:3x busy reply */
  busyRetryDelay: number
  /** how long to wait for the device to re-enumerate */
  reacquireTimeout: number
}

const DEFAULT_TIMINGS: BurnTimings = {
  stepDelay: 200,
  passwordDelay: 2000,
  regDelay: 500,
  splRunDelay: 8000,
  ubootRunDelay: 5000,
  ubootSettleDelay: 200,
  diskInitialTimeout: 60_000,
  verifyTimeout: 150_000,
  busyRetryDelay: 3000,
  reacquireTimeout: 10_000
}

export type FlashOptions = {
  wipe?: WipeMode
  /** reboot after flashing rather than powering off on disconnect */
  reboot?: boolean
  /** unlock password for locked boards */
  password?: Uint8Array
  /** skip the old-bootloader erase step */
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

const PARA_MAGIC = 0x7856efab
/** SPL flows validated with this library; extend after testing a new platform */
const SUPPORTED_SPL_PLATFORMS = new Set([0x0811])

type BurnContext = {
  device: Device
  image: AmlImage
  platform: Platform
  secure: boolean
  timings: BurnTimings
  options: FlashOptions
}

function progress(ctx: BurnContext, update: BurnProgress) {
  ctx.options.onProgress?.(update)
}

function bootItem(ctx: BurnContext, part: 'DDR' | 'UBOOT'): AmlImageItem {
  const item = ctx.image.itemGet('USB', ctx.secure ? `${part}_ENC` : part)
  if (!item) {
    throw new AmlImageError(
      `the image does not contain any ${ctx.secure ? '' : 'non-'}signed ${part} item`
    )
  }
  return item
}

async function checkPassword(ctx: BurnContext) {
  const info = await ctx.device.identify()
  if (info.stageMinor !== DeviceInfo.STAGE_MINOR_IPL || !info.supportsPassword) return
  if (!info.needPassword || info.passwordOk) return

  progress(ctx, { stage: 'password' })
  if (!ctx.options.password) {
    throw new PasswordError('the board is locked with a password; provide options.password')
  }
  await ctx.device.sendPassword(ctx.options.password)
  await delay(ctx.timings.passwordDelay)
  if (!(await ctx.device.identify()).passwordOk) {
    throw new PasswordError('password check failed')
  }
}

/** @returns true when the device reset and must be reacquired */
async function eraseOldBootloader(ctx: BurnContext): Promise<boolean> {
  const info = await ctx.device.identify()
  if (info.stageMinor === DeviceInfo.STAGE_MINOR_IPL) return false
  if (info.stageMinor !== DeviceInfo.STAGE_MINOR_TPL) {
    throw new AmlUsbError(`invalid power state: ${info.toString()}`)
  }

  progress(ctx, { stage: 'erase-bootloader' })
  // the leading spaces guard against 4 command bytes lost after a reset
  await ctx.device.checkTplCommand('    echo 1234')
  await checkCmd(ctx, '    low_power')

  try {
    await checkCmd(ctx, 'bootloader_is_old')
  } catch (error) {
    if (error instanceof BulkCmdError) return false // bootloader is new
    throw error
  }

  await checkCmd(ctx, 'erase_bootloader')
  try {
    await checkCmd(ctx, 'reset')
  } catch (error) {
    // the device usually drops off the bus mid-reply, but an explicit
    // non-success reply means the reset was refused
    if (error instanceof BulkCmdError) throw error
    ctx.device._log('debug', 'reset reply not received', error)
  }
  await closeQuietly(ctx.device)
  return true
}

async function isSecureBoot(ctx: BurnContext): Promise<boolean> {
  const info = await ctx.device.identify()
  let encVal = 0

  if (info.stageMinor === DeviceInfo.STAGE_MINOR_IPL) {
    let reg = ctx.platform.encryptReg
    if (reg === 0xffffffff) {
      throw new AmlUsbError('invalid encrypt register')
    }
    if (!reg) {
      const data = await ctx.device.readLargeMemory(0xd9040004, 0x200)
      const chipId = readUint32LE(data)
      if (ctx.platform.encChipId1 === chipId) reg = ctx.platform.encryptReg1
      else if (ctx.platform.encChipId2 === chipId) reg = ctx.platform.encryptReg2
      if (!reg) {
        // reading register 0 would decide secure boot from garbage, silently
        // selecting the wrong (plain vs encrypted) boot images
        throw new AmlUsbError('cannot determine the encrypt register for this chip')
      }
    }
    encVal = await ctx.device.readReg(reg)
  } else if (info.stageMinor === DeviceInfo.STAGE_MINOR_TPL) {
    await checkCmd(ctx, `upload mem 0x${ctx.platform.encryptReg.toString(16)} normal 0x4`)
    encVal = readUint32LE(await ctx.device.readMedia(4))
  }

  return (encVal & 0x10) !== 0
}

async function runInAddress(ctx: BurnContext, address: number) {
  const info = await ctx.device.identify()
  const version = [info.major, info.minor, info.stageMajor, info.stageMinor]
  await ctx.device.run(address, versionAtLeast(version, [0, 9, 0, 0]))
}

function versionAtLeast(version: number[], minimum: number[]): boolean {
  for (let i = 0; i < minimum.length; i++) {
    if (version[i]! > minimum[i]!) return true
    if (version[i]! < minimum[i]!) return false
  }
  return true
}

/** Stock PLL setup values, as logged by the vendor USB Burning Tool */
const PLL_DEFAULTS = [
  { reg: 0xc110419c, val: 0xb1 },
  { reg: 0xc1104174, val: 0x5183 }
] as const

async function writePllRegs(ctx: BurnContext) {
  const { platform, device, timings } = ctx
  const configured = [
    { reg: platform.control0Reg, val: platform.control0Val },
    { reg: platform.control1Reg, val: platform.control1Val }
  ]
  for (const [i, fallback] of PLL_DEFAULTS.entries()) {
    // a zero/absent ControlN register means "unset": use the stock pair
    const { reg, val } = configured[i]!.reg ? configured[i]! : fallback
    await device.writeSimpleMemory(reg, packUint32sLE([val]))
    await delay(timings.regDelay)
  }
}

async function writePara(ctx: BurnContext, params: Uint8Array<ArrayBuffer>) {
  if (ctx.platform.bl2ParaAddr) {
    await ctx.device.writeLargeMemory(ctx.platform.bl2ParaAddr, params, {
      blockLength: params.length
    })
  }
}

async function checkPara(ctx: BurnContext) {
  if (!ctx.platform.bl2ParaAddr) return
  const data = await ctx.device.readLargeMemory(ctx.platform.bl2ParaAddr, 0x200, {
    blockLength: 0x200
  })
  const magic = readUint32LE(data)
  if (magic !== PARA_MAGIC) {
    throw new AmlUsbError(`failed to read back para block: 0x${magic.toString(16)}`)
  }
}

/** Stream an image item into memory in 4 KiB writeLargeMemory chunks */
async function downloadFile(ctx: BurnContext, item: AmlImageItem, address: number, size = 0) {
  const blockLength = 0x1000
  const total = !size || size > item.size ? item.size : size
  let written = 0

  while (written < total) {
    const buf = await item.read(written, Math.min(blockLength, total - written))
    if (buf.length === 0) break
    await ctx.device.writeLargeMemory(address + written, buf, { blockLength: buf.length })
    written += buf.length
  }

  if (written < total) {
    throw new AmlImageError(`short read streaming ${item.subType}: ${written} < ${total}`)
  }
}

async function downloadSPL(ctx: BurnContext) {
  const info = await ctx.device.identify()
  if (
    info.stageMinor === DeviceInfo.STAGE_MINOR_TPL ||
    info.stageMinor === DeviceInfo.STAGE_MINOR_SPL
  ) {
    return
  }
  if (info.stageMinor !== DeviceInfo.STAGE_MINOR_IPL) {
    throw new AmlUsbError(`unexpected stage: ${info.toString()}`)
  }

  if (!SUPPORTED_SPL_PLATFORMS.has(ctx.platform.platform)) {
    throw new AmlUsbError(`platform 0x${ctx.platform.platform.toString(16)} not supported`)
  }

  progress(ctx, { stage: 'spl' })
  await writePllRegs(ctx)
  await downloadFile(ctx, bootItem(ctx, 'DDR'), ctx.platform.ddrLoad, ctx.platform.ddrSize)
  await writePara(ctx, packUint32sLE([0x3412cdab, 0x200, 0xc0df, 0, 0, 0]))
  await runInAddress(ctx, ctx.platform.ddrRun)

  await delay(ctx.timings.splRunDelay)

  const after = await ctx.device.identify()
  if (after.stageMinor === DeviceInfo.STAGE_MINOR_IPL) {
    // DDR init ran and returned to the BootROM
  } else if (after.stageMajor === 1 && after.stageMinor === DeviceInfo.STAGE_MINOR_SPL) {
    // BL2 is up and serving AMLC
  } else if (after.stageMajor === 0 && after.stageMinor === DeviceInfo.STAGE_MINOR_SPL) {
    if (ctx.platform.bl2ParaAddr !== 0) {
      await runInAddress(ctx, ctx.platform.bl2ParaAddr)
    }
  } else {
    throw new AmlUsbError(`unexpected stage after SPL: ${after.toString()}`)
  }

  await checkPara(ctx)
}

async function runUboot(ctx: BurnContext) {
  const info = await ctx.device.identify()
  if (info.stageMinor === DeviceInfo.STAGE_MINOR_IPL) {
    await runInAddress(ctx, ctx.platform.ubootRun)
  } else if (info.stageMinor === DeviceInfo.STAGE_MINOR_SPL && info.stageMajor === 0) {
    await runInAddress(ctx, ctx.platform.bl2ParaAddr)
  }
}

/** Re-run DDR init with a U-Boot descriptor para block (non-AMLC boards) */
async function updateDdr(ctx: BurnContext, uboot: AmlImageItem, ddr: AmlImageItem | undefined) {
  const checksum = amlsChecksum(await uboot.read(0, uboot.size))
  const params = packUint32sLE(
    [0x3412cdab, 0x200, 0xc0e0, 0, 0, 1, ctx.platform.ubootLoad, uboot.size, checksum],
    100
  )
  await writePara(ctx, params)

  await runUboot(ctx)
  await delay(ctx.timings.ubootRunDelay)

  await checkPara(ctx)
  const info = await ctx.device.identify()
  if (info.stageMinor === DeviceInfo.STAGE_MINOR_IPL && ddr) {
    await downloadFile(ctx, ddr, ctx.platform.ddrLoad, ctx.platform.ddrSize)
  }
}

/** @returns true when the device reboots into U-Boot and must be reacquired */
async function downloadUboot(ctx: BurnContext): Promise<boolean> {
  const uboot = bootItem(ctx, 'UBOOT')
  const ddr = ctx.image.itemGet('USB', ctx.secure ? 'DDR_ENC' : 'DDR')

  let info = await ctx.device.identify()
  if (info.stageMinor === DeviceInfo.STAGE_MINOR_TPL) return false
  if (
    info.stageMinor !== DeviceInfo.STAGE_MINOR_IPL &&
    info.stageMinor !== DeviceInfo.STAGE_MINOR_SPL
  ) {
    throw new AmlUsbError(`unexpected stage before U-Boot: ${info.toString()}`)
  }

  progress(ctx, { stage: 'uboot' })
  if (info.stageMajor === 1 && info.stageMinor === DeviceInfo.STAGE_MINOR_SPL) {
    // G12A/G12B/SM1: BL2 pulls U-Boot over AMLC
    await ctx.device.bootAMLC(uboot.blob, {
      onProgress: (p) => progress(ctx, { stage: 'uboot', ...p })
    })
  } else {
    // AXG/GXL: push U-Boot with large-memory writes and para blocks
    await downloadFile(ctx, uboot, ctx.platform.ubootLoad)
    await delay(ctx.timings.ubootSettleDelay)

    info = await ctx.device.identify()
    if (info.stageMinor === DeviceInfo.STAGE_MINOR_IPL && ddr) {
      await downloadFile(ctx, ddr, ctx.platform.ddrLoad, ctx.platform.ddrSize)
    }

    if (ctx.platform.bl2ParaAddr) {
      await updateDdr(ctx, uboot, ddr)
      await writePara(
        ctx,
        packUint32sLE([0x3412cdab, 0x200, 0xc0e1, 0, 0, 0, 1, ctx.platform.ubootLoad, uboot.size])
      )
    }

    await runUboot(ctx)
  }

  await closeQuietly(ctx.device)
  return true
}

async function downloadPartition(ctx: BurnContext, item: AmlImageItem) {
  let part = item.subType
  const mediaType = item.mainType === 'dtb' ? 'mem' : 'store'
  let partName = part

  if (item.mainType === 'dtb') {
    partName = 'dtb'
    if (part === 'meson1' && ctx.secure) {
      const enc = ctx.image.itemGet('dtb', 'meson1_ENC')
      if (enc && enc.size !== 0) {
        part = 'meson1_ENC'
        item = enc
      }
    }
  }

  progress(ctx, { stage: 'partition', partition: part })
  await ctx.device.checkTplCommand(
    `download ${mediaType} ${partName} ${item.fileType} ${item.size}`
  )

  await ctx.device.writeMediaStream(item.blob, {
    busyRetryDelay: ctx.timings.busyRetryDelay,
    onProgress: (p) => progress(ctx, { stage: 'partition', partition: part, ...p })
  })

  await checkCmd(ctx, 'download get_status')

  if (item.verify) {
    const verifyItem = ctx.image.itemGet('VERIFY', part)
    if (verifyItem) {
      progress(ctx, { stage: 'verify', partition: part })
      const args = (await verifyItem.text()).trim()
      await checkCmd(ctx, `verify ${args}`, ctx.timings.verifyTimeout)
    }
  }
}

function checkCmd(ctx: BurnContext, command: string, timeout?: number) {
  return ctx.device.checkBulkCmd(command, {
    busyRetryDelay: ctx.timings.busyRetryDelay,
    ...(timeout !== undefined ? { timeout } : {})
  })
}

async function closeQuietly(device: Device) {
  try {
    await device.close()
  } catch {
    // the handle may already be gone after a device-side reset
  }
}

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
    const usbDevice = devices.find(
      (d) => d.vendorId === VENDOR_AMLOGIC && d.productId === PRODUCT_GX_CHIP
    )
    if (usbDevice) {
      seen = true
      const device = new Device(usbDevice, options)
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
 * Flash a full Amlogic upgrade package: the complete Optimus burn flow
 * (aml-flash-tool parity). The device re-enumerates mid-flow; pass
 * `options.reacquire` to control how it is reopened.
 * @returns the device handle that finished the flash (it may differ from the
 * one passed in)
 */
export async function flashImage(
  device: Device,
  image: AmlImage,
  options: FlashOptions = {}
): Promise<Device> {
  const timings = { ...DEFAULT_TIMINGS, ...options.timings }
  const platformItem = image.itemGet('conf', 'platform')
  if (!platformItem) {
    throw new AmlImageError('the image does not contain a platform config')
  }
  const platform = parsePlatformConfig(await platformItem.text())

  const ctx: BurnContext = { device, image, platform, secure: false, timings, options }
  const reacquire = async () => {
    ctx.device = await (
      options.reacquire ?? (() => reacquireDevice(timings.reacquireTimeout, device.deviceOptions))
    )()
    await delay(timings.stepDelay)
  }

  if (!options.noEraseBootloader) {
    await checkPassword(ctx)
    if (await eraseOldBootloader(ctx)) {
      await reacquire()
    }
  }
  await checkPassword(ctx)

  progress(ctx, { stage: 'secure-check' })
  ctx.secure = await isSecureBoot(ctx)

  await downloadSPL(ctx)
  if (await downloadUboot(ctx)) {
    await reacquire()
  }

  progress(ctx, { stage: 'disk-initial' })
  await checkCmd(ctx, '    low_power')
  await checkCmd(ctx, `disk_initial ${options.wipe ?? WipeMode.None}`, timings.diskInitialTimeout)

  for (const item of ctx.image.items()) {
    if (item.mainType !== 'PARTITION' && item.mainType !== 'dtb') continue
    if (item.mainType === 'dtb' && item.subType === 'meson1_ENC') continue
    await downloadPartition(ctx, item)
  }

  progress(ctx, { stage: 'finish' })
  await checkCmd(ctx, 'save_setting')
  try {
    await checkCmd(ctx, `burn_complete ${options.reboot ? 1 : 3}`)
  } catch (error) {
    // reboot (1) drops off the bus before replying, but poweroff-after-
    // disconnect (3) replies first: an explicit failure reply means refused
    if (error instanceof BulkCmdError) throw error
    ctx.device._log('debug', 'burn_complete reply not received', error)
  }

  return ctx.device
}
