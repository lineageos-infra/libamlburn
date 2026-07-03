import { AmlUsbError } from './errors'

/** Parsed `identify()` response (port of pyamlboot's SocId). */
export class DeviceInfo {
  static readonly STAGE_MINOR_IPL = 0 // Initial Program Loader (BootROM)
  static readonly STAGE_MINOR_SPL = 8 // Secondary Program Loader (BL2)
  static readonly STAGE_MINOR_TPL = 16 // Tertiary Program Loader (U-Boot)

  constructor(private readonly raw: Uint8Array) {
    if (raw.length < 4) {
      throw new AmlUsbError(`identify response too short (${raw.length} bytes)`)
    }
  }

  get major(): number {
    return this.raw[0]!
  }

  get minor(): number {
    return this.raw[1]!
  }

  get stageMajor(): number {
    return this.raw[2]!
  }

  get stageMinor(): number {
    return this.raw[3]!
  }

  /** Whether the response is the long form that carries the password flags. */
  get supportsPassword(): boolean {
    return this.raw.length >= 6
  }

  get needPassword(): boolean {
    return Boolean(this.byteAt(4))
  }

  get passwordOk(): boolean {
    return Boolean(this.byteAt(5))
  }

  get stageName(): 'IPL' | 'SPL' | 'TPL' | 'UNKNOWN' {
    if (this.stageMajor !== 0) return 'UNKNOWN'
    switch (this.stageMinor) {
      case DeviceInfo.STAGE_MINOR_IPL:
        return 'IPL'
      case DeviceInfo.STAGE_MINOR_SPL:
        return 'SPL'
      case DeviceInfo.STAGE_MINOR_TPL:
        return 'TPL'
      default:
        return 'UNKNOWN'
    }
  }

  toString(): string {
    const pad = Array.from(this.raw.slice(4))
      .map((byte) => `-${byte}`)
      .join('')
    return `${this.major}-${this.minor}-${this.stageMajor}-${this.stageMinor}${pad} (${this.stageName})`
  }

  private byteAt(index: number): number {
    const byte = this.raw[index]
    if (byte === undefined) {
      throw new AmlUsbError(`identify response too short (${this.raw.length} bytes)`)
    }
    return byte
  }
}
