import { ADNL_BULK_SIZE, AdnlBurnSteps } from '../constants'
import { AdnlCmdError, AmlUsbError } from '../errors'
import {
  bootItem,
  BurnProgress,
  BurnRun,
  closeQuietly,
  expectProtocol,
  WipeMode
} from '../flash/common'
import { startsWithAscii, trimNulls } from '../headers'
import { AmlImage, AmlImageItem } from '../image'
import { prefetch } from '../utils/blob'
import { amlsChecksum } from '../utils/checksum'
import { delay } from '../utils/timeout'
import { AdnlDevice, AdnlStage, hasRomSecureBootMask, SocFamily } from './device'
import { Cbw, parseDataOut, parseDownloadSize } from './headers'

type AdnlContext = BurnRun & { device: AdnlDevice; family?: SocFamily }

function progress(ctx: AdnlContext, update: BurnProgress) {
  ctx.options.onProgress?.(update)
}

async function reacquire(ctx: AdnlContext) {
  await closeQuietly(ctx.device)
  ctx.device = expectProtocol(await ctx.reacquire(), 'adnl')
}

/** ROM/BL2 `setvar:burnsteps`; the vendor flow skips it past protocol 5 */
async function setBurnSteps(device: AdnlDevice, protocolType: number, step: number) {
  if (protocolType > 5) return
  await device.setBurnSteps(step)
}

/**
 * The image's signed or unsigned item. `secure` is undefined when the BootROM
 * can't tell, and the vendor flow then prefers the signed item if packaged.
 */
function usbBootItem(ctx: AdnlContext, secure: boolean | undefined, part: 'DDR' | 'UBOOT') {
  if (secure === undefined && ctx.image.itemGet('USB', `${part}_ENC`)) {
    return bootItem(ctx.image, true, part)
  }
  return bootItem(ctx.image, secure ?? false, part)
}

/** Load BL2 through the BootROM and boot it (vendor `romcode_flow`) */
async function runBootromStage(ctx: AdnlContext, protocolType: number, secure?: boolean) {
  const { device } = ctx
  progress(ctx, { stage: 'spl' })

  // the closed ROM may not need all of these, but the vendor tool sends them
  await device.command('getvar:serialno')
  for (const page of [1, 0, 1, 2, 3]) {
    await device.command(`getvar:getchipinfo-${page}`)
  }
  await setBurnSteps(device, protocolType, AdnlBurnSteps.ROM_0)
  await device.command('getvar:getchipinfo-1')
  await setBurnSteps(device, protocolType, AdnlBurnSteps.ROM_1)

  const downloadSize = parseDownloadSize(await device.command('getvar:downloadsize'))
  const ddr = usbBootItem(ctx, secure, 'DDR')
  // the vendor sends just the ROM's downloadsize (DDR items may hold the whole
  // bootloader); pyamlboot sends a shorter item whole under the same announcement
  const length = Math.min(ddr.size, downloadSize)
  await device.download(await ddr.read(0, length), downloadSize)
  progress(ctx, { stage: 'spl', bytesTransferred: length, totalBytes: length })

  await setBurnSteps(device, protocolType, AdnlBurnSteps.ROM_2)
  await device.command('boot')
}

/** Stream one CBW window in bulk-sized downloads, then its checksum if asked */
async function sendCbwWindow(ctx: AdnlContext, uboot: AmlImageItem, cbw: Cbw, attempts: number) {
  const { device } = ctx
  const data = await uboot.read(cbw.offset, cbw.size)
  for (let attempt = 1; ; attempt++) {
    let checksum = 0
    for (let offset = 0; offset < cbw.size; offset += ADNL_BULK_SIZE) {
      const announced = Math.min(ADNL_BULK_SIZE, cbw.size - offset)
      // like pyamlboot, a window past the image end announces its full size
      const chunk = data.subarray(offset, offset + announced)
      await device.download(chunk, announced)
      checksum = (checksum + amlsChecksum(chunk)) >>> 0
    }
    if (!cbw.needChecksum) return data.length
    try {
      await device.command('setvar:checksum', { expect: 'DATA' })
      await device.sendChecksum(checksum)
      return data.length
    } catch (error) {
      if (!(error instanceof AdnlCmdError) || attempt >= attempts) throw error
      device._log(
        'info',
        `checksum rejected for CBW ${cbw.seq}, resending (${attempt}/${attempts})`
      )
    }
  }
}

/** Serve BL2's (or BL2E's) CBW requests for U-Boot until it reports done (vendor `bl2_boot`) */
async function serveCbws(ctx: AdnlContext, uboot: AmlImageItem, protocolType: number) {
  const { device } = ctx
  const attempts = protocolType > 5 ? 3 : 1
  let transferred = 0
  for (;;) {
    let cbw = await device.getCbw()
    if (cbw.wait) {
      await delay(ctx.timings.bl2BootDelay)
      const { stage, stageName } = await device.identify()
      if (stage !== AdnlStage.SPL) {
        throw new AmlUsbError(`expected BL2 after a CBW wait, got ${stageName}`)
      }
      cbw = await device.getCbw()
      if (cbw.wait) throw new AmlUsbError('BL2 still asked to wait after waiting')
    }
    device._log('debug', `CBW seq=${cbw.seq} size=${cbw.size} offset=${cbw.offset}`)
    if (cbw.done) return

    const sent = await sendCbwWindow(ctx, uboot, cbw, attempts)
    transferred = Math.max(transferred, cbw.offset + sent)
    progress(ctx, { stage: 'uboot', bytesTransferred: transferred, totalBytes: uboot.size })
  }
}

/**
 * Hand U-Boot to BL2 (vendor `bl2_or_bl2e_flow`). Past protocol 5, BL2E
 * follows BL2 on the same connection and is served the same way.
 */
async function runBl2Stage(ctx: AdnlContext, protocolType: number, romSecure?: boolean) {
  const { device } = ctx
  progress(ctx, { stage: 'uboot' })
  await delay(ctx.timings.bl2BootDelay)

  let secure = romSecure
  const passes = protocolType > 5 ? 2 : 1
  for (let pass = 1; pass <= passes; pass++) {
    if (pass > 1) await delay(ctx.timings.bl2eDelay)
    const info = await device.identify()
    if (info.stage !== AdnlStage.SPL && info.stage !== AdnlStage.BL2E) {
      throw new AmlUsbError(
        `stage ${info.stageName}: BL2 has not booted; is an unsigned BL2 being ` +
          'booted on a secure-boot device?'
      )
    }
    await setBurnSteps(device, protocolType, AdnlBurnSteps.BL2)
    if (info.stage === AdnlStage.SPL) {
      secure ??= await device.isSecureBootBl2()
      if (protocolType > 5) await device.dumpChipInfo()
    }
    await serveCbws(ctx, bootItem(ctx.image, secure ?? false, 'UBOOT'), protocolType)
  }
}

/**
 * `oem mwrite` an item to U-Boot's storage or RAM in device-requested windows
 * (vendor `usb_cmd_mwrite_partition`), then verify it if the image has a digest.
 */
async function mwriteItem(
  ctx: AdnlContext,
  item: AmlImageItem,
  media: 'store' | 'mem',
  name: string,
  verify = false
) {
  const { device } = ctx
  progress(ctx, { stage: 'partition', partition: name })
  await device.command(`oem mwrite 0x${item.size.toString(16)} ${item.fileType} ${media} ${name}`)

  let next: { offset: number; size: number; data: Promise<Uint8Array<ArrayBuffer>> } | undefined
  let transferred = 0
  for (;;) {
    const reply = await device.request('mwrite:verify=addsum')
    if (startsWithAscii(reply, 'OKAY')) break
    const { size, offset } = parseDataOut(reply)
    if (offset + size > item.size) {
      throw new AmlUsbError(
        `${name}: window 0x${offset.toString(16)}+0x${size.toString(16)} is past the item`
      )
    }

    const data =
      next?.offset === offset && next.size === size
        ? await next.data
        : await item.read(offset, size)
    // the device usually asks for the following window next; read it during this transfer
    const nextOffset = offset + size
    next =
      nextOffset < item.size
        ? { offset: nextOffset, size, data: prefetch(item.read(nextOffset, size)) }
        : undefined

    for (let sent = 0; sent < data.length; sent += ADNL_BULK_SIZE) {
      await device.send(data.subarray(sent, sent + ADNL_BULK_SIZE))
    }
    await device.sendChecksum(amlsChecksum(data))

    transferred = Math.max(transferred, offset + data.length)
    progress(ctx, {
      stage: 'partition',
      partition: name,
      bytesTransferred: transferred,
      totalBytes: item.size
    })
  }

  const verifyItem = verify ? ctx.image.itemGet('VERIFY', name) : undefined
  if (verifyItem) {
    progress(ctx, { stage: 'verify', partition: name })
    const args = (await verifyItem.text()).trim()
    await device.commandPolling(`oem verify ${args}`, {
      timeout: ctx.timings.verifyTimeout,
      busyRetryDelay: ctx.timings.busyRetryDelay
    })
  }
}

/** Whether U-Boot reports secure boot (`getvar:secureboot`, first byte 1) */
async function tplSecureBoot(device: AdnlDevice): Promise<boolean> {
  const reply = await device.command('getvar:secureboot')
  if (reply.length < 8) {
    throw new AmlUsbError(`secureboot reply too short: ${reply.length} bytes`)
  }
  return reply[4] === 1
}

/** U-Boot 2015 families take no `sheader` (vendor `BootloaderVersion.uboot2015`) */
const UBOOT_2015_FAMILIES: ReadonlySet<SocFamily> = new Set(['T5', 'T5D'])

/** Partitions in the vendor's order: `_aml_dtb` first, `bootloader` last */
function partitionBurnOrder(image: AmlImage): AmlImageItem[] {
  const parts = image.items({ mainType: 'PARTITION' })
  const rest = parts.filter(
    (p) =>
      p.subType !== '_aml_dtb' && p.subType !== 'bootloader' && !p.subType.startsWith('bootloader-')
  )
  return [
    ...parts.filter((p) => p.subType === '_aml_dtb'),
    ...rest,
    ...parts.filter((p) => p.subType === 'bootloader')
  ]
}

/** Initialize storage in U-Boot and burn every partition (vendor `tpl_flow`) */
async function runTplStage(ctx: AdnlContext) {
  const { device, image } = ctx
  const info = await device.identify()
  if (info.stage !== AdnlStage.TPL) {
    throw new AmlUsbError(`expected U-Boot after loading it, got ${info.stageName}`)
  }
  await delay(ctx.timings.tplSettleDelay)

  await device.oemSetBurnSteps(AdnlBurnSteps.TPL_0)
  // the vendor asks U-Boot for secure boot only to pick the DTB
  let dtb = image.itemGet('dtb', 'meson1')
  if (dtb && image.itemGet('dtb', 'meson1_ENC') && (await tplSecureBoot(device))) {
    dtb = image.itemGet('dtb', 'meson1_ENC')
  }
  if (dtb) await mwriteItem(ctx, dtb, 'mem', 'dtb')

  const gpt = image.itemGet('bin', 'gpt')
  if (gpt) await mwriteItem(ctx, gpt, 'mem', 'gpt')

  const bootloader = image.itemGet('PARTITION', 'bootloader')
  if (bootloader && ctx.family && !UBOOT_2015_FAMILIES.has(ctx.family)) {
    const reply = await device.request('oem sheader_need')
    if (startsWithAscii(reply, 'OKAY')) {
      await mwriteItem(ctx, bootloader, 'mem', 'sheader')
    } else {
      device._log('debug', `no sheader needed: '${trimNulls(reply)}'`)
    }
  }

  await device.oemSetBurnSteps(AdnlBurnSteps.TPL_1)
  progress(ctx, { stage: 'disk-initial' })
  // the vendor reloads the DTB right before (re)partitioning
  if (dtb) await mwriteItem(ctx, dtb, 'mem', 'dtb')
  await device.command(`oem disk_initial ${ctx.options.wipe ?? WipeMode.None}`, {
    timeout: ctx.timings.diskInitialTimeout
  })
  await device.oemSetBurnSteps(AdnlBurnSteps.TPL_2)

  if (gpt) await mwriteItem(ctx, gpt, 'store', 'gpt')
  for (const item of partitionBurnOrder(image)) {
    await mwriteItem(ctx, item, 'store', item.subType, true)
  }

  progress(ctx, { stage: 'finish' })
  if (bootloader) {
    await device.command('oem save_setting')
  }
  if (ctx.options.reboot) {
    try {
      await device.command('reboot')
    } catch (error) {
      // the device may drop off the bus before replying
      device._log('debug', 'reboot reply not received', error)
    }
  }
}

/**
 * The ADNL burn flow (pyamlboot adnl.py, with the protocol 6 changes of the
 * vendor's `usb_flow_dnl.lua`): BootROM → BL2 (→ BL2E) → U-Boot →
 * partitions. U-Boot re-enumerates, so the device is reacquired once (twice
 * when starting from U-Boot, which first reboots into the BootROM).
 * @returns the device handle that finished the flash
 */
export async function flashAdnlImage(device: AdnlDevice, run: BurnRun): Promise<AdnlDevice> {
  const ctx: AdnlContext = { ...run, device }

  let info = await ctx.device.identify()
  if (info.stage === AdnlStage.TPL) {
    await ctx.device.command('reboot-romusb')
    await reacquire(ctx)
    info = await ctx.device.identify()
  }
  if (info.stage !== AdnlStage.ROM) {
    throw new AmlUsbError(`unexpected stage to start burning from: ${info.stageName}`)
  }

  progress(ctx, { stage: 'secure-check' })
  const family = (ctx.family = await ctx.device.getSocFamily())
  const secure = hasRomSecureBootMask(family) ? await ctx.device.isSecureBoot() : undefined

  await runBootromStage(ctx, info.protocolType, secure)
  await runBl2Stage(ctx, info.protocolType, secure)
  await reacquire(ctx)
  await runTplStage(ctx)

  return ctx.device
}
