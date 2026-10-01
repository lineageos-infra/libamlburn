import { describe, expect, test, vi } from 'vitest'
import { AdnlDevice, AdnlStage, SocFamily } from '../../src/adnl'
import { AmlUsbError } from '../../src/errors'
import { BurnProgress, BurnTimings, flashImage, WipeMode } from '../../src/flash'
import { AmlImage } from '../../src/image'
import { OptimusDevice } from '../../src/optimus'
import { amlsChecksum } from '../../src/utils/checksum'
import { asciiBytes, buildImage, FixtureItem } from '../fixtures'
import {
  cbwReply,
  checksumBytes,
  chipInfo1Reply,
  createAdnlTransport,
  identifyReply,
  Responder
} from './fake'

const ZERO_TIMINGS: Partial<BurnTimings> = {
  stepDelay: 0,
  diskInitialTimeout: 1000,
  verifyTimeout: 1000,
  busyRetryDelay: 0,
  reacquireTimeout: 1000,
  bl2BootDelay: 0,
  bl2eDelay: 0,
  tplSettleDelay: 0
}

const DDR = new Uint8Array(0x300).fill(0xdd)
const UBOOT = new Uint8Array(0x5200).map((_, i) => i & 0xff)
const BOOT = new Uint8Array(0x6000).map((_, i) => (i * 7) & 0xff)
const BOOTLOADER = new Uint8Array(0x100).fill(0xcc)

async function openImage(extra: FixtureItem[] = []) {
  return AmlImage.open(
    buildImage(2, [
      { mainType: 'USB', subType: 'DDR', payload: DDR },
      { mainType: 'USB', subType: 'UBOOT', payload: UBOOT },
      { mainType: 'PARTITION', subType: 'boot', payload: BOOT },
      { mainType: 'VERIFY', subType: 'boot', payload: asciiBytes('sha1sum abc123\n') },
      ...extra
    ])
  )
}

/** BootROM that boots into BL2 on `boot`, then serves the given CBWs */
function romResponder(cbws: Uint8Array<ArrayBuffer>[], family: number = SocFamily.A1): Responder {
  let stage: number = AdnlStage.ROM
  return (_sent, text) => {
    switch (text) {
      case 'getvar:identify':
        return identifyReply(stage)
      case 'getvar:getchipinfo-1':
        return chipInfo1Reply(family, 0)
      case 'getvar:downloadsize':
        return asciiBytes('OKAY0x10000', 32)
      case 'getvar:cbw':
        return cbws.shift()
      case 'setvar:burnsteps':
      case 'setvar:checksum':
        return 'DATA'
      case 'boot':
        stage = AdnlStage.SPL
        return 'OKAY'
    }
    if (text?.startsWith('download:')) return 'DATA'
    return 'OKAY'
  }
}

/** U-Boot that asks for each partition in the given DATAOUT windows */
function tplResponder(windows: Record<string, [number, number][]>): Responder {
  let current: [number, number][] = []
  let pendingRaw = 0
  return (sent, text) => {
    if (pendingRaw > 0) {
      pendingRaw -= sent.length
      return undefined
    }
    if (text === 'getvar:identify') return identifyReply(AdnlStage.TPL)
    const mwrite = text && /^oem mwrite \S+ \S+ (?:store|mem) (\S+)$/.exec(text)
    if (mwrite) current = [...(windows[mwrite[1]!] ?? [])]
    if (text === 'mwrite:verify=addsum') {
      const window = current.shift()
      if (!window) return 'OKAY'
      pendingRaw = window[0]
      return asciiBytes(`DATAOUT${window[0].toString(16)}:${window[1].toString(16)}`, 64)
    }
    if (text?.startsWith('oem verify')) return ['INFOchecking', 'OKAY']
    return 'OKAY'
  }
}

describe('flashImage over ADNL', () => {
  test('runs ROM -> BL2 -> reacquire -> TPL', async () => {
    const image = await openImage([
      { mainType: 'PARTITION', subType: 'bootloader', payload: BOOTLOADER }
    ])
    const rom = createAdnlTransport(
      romResponder([cbwReply(0, 0x5000, 0), cbwReply(1, 0x200, 0x5000), cbwReply(2, 0, 0, true)])
    )
    const tpl = createAdnlTransport(
      tplResponder({
        boot: [
          [0x4000, 0],
          [0x2000, 0x4000]
        ],
        bootloader: [[0x100, 0]]
      })
    )
    const romDevice = new AdnlDevice(rom.transport, { timeout: 100 })
    const tplDevice = new AdnlDevice(tpl.transport, { timeout: 100 })
    const reacquire = vi.fn().mockResolvedValue(tplDevice)
    const progress: BurnProgress[] = []

    const result = await flashImage(romDevice, image, {
      wipe: WipeMode.All,
      reboot: true,
      timings: ZERO_TIMINGS,
      reacquire,
      onProgress: (p) => progress.push(p)
    })

    expect(result).toBe(tplDevice)
    expect(reacquire).toHaveBeenCalledTimes(1)

    expect(rom.commands).toEqual([
      'getvar:identify',
      // secure check
      'getvar:identify',
      'getvar:getchipinfo-1',
      'getvar:identify',
      'getvar:identify',
      'getvar:getchipinfo-1',
      'getvar:identify',
      'getvar:getchipinfo-1',
      // ROM stage
      'getvar:serialno',
      'getvar:getchipinfo-1',
      'getvar:getchipinfo-0',
      'getvar:getchipinfo-1',
      'getvar:getchipinfo-2',
      'getvar:getchipinfo-3',
      'setvar:burnsteps',
      'getvar:getchipinfo-1',
      'setvar:burnsteps',
      'getvar:downloadsize',
      'download:00010000',
      'setvar:burnsteps',
      'boot',
      // BL2 stage
      'getvar:identify',
      'setvar:burnsteps',
      'getvar:cbw',
      'download:00004000',
      'download:00001000',
      'setvar:checksum',
      'getvar:cbw',
      'download:00000200',
      'setvar:checksum',
      'getvar:cbw'
    ])

    // the whole DDR item follows download:, despite the announced 0x10000
    const ddrIndex = rom.sent.findIndex((s) => s.length === DDR.length)
    expect(rom.sent[ddrIndex]).toEqual(DDR)

    // BL2 checksum covers the whole CBW window, summed per 16 KiB chunk
    const firstSum =
      (amlsChecksum(UBOOT.subarray(0, 0x4000)) + amlsChecksum(UBOOT.subarray(0x4000, 0x5000))) >>> 0
    const firstSumIndex = rom.sent.findIndex(
      (s, i) => i > 0 && new TextDecoder().decode(rom.sent[i - 1]) === 'setvar:checksum'
    )
    expect(rom.sent[firstSumIndex]).toEqual(checksumBytes(firstSum))

    expect(tpl.commands).toEqual([
      'getvar:identify',
      'oem setvar burnsteps 0xc0041030',
      'oem sheader_need',
      'oem mwrite 0x100 normal mem sheader',
      'mwrite:verify=addsum',
      'oem setvar burnsteps 0xc0041031',
      'oem disk_initial 3',
      'oem setvar burnsteps 0xc0041032',
      'oem mwrite 0x6000 normal store boot',
      'mwrite:verify=addsum',
      'mwrite:verify=addsum',
      'mwrite:verify=addsum',
      'oem verify sha1sum abc123',
      'oem mwrite 0x100 normal store bootloader',
      'mwrite:verify=addsum',
      'mwrite:verify=addsum',
      'oem save_setting',
      'reboot'
    ])

    // partition windows go out raw in <=16 KiB transfers, then their checksum
    const bootData = tpl.sent.filter((s) => s.length >= 0x1000)
    expect(bootData.map((s) => s.length)).toEqual([0x4000, 0x2000])
    expect(bootData[1]).toEqual(BOOT.subarray(0x4000))
    expect(tpl.sent).toContainEqual(checksumBytes(amlsChecksum(BOOT.subarray(0x4000))))

    expect(new Set(progress.map((p) => p.stage))).toEqual(
      new Set(['secure-check', 'spl', 'uboot', 'disk-initial', 'partition', 'verify', 'finish'])
    )
    expect(
      progress.filter((p) => p.stage === 'partition' && p.partition === 'boot').at(-1)
    ).toMatchObject({ bytesTransferred: 0x6000, totalBytes: 0x6000 })
  })

  test('picks the signed boot items on a secure-boot device', async () => {
    const image = await AmlImage.open(
      buildImage(2, [
        { mainType: 'USB', subType: 'DDR_ENC', payload: DDR },
        { mainType: 'USB', subType: 'UBOOT_ENC', payload: UBOOT }
      ])
    )
    let stage: number = AdnlStage.ROM
    const base = romResponder([cbwReply(0, 0, 0, true)])
    const rom = createAdnlTransport((sent, text) => {
      if (text === 'getvar:getchipinfo-1') return chipInfo1Reply(SocFamily.A1, 0x1)
      if (text === 'boot') stage = AdnlStage.SPL
      if (text === 'getvar:identify') return identifyReply(stage)
      return base(sent, text)
    })
    const tpl = createAdnlTransport(tplResponder({}))
    await flashImage(new AdnlDevice(rom.transport, { timeout: 100 }), image, {
      timings: ZERO_TIMINGS,
      reacquire: () => Promise.resolve(new AdnlDevice(tpl.transport, { timeout: 100 }))
    })
    expect(tpl.commands.at(-1)).toBe('oem setvar burnsteps 0xc0041032')
  })

  test('follows the vendor flow for a protocol 6 S4 BootROM', async () => {
    const bigDdr = new Uint8Array(0x20000).map((_, i) => i & 0xff)
    const image = await AmlImage.open(
      buildImage(2, [
        { mainType: 'USB', subType: 'DDR', payload: bigDdr },
        { mainType: 'USB', subType: 'UBOOT', payload: UBOOT }
      ])
    )
    const index = asciiBytes('OKAYINDX', 4 + 64)
    index[8] = 0b110011
    let stage: number = AdnlStage.ROM
    const cbws = [
      cbwReply(0, 0, 0, false, { requestType: 0xff }),
      cbwReply(0, 0x4000, 0),
      cbwReply(1, 0, 0, true),
      cbwReply(0, 0x200, 0x4000, false, { flags: 1 }),
      cbwReply(1, 0, 0, true)
    ]
    const checksumReplies = ['FAILbad sum', 'DATA']
    const rom = createAdnlTransport((_sent, text) => {
      switch (text) {
        case 'getvar:identify':
          return identifyReply(stage, 6, 0x31)
        case 'getvar:getchipinfo-0':
          return index
        case 'getvar:getchipinfo-1':
          return chipInfo1Reply(SocFamily.S4, 0)
        case 'getvar:getchipinfo-4':
        case 'getvar:getchipinfo-5':
          return asciiBytes('OKAY', 4 + 64)
        case 'getvar:downloadsize':
          return asciiBytes('OKAY0x10000', 32)
        case 'setvar:burnsteps':
          return 'FAILunknow command'
        case 'setvar:checksum':
          return checksumReplies.shift() ?? 'DATA'
        case 'boot':
          stage = AdnlStage.SPL
          return 'OKAY'
        case 'getvar:cbw': {
          const cbw = cbws.shift()!
          if (cbw[21] === 1) stage = AdnlStage.BL2E
          return cbw
        }
      }
      if (text?.startsWith('download:')) return 'DATA'
      return 'OKAY'
    })
    const tpl = createAdnlTransport(tplResponder({}))
    await flashImage(new AdnlDevice(rom.transport, { timeout: 100 }), image, {
      timings: ZERO_TIMINGS,
      reacquire: () => Promise.resolve(new AdnlDevice(tpl.transport, { timeout: 100 }))
    })

    expect(rom.commands).not.toContain('setvar:burnsteps')
    // only the ROM's downloadsize of the DDR item
    expect(rom.commands).toContain('download:00010000')
    expect(rom.sent.find((s) => s.length === 0x10000)).toEqual(bigDdr.subarray(0, 0x10000))
    // BL2 is checked for secure boot and dumps its chipinfo pages
    expect(rom.commands).toContain('getvar:getchipinfo-4')
    expect(rom.commands).toContain('getvar:getchipinfo-5')
    // a rejected checksum resends the window
    expect(rom.commands.filter((c) => c === 'download:00004000')).toHaveLength(2)
    expect(rom.commands.filter((c) => c === 'setvar:checksum')).toHaveLength(2)
    // BL2E is served after BL2, and its window wants no checksum
    const bl2eWindow = rom.commands.indexOf('download:00000200')
    expect(rom.commands[bl2eWindow + 1]).toBe('getvar:cbw')
    expect(cbws).toHaveLength(0)
    expect(checksumReplies).toHaveLength(0)
  })

  test('follows the vendor U-Boot flow: DTB, GPT, sparse items, bootloader last', async () => {
    const GPT = new Uint8Array(0x200).fill(0x67)
    const DTB = new Uint8Array(0x80).fill(0xd7)
    const SUPER = new Uint8Array(0x300).fill(0x5e)
    const image = await AmlImage.open(
      buildImage(2, [
        { mainType: 'bin', subType: 'gpt', payload: GPT },
        { mainType: 'USB', subType: 'DDR', payload: DDR },
        { mainType: 'USB', subType: 'UBOOT', payload: UBOOT },
        { mainType: 'dtb', subType: 'meson1', payload: DTB },
        { mainType: 'dtb', subType: 'meson1_ENC', payload: DTB },
        { mainType: 'PARTITION', subType: 'bootloader', payload: BOOTLOADER },
        { mainType: 'PARTITION', subType: 'super', fileType: 0xfe, payload: SUPER },
        { mainType: 'PARTITION', subType: '_aml_dtb', payload: DTB },
        { mainType: 'VERIFY', subType: 'super', payload: asciiBytes('sha1sum 5e\n') }
      ])
    )
    const rom = createAdnlTransport(romResponder([cbwReply(0, 0, 0, true)]))
    const respond = tplResponder({
      gpt: [[0x200, 0]],
      dtb: [[0x80, 0]],
      super: [[0x300, 0]],
      _aml_dtb: [[0x80, 0]],
      bootloader: [[0x100, 0]]
    })
    const tpl = createAdnlTransport((sent, text) => {
      if (text === 'getvar:secureboot') return asciiBytes('OKAY\x01', 8)
      if (text === 'oem sheader_need') return 'FAILnot need'
      const reply = respond(sent, text)
      // U-Boot interleaves progress messages
      return text === 'mwrite:verify=addsum' ? ['INFOprogress', reply as string] : reply
    })
    await flashImage(new AdnlDevice(rom.transport, { timeout: 100 }), image, {
      timings: ZERO_TIMINGS,
      reacquire: () => Promise.resolve(new AdnlDevice(tpl.transport, { timeout: 100 }))
    })

    expect(tpl.commands.filter((c) => c.startsWith('oem ') || c.startsWith('getvar:'))).toEqual([
      'getvar:identify',
      'oem setvar burnsteps 0xc0041030',
      'getvar:secureboot',
      'oem mwrite 0x80 normal mem dtb',
      'oem mwrite 0x200 normal mem gpt',
      'oem sheader_need',
      'oem setvar burnsteps 0xc0041031',
      'oem mwrite 0x80 normal mem dtb',
      'oem disk_initial 0',
      'oem setvar burnsteps 0xc0041032',
      'oem mwrite 0x200 normal store gpt',
      'oem mwrite 0x80 normal store _aml_dtb',
      'oem mwrite 0x300 sparse store super',
      'oem verify sha1sum 5e',
      'oem mwrite 0x100 normal store bootloader',
      'oem save_setting'
    ])
    // the sparse item goes out as packaged
    expect(tpl.sent).toContainEqual(SUPER)
  })

  test('starting from U-Boot reboots into the BootROM first', async () => {
    const image = await openImage()
    const uboot = createAdnlTransport((_s, text) =>
      text === 'getvar:identify' ? identifyReply(AdnlStage.TPL) : 'OKAY'
    )
    const rom = createAdnlTransport(romResponder([cbwReply(0, 0, 0, true)]))
    const tpl = createAdnlTransport(tplResponder({ boot: [] }))
    const devices = [rom, tpl].map((f) => new AdnlDevice(f.transport, { timeout: 100 }))
    const reacquire = vi.fn(() => Promise.resolve(devices.shift()!))

    await flashImage(new AdnlDevice(uboot.transport, { timeout: 100 }), image, {
      timings: ZERO_TIMINGS,
      reacquire
    })

    expect(uboot.commands).toEqual(['getvar:identify', 'reboot-romusb'])
    expect(reacquire).toHaveBeenCalledTimes(2)
    expect(tpl.commands).toContain('oem mwrite 0x6000 normal store boot')
  })

  test('fails clearly when BL2 did not boot', async () => {
    const image = await openImage()
    const respond = romResponder([])
    const rom = createAdnlTransport((sent, text) => {
      // the ROM stays in the ROM after `boot` (e.g. unsigned BL2 on a secure part)
      if (text === 'getvar:identify') return identifyReply(AdnlStage.ROM)
      return respond(sent, text)
    })
    await expect(
      flashImage(new AdnlDevice(rom.transport, { timeout: 100 }), image, {
        timings: ZERO_TIMINGS
      })
    ).rejects.toThrow(/BL2 has not booted/)
  })

  test('rejects a reacquired device of the other protocol', async () => {
    const image = await openImage()
    const rom = createAdnlTransport(romResponder([cbwReply(0, 0, 0, true)]))
    const optimus = new OptimusDevice(createAdnlTransport(() => undefined).transport)
    await expect(
      flashImage(new AdnlDevice(rom.transport, { timeout: 100 }), image, {
        timings: ZERO_TIMINGS,
        reacquire: () => Promise.resolve(optimus)
      })
    ).rejects.toThrow(AmlUsbError)
  })

  test('refuses to start from BL2', async () => {
    const image = await openImage()
    const spl = createAdnlTransport(() => identifyReply(AdnlStage.SPL))
    await expect(
      flashImage(new AdnlDevice(spl.transport, { timeout: 100 }), image, {
        timings: ZERO_TIMINGS
      })
    ).rejects.toThrow(/unexpected stage to start burning from: BL2/)
  })

  test('fails clearly when the reacquired device is not in U-Boot', async () => {
    const image = await openImage()
    const rom = createAdnlTransport(romResponder([cbwReply(0, 0, 0, true)]))
    const stuck = createAdnlTransport(() => identifyReply(AdnlStage.SPL))
    await expect(
      flashImage(new AdnlDevice(rom.transport, { timeout: 100 }), image, {
        timings: ZERO_TIMINGS,
        reacquire: () => Promise.resolve(new AdnlDevice(stuck.transport, { timeout: 100 }))
      })
    ).rejects.toThrow(/expected U-Boot after loading it, got BL2/)
  })

  test('requires the unsigned DDR item on a non-secure device', async () => {
    const image = await AmlImage.open(
      buildImage(2, [{ mainType: 'USB', subType: 'UBOOT', payload: UBOOT }])
    )
    const rom = createAdnlTransport(romResponder([]))
    await expect(
      flashImage(new AdnlDevice(rom.transport, { timeout: 100 }), image, {
        timings: ZERO_TIMINGS
      })
    ).rejects.toThrow(/does not contain any non-signed DDR item/)
  })

  test('tolerates a lost reboot reply and skips save_setting without a bootloader', async () => {
    const image = await AmlImage.open(
      buildImage(2, [
        { mainType: 'USB', subType: 'DDR', payload: DDR },
        { mainType: 'USB', subType: 'UBOOT', payload: UBOOT },
        { mainType: 'PARTITION', subType: 'boot', payload: BOOT }
      ])
    )
    const rom = createAdnlTransport(romResponder([cbwReply(0, 0, 0, true)]))
    const respond = tplResponder({ boot: [[0x6000, 0]] })
    // the device drops off the bus instead of acking reboot
    const tpl = createAdnlTransport((sent, text) =>
      text === 'reboot' ? undefined : respond(sent, text)
    )
    const tplDevice = new AdnlDevice(tpl.transport, { timeout: 100 })

    await expect(
      flashImage(new AdnlDevice(rom.transport, { timeout: 100 }), image, {
        reboot: true,
        timings: ZERO_TIMINGS,
        reacquire: () => Promise.resolve(tplDevice)
      })
    ).resolves.toBe(tplDevice)

    // no VERIFY item -> no verify; no bootloader -> no save_setting
    expect(tpl.commands.slice(-3)).toEqual([
      'mwrite:verify=addsum',
      'mwrite:verify=addsum',
      'reboot'
    ])
  })

  test('serves equal-size windows from the prefetched read', async () => {
    const image = await openImage()
    const rom = createAdnlTransport(romResponder([cbwReply(0, 0, 0, true)]))
    const tpl = createAdnlTransport(
      tplResponder({
        boot: [
          [0x3000, 0],
          [0x3000, 0x3000]
        ]
      })
    )
    await flashImage(new AdnlDevice(rom.transport, { timeout: 100 }), image, {
      timings: ZERO_TIMINGS,
      reacquire: () => Promise.resolve(new AdnlDevice(tpl.transport, { timeout: 100 }))
    })

    const windows = tpl.sent.filter((s) => s.length === 0x3000)
    expect(windows).toEqual([BOOT.subarray(0, 0x3000), BOOT.subarray(0x3000)])
  })

  test('requires the signed DDR item on a secure-boot device', async () => {
    const image = await openImage()
    const respond = romResponder([])
    const rom = createAdnlTransport((sent, text) =>
      text === 'getvar:getchipinfo-1' ? chipInfo1Reply(SocFamily.A1, 0x1) : respond(sent, text)
    )
    await expect(
      flashImage(new AdnlDevice(rom.transport, { timeout: 100 }), image, {
        timings: ZERO_TIMINGS
      })
    ).rejects.toThrow(/does not contain any signed DDR item/)
  })
})
