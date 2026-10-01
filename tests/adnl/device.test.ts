import { describe, expect, test } from 'vitest'
import { AdnlDevice, AdnlStage, SocFamily } from '../../src/adnl'
import { AdnlCmdError, AmlUsbError } from '../../src/errors'
import { asciiBytes } from '../fixtures'
import { chipInfo1Reply, createAdnlTransport, identifyReply, Responder } from './fake'

function device(respond: Responder) {
  const fake = createAdnlTransport(respond)
  return { fake, device: new AdnlDevice(fake.transport, { timeout: 100 }) }
}

function romWith(family: number, feat: number): Responder {
  return (_sent, text) => {
    if (text === 'getvar:identify') return identifyReply(AdnlStage.ROM)
    if (text === 'getvar:getchipinfo-1') return chipInfo1Reply(family, feat)
    return 'OKAY'
  }
}

describe('AdnlDevice', () => {
  test('sends commands without a NUL terminator', async () => {
    const { fake, device: d } = device(() => 'OKAY')
    await d.command('getvar:serialno')
    expect(fake.sent[0]).toEqual(asciiBytes('getvar:serialno'))
  })

  test('throws AdnlCmdError on an unexpected tag', async () => {
    const { device: d } = device(() => 'FAILno')
    await expect(d.command('boot')).rejects.toThrow(AdnlCmdError)
  })

  test('identify parses the stage', async () => {
    const { device: d } = device(() => identifyReply(AdnlStage.SPL))
    const info = await d.identify()
    expect(info.stage).toBe(AdnlStage.SPL)
    expect(info.stageName).toBe('BL2')
    expect(info.toString()).toBe('ADNL 5.1 (BL2)')
  })

  test('identify accepts protocol type 6', async () => {
    const reply = identifyReply(AdnlStage.ROM)
    reply[4] = 6
    const { device: d } = device(() => reply)
    const info = await d.identify()
    expect(info.protocolType).toBe(6)
    expect(info.stage).toBe(AdnlStage.ROM)
  })

  test('identify rejects a non-ADNL protocol type', async () => {
    const reply = identifyReply(AdnlStage.ROM)
    reply[4] = 3
    const { device: d } = device(() => reply)
    await expect(d.identify()).rejects.toThrow(/not an ADNL reply/)
  })

  test('chipinfo is refused from U-Boot', async () => {
    const { device: d } = device(() => identifyReply(AdnlStage.TPL))
    await expect(d.getChipInfo(1)).rejects.toThrow(/can't be queried from U-Boot/)
  })

  test('setBurnSteps sends the value as 4 LE bytes after a DATA reply', async () => {
    const { fake, device: d } = device((_s, text) =>
      text === 'setvar:burnsteps' ? 'DATA' : 'OKAY'
    )
    await d.setBurnSteps(0xc0040001)
    expect(fake.sent[1]).toEqual(new Uint8Array([0x01, 0x00, 0x04, 0xc0]))
  })

  test.each([
    ['A1', 0x1, true],
    ['A1', 0x10, false],
    ['T5D', 0x10, true],
    ['C2', 0x0, false]
  ] as const)('secure boot for %s with FEAT 0x%s is %s', async (family, feat, secure) => {
    const { device: d } = device(romWith(SocFamily[family], feat))
    await expect(d.isSecureBoot()).resolves.toBe(secure)
  })

  test('secure boot is unknown for families without a FEAT mask', async () => {
    const { device: d } = device(romWith(SocFamily.S4, 0x1))
    await expect(d.isSecureBoot()).rejects.toThrow(AmlUsbError)
  })

  test.each([
    [0xc00, true],
    [0x400, false]
  ])('BL2 license word 0x%s reports secure boot %s', async (license, secure) => {
    const page4 = asciiBytes('OKAY', 4 + 64)
    new DataView(page4.buffer).setUint32(4, license, true)
    const { device: d } = device((_s, text) =>
      text === 'getvar:identify' ? identifyReply(AdnlStage.SPL, 6, 0x31) : page4
    )
    await expect(d.isSecureBootBl2()).resolves.toBe(secure)
  })

  test('BL2 secure boot needs chipinfo pages 0, 4 and 5', async () => {
    const { device: d } = device(() => identifyReply(AdnlStage.SPL, 6, 0x11))
    await expect(d.isSecureBootBl2()).rejects.toThrow(/can't report secure boot/)
  })

  test('dumpChipInfo reads the pages the index maps', async () => {
    const index = asciiBytes('OKAYINDX', 4 + 64)
    index[8] = 0b10011
    const { fake, device: d } = device((_s, text) =>
      text === 'getvar:getchipinfo-0' ? index : 'OKAY'
    )
    await d.dumpChipInfo()
    expect(fake.commands).toEqual([
      'getvar:getchipinfo-0',
      'getvar:getchipinfo-1',
      'getvar:getchipinfo-4'
    ])
  })

  test('commandPolling waits through INFO replies', async () => {
    const { device: d } = device(() => ['INFObusy', 'INFObusy', 'OKAY'])
    await expect(
      d.commandPolling('oem verify sha1sum x', { timeout: 1000, busyRetryDelay: 0 })
    ).resolves.toBeUndefined()
  })

  test('commandPolling fails on FAIL', async () => {
    const { device: d } = device(() => ['INFObusy', 'FAILbad sum'])
    await expect(
      d.commandPolling('oem verify sha1sum x', { timeout: 1000, busyRetryDelay: 0 })
    ).rejects.toThrow(/bad sum/)
  })

  test('chipinfo pages are limited to 0..7', async () => {
    const { fake, device: d } = device(() => 'OKAY')
    await expect(d.getChipInfo(8)).rejects.toThrow(/out of range/)
    await expect(d.getChipInfo(1.5)).rejects.toThrow(/out of range/)
    expect(fake.sent).toHaveLength(0)
  })

  test('chipinfo strips the reply tag', async () => {
    const { device: d } = device(romWith(SocFamily.C1, 0))
    const page = await d.getChipInfo(1)
    expect(page).toHaveLength(64)
    expect(page[4]).toBe(SocFamily.C1)
  })

  test('a short chipinfo-1 page is rejected', async () => {
    const { device: d } = device((_s, text) =>
      text === 'getvar:identify' ? identifyReply(AdnlStage.ROM) : asciiBytes('OKAY', 8)
    )
    await expect(d.getFeat()).rejects.toThrow(/chipinfo-1 reply too short/)
  })

  test('an unknown SoC family is rejected', async () => {
    const { device: d } = device(romWith(0x99, 0))
    await expect(d.getSocFamily()).rejects.toThrow(/unknown SoC family id 0x99/)
  })

  test('secure boot is only queried from the BootROM', async () => {
    const { device: d } = device(() => identifyReply(AdnlStage.SPL))
    await expect(d.isSecureBoot()).rejects.toThrow(/can't be queried from BL2/)
  })

  test('identify names unknown stages by number', async () => {
    const { device: d } = device(() => identifyReply(3))
    expect((await d.identify()).stageName).toBe('stage 3')
  })

  test('oemSetBurnSteps formats the step as hex', async () => {
    const { fake, device: d } = device(() => 'OKAY')
    await d.oemSetBurnSteps(0xc0041030)
    expect(fake.commands).toEqual(['oem setvar burnsteps 0xc0041030'])
  })

  test('download announces the payload size by default', async () => {
    const { fake, device: d } = device((_s, text) =>
      text?.startsWith('download:') ? 'DATA' : 'OKAY'
    )
    await d.download(new Uint8Array(0x1234))
    expect(fake.commands).toEqual(['download:00001234'])
  })

  test('usbDevice is undefined off WebUSB', () => {
    const { device: d } = device(() => 'OKAY')
    expect(d.usbDevice).toBeUndefined()
  })
})
