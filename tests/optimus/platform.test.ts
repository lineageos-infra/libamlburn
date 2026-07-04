import { describe, expect, test } from 'vitest'
import { AmlUsbError } from '../../src/errors'
import { parsePlatformConfig } from '../../src/optimus/platform'

const CONF = `
Platform:0x0811
DDRLoad:0xd9000000
DDRRun:0xd9000000
UbootLoad:0x200c000
UbootRun:0xd9000000
bl2ParaAddr=0xd900c000
Control0=0xc110419c:0xb1
Control1=0xc1104174:0x5183
Encrypt_reg:0xc8100228
DDRSize:0x10000
`

describe('parsePlatformConfig', () => {
  test('parses a typical platform.conf', () => {
    const platform = parsePlatformConfig(CONF)

    expect(platform.platform).toBe(0x0811)
    expect(platform.ddrLoad).toBe(0xd9000000)
    expect(platform.ddrRun).toBe(0xd9000000)
    expect(platform.ubootLoad).toBe(0x200c000)
    expect(platform.ubootRun).toBe(0xd9000000)
    expect(platform.bl2ParaAddr).toBe(0xd900c000)
    expect(platform.control0Reg).toBe(0xc110419c)
    expect(platform.control0Val).toBe(0xb1)
    expect(platform.control1Reg).toBe(0xc1104174)
    expect(platform.control1Val).toBe(0x5183)
    expect(platform.encryptReg).toBe(0xc8100228)
    expect(platform.ddrSize).toBe(0x10000)
    expect(platform.binPara).toBe(0)
  })

  test('UbootLoad/UbootRun default to the DDR addresses', () => {
    const platform = parsePlatformConfig(`
Platform:0x0811
DDRLoad:0xd9000000
DDRRun:0xd9001000
Control0=0:0
Control1=0:0
`)
    expect(platform.ubootLoad).toBe(0xd9000000)
    expect(platform.ubootRun).toBe(0xd9001000)
  })

  test('ignores unknown entries', () => {
    expect(() =>
      parsePlatformConfig(`
Platform:0x0811
DDRLoad:0
DDRRun:0
Control0=0:0
Control1=0:0
SomeFutureKey:42
`)
    ).not.toThrow()
  })

  test('throws when a required key is missing', () => {
    expect(() => parsePlatformConfig('DDRLoad:0\nDDRRun:0\nControl0=0:0\nControl1=0:0')).toThrow(
      /required config Platform:/
    )
  })

  test('Control0/Control1 are optional (the burn flow has stock defaults)', () => {
    const platform = parsePlatformConfig('Platform:1\nDDRLoad:0\nDDRRun:0')
    expect(platform.control0Reg).toBe(0)
    expect(platform.control1Reg).toBe(0)
  })

  test('throws on malformed numbers', () => {
    expect(() =>
      parsePlatformConfig('Platform:zzz\nDDRLoad:0\nDDRRun:0\nControl0=0:0\nControl1=0:0')
    ).toThrow(AmlUsbError)
  })

  test('throws on a key with an empty value rather than defaulting it to 0', () => {
    expect(() =>
      parsePlatformConfig('Platform:\nDDRLoad:0\nDDRRun:0\nControl0=0:0\nControl1=0:0')
    ).toThrow(AmlUsbError)
  })

  test('throws on a ControlN entry without a value', () => {
    expect(() => parsePlatformConfig('Control0=0xc110419c')).toThrow(/invalid Control0= entry/)
  })
})
