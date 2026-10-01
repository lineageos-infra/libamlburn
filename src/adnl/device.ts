import { ADNL_READ_LEN } from '../constants'
import { BaseDevice } from '../devices'
import { AdnlCmdError, AmlUsbError } from '../errors'
import { startsWithAscii, trimNulls } from '../headers'
import { encodeAscii, packUint32sLE, readUint32LE } from '../utils/bytes'
import { AdnlReplyTag, Cbw, checkAdnlReply, hex8, parseCbw } from './headers'

/** Boot stage reported by `getvar:identify` (reply byte 7) */
export const AdnlStage = {
  ROM: 0,
  SPL: 8,
  BL2E: 12,
  TPL: 16
} as const
export type AdnlStage = (typeof AdnlStage)[keyof typeof AdnlStage]

const STAGE_NAMES: Record<number, string> = {
  [AdnlStage.ROM]: 'BootROM',
  [AdnlStage.SPL]: 'BL2',
  [AdnlStage.BL2E]: 'BL2E',
  [AdnlStage.TPL]: 'U-Boot'
}

/** SoC family id at offset 0x4 of chipinfo page 1 */
export const SocFamily = {
  A1: 0x2c,
  C1: 0x30,
  SC2: 0x32,
  C2: 0x33,
  T5: 0x34,
  T5D: 0x35,
  T7: 0x36,
  S4: 0x37
} as const
export type SocFamily = keyof typeof SocFamily

/**
 * Secure boot bit within FEAT. Absent families (SC2, T7, S4) have no BootROM
 * check in the vendor flow; BL2 answers it instead (see `isSecureBootBl2`).
 */
const FEAT_SECUREBOOT_MASK: Partial<Record<SocFamily, number>> = {
  A1: 0x1,
  C1: 0x1,
  C2: 0x1,
  T5: 0x10,
  T5D: 0x10
}

/** Whether the BootROM can report secure boot for this family (`isSecureBoot`) */
export function hasRomSecureBootMask(family: SocFamily): boolean {
  return FEAT_SECUREBOOT_MASK[family] !== undefined
}

/** Parsed `getvar:identify` reply. */
export class AdnlInfo {
  /** 5 or 6 for ADNL (3 would be Optimus) */
  readonly protocolType: number
  readonly minor: number
  readonly stage: number
  /** bitmap of the chipinfo pages BL2 serves */
  readonly pagesMap: number
  /** the identify reply payload after the `OKAY` tag */
  readonly raw: Uint8Array<ArrayBuffer>

  constructor(reply: Uint8Array) {
    this.protocolType = reply[4]!
    this.minor = reply[5]!
    this.stage = reply[7]!
    this.pagesMap = reply[11] ?? 0
    this.raw = new Uint8Array(reply.subarray(4))
  }

  get stageName(): string {
    return STAGE_NAMES[this.stage] ?? `stage ${this.stage}`
  }

  toString(): string {
    return `ADNL ${this.protocolType}.${this.minor} (${this.stageName})`
  }
}

/** An Amlogic SoC in USB burn mode speaking the bulk-only ADNL protocol (1b8e:c004). */
export class AdnlDevice extends BaseDevice {
  readonly protocol = 'adnl'

  /** Write raw bytes or an (unterminated) ASCII command to the bulk OUT endpoint */
  async send(data: string | Uint8Array) {
    const bytes = typeof data === 'string' ? encodeAscii(data) : new Uint8Array(data)
    await this.transport.bulkOut(bytes, this.timeout)
  }

  /** Read one reply packet */
  async receive(timeout?: number): Promise<Uint8Array<ArrayBuffer>> {
    return this.transport.bulkIn(ADNL_READ_LEN, timeout ?? this.timeout)
  }

  /**
   * Send a command or data payload and return the raw reply, unchecked.
   * U-Boot may interleave `INFO` messages; like the vendor tool, log and skip them.
   */
  async request(command: string | Uint8Array, timeout?: number) {
    await this.send(command)
    for (;;) {
      const reply = await this.receive(timeout)
      if (!startsWithAscii(reply, 'INFO')) return reply
      this._log('info', `(bootloader) ${trimNulls(reply.subarray(4))}`)
    }
  }

  /**
   * Send a command or data payload and check the reply's 4-byte tag.
   * @returns the full reply, tag included
   */
  async command(
    command: string | Uint8Array,
    options?: { expect?: AdnlReplyTag; timeout?: number }
  ): Promise<Uint8Array> {
    const { expect = 'OKAY', timeout } = options ?? {}
    return checkAdnlReply(command, await this.request(command, timeout), expect)
  }

  /**
   * Send a command, then poll through `INFO` (busy) replies until `OKAY`.
   */
  async commandPolling(
    command: string,
    options: { timeout: number; busyRetryDelay: number }
  ): Promise<void> {
    await this.send(command)
    const reply = await this.pollThroughBusy(
      () => this.receive(),
      'INFO',
      options.timeout,
      options.busyRetryDelay,
      `ADNL command '${command}' timed out`
    )
    checkAdnlReply(command, reply, 'OKAY')
  }

  async identify(): Promise<AdnlInfo> {
    const reply = await this.command('getvar:identify')
    const info = new AdnlInfo(reply)
    // newer BootROMs report 6; pyamlboot only knows 5
    if (info.protocolType !== 5 && info.protocolType !== 6) {
      throw new AdnlCmdError('getvar:identify', `not an ADNL reply (type ${info.protocolType})`)
    }
    return info
  }

  /**
   * Read a 64-byte chipinfo page (0: index, 1: chip, 3: ROM), tag stripped.
   * Only the BootROM and BL2 answer this.
   */
  async getChipInfo(page: number): Promise<Uint8Array> {
    if (!Number.isInteger(page) || page < 0 || page > 7) {
      throw new AmlUsbError(`chipinfo page ${page} is out of range [0, 7]`)
    }
    const { stage, stageName } = await this.identify()
    if (stage !== AdnlStage.ROM && stage !== AdnlStage.SPL) {
      throw new AmlUsbError(`chipinfo-${page} can't be queried from ${stageName}`)
    }
    return (await this.command(`getvar:getchipinfo-${page}`)).subarray(4)
  }

  private async chipInfoWord(offset: number): Promise<number> {
    const page = await this.getChipInfo(1)
    if (offset + 4 > page.length) {
      throw new AmlUsbError(`chipinfo-1 reply too short: ${page.length} bytes`)
    }
    return readUint32LE(page, offset)
  }

  /** FEAT flags (chipinfo page 1, offset 0x24) */
  getFeat(): Promise<number> {
    return this.chipInfoWord(0x24)
  }

  /** SoC family (chipinfo page 1, offset 0x4) */
  async getSocFamily(): Promise<SocFamily> {
    const id = await this.chipInfoWord(0x4)
    const family = (Object.keys(SocFamily) as SocFamily[]).find((name) => SocFamily[name] === id)
    if (!family) {
      throw new AmlUsbError(`unknown SoC family id 0x${id.toString(16)}`)
    }
    return family
  }

  /** Whether secure boot is fused on; only answerable from the BootROM */
  async isSecureBoot(): Promise<boolean> {
    const { stage, stageName } = await this.identify()
    if (stage !== AdnlStage.ROM) {
      throw new AmlUsbError(`secure boot can't be queried from ${stageName}`)
    }
    const feat = await this.getFeat()
    const family = await this.getSocFamily()
    const mask = FEAT_SECUREBOOT_MASK[family]
    if (mask === undefined) {
      throw new AmlUsbError(`no known secure boot FEAT bit for SoC family ${family}`)
    }
    this._log(
      'info',
      `SoC family ${family}: FEAT 0x${feat.toString(16)}, secure boot mask 0x${mask.toString(16)}`
    )
    return (feat & mask) !== 0
  }

  /**
   * Whether secure boot is fused on, as BL2 reports it (chipinfo page 4 license
   * bits 10/11), per the vendor's `usb_cmd_get_secureboot_enable`.
   */
  async isSecureBootBl2(): Promise<boolean> {
    const { stage, stageName, pagesMap } = await this.identify()
    if (stage !== AdnlStage.SPL) {
      throw new AmlUsbError(`BL2 secure boot can't be queried from ${stageName}`)
    }
    if ((pagesMap & 0x31) !== 0x31) {
      throw new AmlUsbError(
        `BL2 chipinfo pages 0x${pagesMap.toString(16)} can't report secure boot`
      )
    }
    const page = (await this.command('getvar:getchipinfo-4')).subarray(4)
    if (page.length < 4) {
      throw new AmlUsbError(`chipinfo-4 reply too short: ${page.length} bytes`)
    }
    const license = readUint32LE(page, 0)
    this._log('info', `BL2 license word 0x${license.toString(16)}`)
    return (license & 0xc00) === 0xc00
  }

  /** Read chipinfo page 0 and every page its map lists, as the vendor's `DumpFeats` does */
  async dumpChipInfo() {
    const page0 = (await this.command('getvar:getchipinfo-0')).subarray(4)
    if (!startsWithAscii(page0, 'INDX') || page0.length < 5 || (page0[4]! & 1) === 0) {
      throw new AmlUsbError(`invalid chipinfo index page '${trimNulls(page0.subarray(0, 8))}'`)
    }
    for (let page = 1; page <= 7; page++) {
      if (page0[4]! & (1 << page)) await this.command(`getvar:getchipinfo-${page}`)
    }
  }

  /** `setvar:burnsteps` (BootROM/BL2) */
  async setBurnSteps(step: number) {
    await this.command('setvar:burnsteps', { expect: 'DATA' })
    await this.command(packUint32sLE([step]))
  }

  /** `oem setvar burnsteps` (U-Boot) */
  async oemSetBurnSteps(step: number) {
    await this.command(`oem setvar burnsteps 0x${step.toString(16)}`)
  }

  /** Announce and send a data payload (BootROM/BL2) */
  async download(data: Uint8Array, announcedSize = data.length) {
    await this.command(`download:${hex8(announcedSize)}`, { expect: 'DATA' })
    await this.command(data)
  }

  /** Ask BL2 which window of U-Boot it wants next */
  async getCbw(): Promise<Cbw> {
    return parseCbw(await this.command('getvar:cbw'))
  }

  /** Send a 4-byte additive checksum as the payload of a preceding command */
  async sendChecksum(checksum: number) {
    await this.command(packUint32sLE([checksum]))
  }
}
