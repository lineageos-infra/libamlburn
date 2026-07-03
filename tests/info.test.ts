import { describe, expect, test } from 'vitest'
import { AmlUsbError } from '../src/errors'
import { DeviceInfo } from '../src/info'

describe('DeviceInfo', () => {
  test('parses an IPL (BootROM) response', () => {
    const info = new DeviceInfo(new Uint8Array([0, 9, 0, 0, 0, 0, 0, 0]))
    expect(info.major).toBe(0)
    expect(info.minor).toBe(9)
    expect(info.stageMajor).toBe(0)
    expect(info.stageMinor).toBe(DeviceInfo.STAGE_MINOR_IPL)
    expect(info.stageName).toBe('IPL')
  })

  test('parses an SPL (BL2) response', () => {
    const info = new DeviceInfo(new Uint8Array([1, 1, 0, 8, 0, 0, 0, 0]))
    expect(info.stageMinor).toBe(DeviceInfo.STAGE_MINOR_SPL)
    expect(info.stageName).toBe('SPL')
  })

  test('parses a TPL (U-Boot) response', () => {
    const info = new DeviceInfo(new Uint8Array([2, 2, 0, 16, 0, 0, 0, 0]))
    expect(info.stageMinor).toBe(DeviceInfo.STAGE_MINOR_TPL)
    expect(info.stageName).toBe('TPL')
  })

  test('unknown stage', () => {
    expect(new DeviceInfo(new Uint8Array([0, 0, 1, 8])).stageName).toBe('UNKNOWN')
    expect(new DeviceInfo(new Uint8Array([0, 0, 0, 3])).stageName).toBe('UNKNOWN')
  })

  test('password flags', () => {
    const info = new DeviceInfo(new Uint8Array([0, 9, 0, 0, 1, 0, 0, 0]))
    expect(info.needPassword).toBe(true)
    expect(info.passwordOk).toBe(false)

    const unlocked = new DeviceInfo(new Uint8Array([0, 9, 0, 0, 1, 1, 0, 0]))
    expect(unlocked.passwordOk).toBe(true)
  })

  test('throws when the response is too short', () => {
    expect(() => new DeviceInfo(new Uint8Array([0, 9]))).toThrow(AmlUsbError)
    expect(() => new DeviceInfo(new Uint8Array([0, 9, 0, 0])).needPassword).toThrow(AmlUsbError)
  })

  test('toString matches the pyamlboot format', () => {
    const info = new DeviceInfo(new Uint8Array([0, 9, 0, 16, 0, 0, 0, 0]))
    expect(info.toString()).toBe('0-9-0-16-0-0-0-0 (TPL)')
  })
})
