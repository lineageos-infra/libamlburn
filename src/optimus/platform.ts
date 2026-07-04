import { AmlUsbError } from '../errors'

/** Parsed `conf:platform` item (platform.conf) from an upgrade package. */
export type Platform = {
  platform: number
  ddrLoad: number
  ddrRun: number
  ubootLoad: number
  ubootRun: number
  binPara: number
  ubootDown: number
  ubootDecomp: number
  ubootEncDown: number
  ubootEncRun: number
  uboot: number
  encryptReg: number
  bl2ParaAddr: number
  /** PLL setup registers; 0 or absent means "use the stock defaults" */
  control0Reg: number
  control0Val: number
  control1Reg: number
  control1Val: number
  encryptReg1: number
  encryptReg2: number
  needPassword: number
  ddrSize: number
  encChipId1: number
  encChipId2: number
}

type IntField = { pattern: string; key: keyof Platform; required?: boolean }

const INT_FIELDS: IntField[] = [
  { pattern: 'Platform:', key: 'platform', required: true },
  { pattern: 'DDRLoad:', key: 'ddrLoad', required: true },
  { pattern: 'DDRRun:', key: 'ddrRun', required: true },
  { pattern: 'UbootLoad:', key: 'ubootLoad' },
  { pattern: 'UbootRun:', key: 'ubootRun' },
  { pattern: 'BinPara:', key: 'binPara' },
  { pattern: 'Uboot_down:', key: 'ubootDown' },
  { pattern: 'Uboot_decomp:', key: 'ubootDecomp' },
  { pattern: 'Uboot_enc_down:', key: 'ubootEncDown' },
  { pattern: 'Uboot_enc_run:', key: 'ubootEncRun' },
  { pattern: 'Uboot:', key: 'uboot' },
  { pattern: 'Encrypt_reg:', key: 'encryptReg' },
  { pattern: 'bl2ParaAddr=', key: 'bl2ParaAddr' },
  { pattern: 'Encrypt_reg1=', key: 'encryptReg1' },
  { pattern: 'Encrypt_reg2=', key: 'encryptReg2' },
  { pattern: 'needPassword=', key: 'needPassword' },
  { pattern: 'DDRSize:', key: 'ddrSize' },
  { pattern: 'enc_chip_id1:', key: 'encChipId1' },
  { pattern: 'enc_chip_id2:', key: 'encChipId2' }
]

function parseNumber(text: string): number {
  const trimmed = text.trim()
  const value = Number(trimmed)
  // Number('') is 0, which would silently pass a truncated key
  if (trimmed === '' || !Number.isFinite(value)) {
    throw new AmlUsbError(`invalid number '${trimmed}' in platform config`)
  }
  return value
}

export function parsePlatformConfig(text: string): Platform {
  const platform: Platform = {
    platform: 0,
    ddrLoad: 0,
    ddrRun: 0,
    ubootLoad: 0,
    ubootRun: 0,
    binPara: 0,
    ubootDown: 0,
    ubootDecomp: 0,
    ubootEncDown: 0,
    ubootEncRun: 0,
    uboot: 0,
    encryptReg: 0,
    bl2ParaAddr: 0,
    control0Reg: 0,
    control0Val: 0,
    control1Reg: 0,
    control1Val: 0,
    encryptReg1: 0,
    encryptReg2: 0,
    needPassword: 0,
    ddrSize: 0,
    encChipId1: 0,
    encChipId2: 0
  }
  const seen = new Set<string>()

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    const intField = INT_FIELDS.find((field) => line.startsWith(field.pattern))
    if (intField) {
      platform[intField.key] = parseNumber(line.slice(intField.pattern.length))
      seen.add(intField.pattern)
      continue
    }

    // ControlN=reg:val pairs (PLL setup registers)
    for (const n of [0, 1] as const) {
      const pattern = `Control${n}=`
      if (line.startsWith(pattern)) {
        const [reg, val] = line.slice(pattern.length).split(':')
        if (reg === undefined || val === undefined) {
          throw new AmlUsbError(`invalid ${pattern} entry in platform config`)
        }
        platform[`control${n}Reg`] = parseNumber(reg)
        platform[`control${n}Val`] = parseNumber(val)
        seen.add(pattern)
      }
    }
    // unknown entries are ignored, like pyamlboot
  }

  for (const field of INT_FIELDS) {
    if (field.required && !seen.has(field.pattern)) {
      throw new AmlUsbError(`required config ${field.pattern} not found in platform config`)
    }
  }
  // ControlN= lines are optional; the burn flow falls back to stock PLL values

  if (!seen.has('UbootLoad:')) platform.ubootLoad = platform.ddrLoad
  if (!seen.has('UbootRun:')) platform.ubootRun = platform.ddrRun

  return platform
}
