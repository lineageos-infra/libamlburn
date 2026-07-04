import { openAsBlob } from 'node:fs'
import { describe, expect, test, vi } from 'vitest'
import { Request } from '../../src/constants'
import { Device } from '../../src/device'
import { AmlImageError, BulkCmdError, PasswordError } from '../../src/errors'
import { trimNulls } from '../../src/headers'
import { AmlImage } from '../../src/image'
import { BurnProgress, BurnTimings, flashImage, WipeMode } from '../../src/optimus'
import { UsbTransport } from '../../src/transport'
import { asciiBytes, buildImage, FixtureItem } from '../fixtures'

const ZERO_TIMINGS: Partial<BurnTimings> = {
  stepDelay: 0,
  passwordDelay: 0,
  regDelay: 0,
  splRunDelay: 0,
  ubootRunDelay: 0,
  ubootSettleDelay: 0,
  diskInitialTimeout: 1000,
  verifyTimeout: 1000,
  busyRetryDelay: 0,
  reacquireTimeout: 1000
}

const PLATFORM_CONF = `
Platform:0x0811
DDRLoad:0xd9000000
DDRRun:0xd9000000
UbootLoad:0x200c000
UbootRun:0xd9000000
bl2ParaAddr=0
Control0=0xc110419c:0xb1
Control1=0xc1104174:0x5183
Encrypt_reg:0xc8100228
DDRSize:0
`

type ControlOutCall = { request: number; value: number; index: number; data?: Uint8Array }

/**
 * A scripted transport: identify responses come from a queue (repeating the
 * last), TPL stats and bulk replies from queues, and every string command is
 * recorded in order.
 */
function createBurnTransport(script: {
  identifies: number[][]
  bulkReplies?: (string | Uint8Array<ArrayBuffer>)[]
  tplReplies?: string[]
  readMemReplies?: Uint8Array<ArrayBuffer>[]
  /** commands whose control transfer fails (device dropped off the bus) */
  failControlCommands?: string[]
}) {
  const identifies = script.identifies.map((bytes) => new Uint8Array(bytes))
  const bulkQueue = (script.bulkReplies ?? []).map((reply) =>
    typeof reply === 'string' ? asciiBytes(reply, 512) : reply
  )
  const tplQueue = script.tplReplies ?? []
  const readMemQueue = script.readMemReplies ?? []

  const commands: string[] = []
  const controlsOut: ControlOutCall[] = []
  const bulkSent: Uint8Array[] = []

  const transport = {
    connect: () => Promise.resolve(),
    controlOut: (request: number, value: number, index: number, data?: Uint8Array<ArrayBuffer>) => {
      controlsOut.push({ request, value, index, ...(data ? { data: data.slice() } : {}) })
      if ((request === Request.BULKCMD || request === Request.TPL_CMD) && data) {
        const command = trimNulls(data)
        commands.push(command)
        if (script.failControlCommands?.includes(command)) {
          return Promise.reject(new Error('device dropped off the bus'))
        }
      }
      return Promise.resolve(data?.length ?? 0)
    },
    controlIn: (request: number, _value: number, _index: number, length: number) => {
      switch (request) {
        case Request.IDENTIFY_HOST: {
          const reply = identifies.length > 1 ? identifies.shift()! : identifies[0]
          if (!reply) return Promise.reject(new Error('no identify reply scripted'))
          return Promise.resolve(new Uint8Array(reply))
        }
        case Request.TPL_STAT:
          return Promise.resolve(asciiBytes(tplQueue.shift() ?? 'success', 0x40))
        case Request.READ_MEDIA:
          return Promise.resolve(new Uint8Array(length))
        case Request.READ_MEM: {
          const reply = readMemQueue.shift()
          if (!reply) return Promise.reject(new Error('no READ_MEM reply scripted'))
          return Promise.resolve(reply)
        }
        default:
          return Promise.reject(new Error(`unscripted control read 0x${request.toString(16)}`))
      }
    },
    bulkOut: (data: Uint8Array<ArrayBuffer>) => {
      bulkSent.push(data.slice())
      return Promise.resolve()
    },
    bulkIn: () => {
      const reply = bulkQueue.shift()
      if (!reply) return Promise.reject(new Error('bulk reply queue is empty'))
      return Promise.resolve(reply)
    },
    close: () => Promise.resolve(),
    onDisconnect: () => {}
  } satisfies UsbTransport

  return { transport, commands, controlsOut, bulkSent }
}

function amlcRequest(length: number, offset: number): Uint8Array<ArrayBuffer> {
  const block = asciiBytes('AMLC', 512)
  const view = new DataView(block.buffer)
  view.setUint32(8, length, true)
  view.setUint32(12, offset, true)
  return block
}

/** A 512-byte BL2 para block as read back by checkPara */
function paraBlock(magic = 0x7856efab): Uint8Array<ArrayBuffer> {
  const block = new Uint8Array(512)
  new DataView(block.buffer).setUint32(0, magic, true)
  return block
}

/** The 8 x 64-byte bulk replies of the 0x200 chip-id read at IPL */
function chipIdBlocks(chipId: number): Uint8Array<ArrayBuffer>[] {
  const blocks = Array.from({ length: 8 }, () => new Uint8Array(64))
  new DataView(blocks[0]!.buffer).setUint32(0, chipId, true)
  return blocks
}

const IPL = [2, 2, 0, 0, 0, 0, 0, 0]
const SPL_AMLC = [2, 2, 1, 8, 0, 0, 0, 0]
const TPL = [0, 9, 0, 16, 0, 0, 0, 0]

async function openFixtureImage(extraItems: FixtureItem[] = [], conf = PLATFORM_CONF) {
  return AmlImage.open(
    buildImage(2, [
      { mainType: 'conf', subType: 'platform', payload: asciiBytes(conf) },
      { mainType: 'USB', subType: 'DDR', payload: new Uint8Array(64).fill(0xdd) },
      { mainType: 'USB', subType: 'UBOOT', payload: new Uint8Array(0x400).fill(0xbb) },
      ...extraItems
    ])
  )
}

/** AXG/GXL-style platform: a para block address instead of the AMLC flow */
const PARA_CONF = `
Platform:0x0811
DDRLoad:0xd9000000
DDRRun:0xd9000000
UbootLoad:0x200c000
UbootRun:0xd9010000
bl2ParaAddr=0xd9013800
Control0=0xc110419c:0xb1
Control1=0xc1104174:0x5183
Encrypt_reg:0xc8100228
DDRSize:0
`

describe('flashImage from TPL (device already in U-Boot)', () => {
  test('runs the full command sequence', async () => {
    const image = await openFixtureImage([
      { mainType: 'PARTITION', subType: 'boot', verify: 1, payload: new Uint8Array(8).fill(1) },
      { mainType: 'VERIFY', subType: 'boot', payload: asciiBytes('sha1sum abc123') },
      { mainType: 'PARTITION', subType: 'system', payload: new Uint8Array(16).fill(2) }
    ])

    const fake = createBurnTransport({
      identifies: [TPL],
      bulkReplies: [
        'success', //     low_power (erase-bootloader step)
        'failed', //      bootloader_is_old -> "new", skip erase
        'success', //     upload mem (secure check)
        new Uint8Array([0, 0, 0, 0]), // encrypt reg value -> not secure
        'success', //     low_power
        'success', //     disk_initial
        asciiBytes('OK!!', 0x200), // boot media ack
        'success', //     download get_status (boot)
        'success', //     verify boot
        asciiBytes('OK!!', 0x200), // system media ack
        'success', //     download get_status (system)
        'success', //     save_setting
        'success' //      burn_complete
      ]
    })

    const stages: BurnProgress[] = []
    const device = new Device(fake.transport, { timeout: 100 })
    const result = await flashImage(device, image, {
      wipe: WipeMode.All,
      reboot: true,
      timings: ZERO_TIMINGS,
      onProgress: (p) => stages.push(p)
    })

    expect(result).toBe(device) // never re-enumerated
    expect(fake.commands).toEqual([
      '    echo 1234',
      '    low_power',
      'bootloader_is_old',
      'upload mem 0xc8100228 normal 0x4',
      '    low_power',
      'disk_initial 3',
      'download store boot normal 8',
      'download get_status',
      'verify sha1sum abc123',
      'download store system normal 16',
      'download get_status',
      'save_setting',
      'burn_complete 1'
    ])

    // both partitions streamed over the bulk endpoint
    expect(fake.bulkSent.filter((b) => b.length === 8)).toHaveLength(1)
    expect(fake.bulkSent.filter((b) => b.length === 16)).toHaveLength(1)

    expect(stages.map((s) => s.stage)).toEqual([
      'erase-bootloader',
      'secure-check',
      'disk-initial',
      'partition', // boot: stage entry
      'partition', // boot: stream progress
      'verify',
      'partition', // system: stage entry
      'partition', // system: stream progress
      'finish'
    ])
  })
})

describe('flashImage from the BootROM (IPL -> SPL -> AMLC -> reacquire)', () => {
  test('downloads SPL, serves AMLC, reacquires, then flashes', async () => {
    const image = await openFixtureImage([
      { mainType: 'PARTITION', subType: 'boot', payload: new Uint8Array(8).fill(1) }
    ])

    const romFake = createBurnTransport({
      identifies: [IPL, IPL, IPL, IPL, IPL, IPL, SPL_AMLC, SPL_AMLC],
      readMemReplies: [new Uint8Array([0, 0, 0, 0])], // encrypt reg -> not secure
      bulkReplies: [
        amlcRequest(0x200, 0), // BL2 asks for the first 512 bytes of U-Boot
        asciiBytes('OKAY', 16), // data chunk ack
        asciiBytes('OKAY', 16), // AMLS ack
        amlcRequest(0x200, 0) //  repeated request -> BL2 done
      ]
    })

    const tplFake = createBurnTransport({
      identifies: [TPL],
      bulkReplies: [
        'success', //     low_power
        'success', //     disk_initial
        asciiBytes('OK!!', 0x200), // boot media ack
        'success', //     download get_status
        'success', //     save_setting
        'success' //      burn_complete
      ]
    })

    const romDevice = new Device(romFake.transport, { timeout: 100 })
    const tplDevice = new Device(tplFake.transport, { timeout: 100 })
    const reacquire = vi.fn().mockResolvedValue(tplDevice)

    const result = await flashImage(romDevice, image, { timings: ZERO_TIMINGS, reacquire })

    expect(reacquire).toHaveBeenCalledTimes(1)
    expect(result).toBe(tplDevice)

    // ROM side: PLL regs written, DDR image loaded, run issued, AMLC served
    const romRequests = romFake.controlsOut.map((c) => c.request)
    expect(romRequests).toContain(Request.WRITE_MEM) // PLL regs
    expect(romRequests).toContain(Request.WR_LARGE_MEM) // DDR download
    expect(romRequests).toContain(Request.RUN_IN_ADDR)
    expect(romRequests).toContain(Request.GET_AMLC)
    expect(romRequests).toContain(Request.WRITE_AMLC)

    // the DDR image went to DDRLoad in one 64-byte block
    const ddrSetup = romFake.controlsOut.find((c) => c.request === Request.WR_LARGE_MEM)!
    expect(new DataView(ddrSetup.data!.buffer).getUint32(0, true)).toBe(0xd9000000)

    // the run call targets DDRRun with the keep-power flag (version 2.2 >= 0.9)
    const run = romFake.controlsOut.find((c) => c.request === Request.RUN_IN_ADDR)!
    expect(run.value).toBe(0xd900)
    expect(new DataView(run.data!.buffer).getUint32(0, true)).toBe(0xd9000010)

    // U-Boot's first 512 bytes were served over AMLC
    expect(romFake.bulkSent.some((b) => b.length === 0x200 && b[0] === 0xbb)).toBe(true)

    // TPL side finishes the burn (power off: burn_complete 3)
    expect(tplFake.commands).toEqual([
      '    low_power',
      'disk_initial 0',
      'download store boot normal 8',
      'download get_status',
      'save_setting',
      'burn_complete 3'
    ])
  })
})

describe('downloadFile respects a size limit smaller than the item', () => {
  test('streams exactly DDRSize bytes when it is unaligned to the block length', async () => {
    // 0x8300 isn't a multiple of the 0x1000 block length, so the last chunk
    // must clamp to the remaining budget
    const ddrConf = PLATFORM_CONF.replace('DDRSize:0', 'DDRSize:0x8300')
    const bigImage = await AmlImage.open(
      buildImage(2, [
        { mainType: 'conf', subType: 'platform', payload: asciiBytes(ddrConf) },
        { mainType: 'USB', subType: 'DDR', payload: new Uint8Array(0x9500).fill(0xdd) },
        { mainType: 'USB', subType: 'UBOOT', payload: new Uint8Array(0x400).fill(0xbb) },
        { mainType: 'PARTITION', subType: 'boot', payload: new Uint8Array(8).fill(1) }
      ])
    )

    const romFake = createBurnTransport({
      identifies: [IPL, IPL, IPL, IPL, IPL, IPL, SPL_AMLC, SPL_AMLC],
      readMemReplies: [new Uint8Array([0, 0, 0, 0])],
      bulkReplies: [
        amlcRequest(0x200, 0),
        asciiBytes('OKAY', 16),
        asciiBytes('OKAY', 16),
        amlcRequest(0x200, 0)
      ]
    })
    const tplFake = createBurnTransport({
      identifies: [TPL],
      bulkReplies: [
        'success',
        'success',
        asciiBytes('OK!!', 0x200),
        'success',
        'success',
        'success'
      ]
    })

    const romDevice = new Device(romFake.transport, { timeout: 100 })
    const tplDevice = new Device(tplFake.transport, { timeout: 100 })
    const reacquire = vi.fn().mockResolvedValue(tplDevice)

    await flashImage(romDevice, bigImage, { timings: ZERO_TIMINGS, reacquire })

    // DDR bytes are 0xdd, U-Boot (AMLC) 0xbb
    const ddrStreamed = romFake.bulkSent
      .filter((b) => b.length > 0 && b.every((x) => x === 0xdd))
      .reduce((sum, b) => sum + b.length, 0)
    expect(ddrStreamed).toBe(0x8300)
  })
})

describe('flashImage with the real install package (TPL start)', () => {
  test('streams every partition with the sizes from the item table', async () => {
    const image = await AmlImage.open(
      await openAsBlob(new URL('../aml_install_package.img', import.meta.url))
    )
    const flashed = image
      .items()
      .filter((item) => item.mainType === 'PARTITION' || item.mainType === 'dtb')

    const bulkReplies: (string | Uint8Array<ArrayBuffer>)[] = [
      'success', //     low_power (erase-bootloader step)
      'failed', //      bootloader_is_old -> "new", skip erase
      'success', //     upload mem (secure check)
      new Uint8Array([0, 0, 0, 0]), // encrypt reg value -> not secure
      'success', //     low_power
      'success' //      disk_initial
    ]
    for (const item of flashed) {
      for (let i = 0; i < Math.ceil(item.size / 0x10000); i++) {
        bulkReplies.push(asciiBytes('OK!!', 0x200))
      }
      bulkReplies.push('success') // download get_status
    }
    bulkReplies.push('success', 'success') // save_setting, burn_complete

    const fake = createBurnTransport({ identifies: [TPL], bulkReplies })
    const progress: BurnProgress[] = []
    const device = new Device(fake.transport, { timeout: 100 })
    await flashImage(device, image, {
      timings: ZERO_TIMINGS,
      onProgress: (p) => progress.push(p)
    })

    expect(fake.commands).toEqual([
      '    echo 1234',
      '    low_power',
      'bootloader_is_old',
      'upload mem 0xff800228 normal 0x4',
      '    low_power',
      'disk_initial 0',
      ...flashed.flatMap((item) => [
        item.mainType === 'dtb'
          ? `download mem dtb normal ${item.size}`
          : `download store ${item.subType} normal ${item.size}`,
        'download get_status'
      ]),
      'save_setting',
      'burn_complete 3'
    ])
    // a mis-sized item table (the 0x90 v1 stride bug) garbles these
    expect(fake.commands).toContain('download mem dtb normal 75848')
    expect(fake.commands).toContain('download store boot normal 16777216')
    expect(fake.commands).toContain('download store bootloader normal 1261424')

    // every partition byte went over the bulk endpoint
    const streamed = fake.bulkSent.reduce((sum, block) => sum + block.length, 0)
    expect(streamed).toBe(flashed.reduce((sum, item) => sum + item.size, 0))

    for (const p of progress) {
      if (p.bytesTransferred !== undefined && p.totalBytes !== undefined) {
        expect(p.bytesTransferred).toBeLessThanOrEqual(p.totalBytes)
      }
    }
  }, 30_000)
})

describe('flashImage password handling', () => {
  test('throws PasswordError when the board is locked and no password is given', async () => {
    const image = await openFixtureImage()
    const fake = createBurnTransport({
      identifies: [[2, 2, 0, 0, 1, 0, 0, 0]] // needPassword, not ok
    })

    await expect(
      flashImage(new Device(fake.transport, { timeout: 100 }), image, { timings: ZERO_TIMINGS })
    ).rejects.toThrow(PasswordError)
  })

  test('sends the password and throws if it does not unlock', async () => {
    const image = await openFixtureImage()
    const fake = createBurnTransport({
      identifies: [
        [2, 2, 0, 0, 1, 0, 0, 0],
        [2, 2, 0, 0, 1, 0, 0, 0] // still locked after sendPassword
      ]
    })

    await expect(
      flashImage(new Device(fake.transport, { timeout: 100 }), image, {
        timings: ZERO_TIMINGS,
        password: new Uint8Array([1, 2, 3, 4])
      })
    ).rejects.toThrow(/password check failed/)

    const passwordCall = fake.controlsOut.find((c) => c.request === Request.PASSWORD)
    expect([...passwordCall!.data!]).toEqual([1, 2, 3, 4])
  })
})

describe('flashImage input validation', () => {
  test('requires a platform config item', async () => {
    const image = await AmlImage.open(
      buildImage(2, [{ mainType: 'USB', subType: 'DDR', payload: new Uint8Array(64) }])
    )
    const fake = createBurnTransport({ identifies: [TPL] })

    await expect(
      flashImage(new Device(fake.transport, { timeout: 100 }), image, { timings: ZERO_TIMINGS })
    ).rejects.toThrow(AmlImageError)
  })

  test('requires the UBOOT item for a non-TPL device', async () => {
    const image = await AmlImage.open(
      buildImage(2, [
        { mainType: 'conf', subType: 'platform', payload: asciiBytes(PLATFORM_CONF) },
        { mainType: 'USB', subType: 'DDR', payload: new Uint8Array(64) }
      ])
    )
    const fake = createBurnTransport({
      identifies: [SPL_AMLC],
      bulkReplies: ['success'] // secure check is skipped at SPL stage
    })

    await expect(
      flashImage(new Device(fake.transport, { timeout: 100 }), image, {
        timings: ZERO_TIMINGS,
        noEraseBootloader: true
      })
    ).rejects.toThrow(/UBOOT item/)
  })
})

describe('flashImage erase-bootloader paths', () => {
  test('erases an old bootloader, tolerates the dropped reset reply, and reacquires', async () => {
    const image = await openFixtureImage()

    const oldFake = createBurnTransport({
      identifies: [TPL],
      bulkReplies: [
        'success', // low_power
        'success', // bootloader_is_old -> it is old
        'success' //  erase_bootloader
      ],
      failControlCommands: ['reset'] // device drops off the bus mid-reset
    })
    const newFake = createBurnTransport({
      identifies: [TPL],
      bulkReplies: [
        'success', //     upload mem (secure check)
        new Uint8Array([0, 0, 0, 0]), // encrypt reg value -> not secure
        'success', //     low_power
        'success', //     disk_initial
        'success', //     save_setting
        'success' //      burn_complete
      ]
    })

    const oldDevice = new Device(oldFake.transport, { timeout: 100 })
    const newDevice = new Device(newFake.transport, { timeout: 100 })
    const reacquire = vi.fn().mockResolvedValue(newDevice)

    const result = await flashImage(oldDevice, image, { timings: ZERO_TIMINGS, reacquire })

    expect(reacquire).toHaveBeenCalledTimes(1)
    expect(result).toBe(newDevice)
    expect(oldFake.commands).toEqual([
      '    echo 1234',
      '    low_power',
      'bootloader_is_old',
      'erase_bootloader',
      'reset'
    ])
    expect(newFake.commands).toEqual([
      'upload mem 0xc8100228 normal 0x4',
      '    low_power',
      'disk_initial 0',
      'save_setting',
      'burn_complete 3'
    ])
  })

  test('throws when the device refuses the reset', async () => {
    const image = await openFixtureImage()
    const fake = createBurnTransport({
      identifies: [TPL],
      bulkReplies: ['success', 'success', 'success', 'failed'] // reset refused
    })

    await expect(
      flashImage(new Device(fake.transport, { timeout: 100 }), image, { timings: ZERO_TIMINGS })
    ).rejects.toThrow(BulkCmdError)
  })

  test('rethrows a transfer error from the old-bootloader probe', async () => {
    const image = await openFixtureImage()
    const fake = createBurnTransport({
      identifies: [TPL],
      bulkReplies: ['success'], // low_power
      failControlCommands: ['bootloader_is_old']
    })

    await expect(
      flashImage(new Device(fake.transport, { timeout: 100 }), image, { timings: ZERO_TIMINGS })
    ).rejects.toThrow('device dropped off the bus')
  })

  test('throws on an invalid power state', async () => {
    const image = await openFixtureImage()
    const fake = createBurnTransport({
      identifies: [[2, 2, 0, 4, 0, 0, 0, 0]] // neither IPL nor TPL
    })

    await expect(
      flashImage(new Device(fake.transport, { timeout: 100 }), image, { timings: ZERO_TIMINGS })
    ).rejects.toThrow(/invalid power state/)
  })

  test('falls back to reacquireDevice when no reacquire callback is given', async () => {
    const image = await openFixtureImage()
    const fake = createBurnTransport({
      identifies: [TPL],
      bulkReplies: ['success', 'success', 'success', 'success'] // reset succeeds
    })

    // Node has no navigator.usb, so the default reacquireDevice throws
    await expect(
      flashImage(new Device(fake.transport, { timeout: 100 }), image, { timings: ZERO_TIMINGS })
    ).rejects.toThrow(/WebUSB is unavailable/)
  })
})

describe('flashImage secure-boot detection at IPL', () => {
  const conf = (lines: string) => `Platform:0x0811\nDDRLoad:0xd9000000\nDDRRun:0xd9000000\n${lines}`

  test('throws on an invalid encrypt register', async () => {
    const image = await openFixtureImage([], conf('Encrypt_reg:0xffffffff'))
    const fake = createBurnTransport({ identifies: [IPL] })

    await expect(
      flashImage(new Device(fake.transport, { timeout: 100 }), image, {
        timings: ZERO_TIMINGS,
        noEraseBootloader: true
      })
    ).rejects.toThrow(/invalid encrypt register/)
  })

  test('looks the encrypt register up by chip id', async () => {
    const image = await openFixtureImage(
      [],
      conf('Encrypt_reg:0\nEncrypt_reg1=0xc8100228\nenc_chip_id1:0x1234')
    )
    const fake = createBurnTransport({
      identifies: [IPL, IPL, TPL], // TPL after the check: skip SPL/U-Boot stages
      bulkReplies: [...chipIdBlocks(0x1234), 'success', 'success', 'success', 'success'],
      readMemReplies: [new Uint8Array([0, 0, 0, 0])] // encrypt reg -> not secure
    })

    const device = new Device(fake.transport, { timeout: 100 })
    await expect(
      flashImage(device, image, { timings: ZERO_TIMINGS, noEraseBootloader: true })
    ).resolves.toBe(device)

    const chipIdRead = fake.controlsOut.find((c) => c.request === Request.RD_LARGE_MEM)!
    expect(new DataView(chipIdRead.data!.buffer).getUint32(0, true)).toBe(0xd9040004)
    expect(fake.commands).toEqual([
      '    low_power',
      'disk_initial 0',
      'save_setting',
      'burn_complete 3'
    ])
  })

  test('matches the second chip id and rejects an unsupported SPL platform', async () => {
    const image = await openFixtureImage(
      [],
      `Platform:0x9999\nDDRLoad:0xd9000000\nDDRRun:0xd9000000\n` +
        'Encrypt_reg:0\nEncrypt_reg2=0xc8100228\nenc_chip_id1:0x1111\nenc_chip_id2:0x1234'
    )
    const fake = createBurnTransport({
      identifies: [IPL],
      bulkReplies: chipIdBlocks(0x1234),
      readMemReplies: [new Uint8Array([0, 0, 0, 0])]
    })

    await expect(
      flashImage(new Device(fake.transport, { timeout: 100 }), image, {
        timings: ZERO_TIMINGS,
        noEraseBootloader: true
      })
    ).rejects.toThrow(/platform 0x9999 not supported/)
  })

  test('throws when the chip id matches no configured register', async () => {
    const image = await openFixtureImage(
      [],
      conf('Encrypt_reg:0\nEncrypt_reg1=0xc8100228\nenc_chip_id1:0x1111\nenc_chip_id2:0x2222')
    )
    const fake = createBurnTransport({
      identifies: [IPL],
      bulkReplies: chipIdBlocks(0x1234) // matches neither chip id
    })

    await expect(
      flashImage(new Device(fake.transport, { timeout: 100 }), image, {
        timings: ZERO_TIMINGS,
        noEraseBootloader: true
      })
    ).rejects.toThrow(/cannot determine the encrypt register/)
  })
})

describe('flashImage AXG/GXL para-block path', () => {
  test('pushes U-Boot with large-memory writes and para blocks', async () => {
    const image = await openFixtureImage(
      [{ mainType: 'PARTITION', subType: 'boot', payload: new Uint8Array(8).fill(1) }],
      PARA_CONF
    )

    const romFake = createBurnTransport({
      identifies: [
        IPL, //           checkPassword
        IPL, //           isSecureBoot
        IPL, //           downloadSPL entry
        [0, 9, 0, 0], //  runInAddress(DDRRun): version 0.9 -> keep-power flag
        [2, 2, 0, 8], //  after SPL: BL2 up without AMLC -> run at bl2ParaAddr
        [0, 5, 0, 0], //  runInAddress(bl2ParaAddr): version 0.5 -> no flag
        IPL, //           downloadUboot entry -> large-memory push path
        IPL, //           re-identify after the U-Boot push -> DDR reload
        IPL, //           updateDdr -> runUboot at UbootRun
        IPL, //           runInAddress(UbootRun) version check
        IPL, //           updateDdr post-checkPara -> DDR reload again
        [2, 2, 0, 8] //   final runUboot -> run at bl2ParaAddr (repeats)
      ],
      readMemReplies: [new Uint8Array([0, 0, 0, 0])], // encrypt reg -> not secure
      bulkReplies: [paraBlock(), paraBlock()] // both checkPara read-backs
    })
    const tplFake = createBurnTransport({
      identifies: [TPL],
      bulkReplies: [
        'success', //     low_power
        'success', //     disk_initial
        asciiBytes('OK!!', 0x200), // boot media ack
        'success', //     download get_status
        'success', //     save_setting
        'success' //      burn_complete
      ]
    })

    const romDevice = new Device(romFake.transport, { timeout: 100 })
    const tplDevice = new Device(tplFake.transport, { timeout: 100 })
    const reacquire = vi.fn().mockResolvedValue(tplDevice)

    const result = await flashImage(romDevice, image, {
      timings: ZERO_TIMINGS,
      reacquire,
      noEraseBootloader: true
    })

    expect(reacquire).toHaveBeenCalledTimes(1)
    expect(result).toBe(tplDevice)

    // DDR x3, U-Boot, and three para blocks pushed over large-memory writes
    const writes = romFake.controlsOut
      .filter((c) => c.request === Request.WR_LARGE_MEM)
      .map((c) => {
        const view = new DataView(c.data!.buffer)
        return [view.getUint32(0, true), view.getUint32(4, true)]
      })
    expect(writes).toEqual([
      [0xd9000000, 64], //   DDR image
      [0xd9013800, 24], //   SPL para block
      [0x200c000, 0x400], // U-Boot image
      [0xd9000000, 64], //   DDR reload after the U-Boot push
      [0xd9013800, 100], //  updateDdr para block
      [0xd9000000, 64], //   DDR reload after updateDdr
      [0xd9013800, 36] //    final para block
    ])
    expect(romFake.bulkSent.map((b) => b.length)).toEqual([64, 24, 0x400, 64, 100, 64, 36])

    // both checkPara read-backs targeted the para address
    const reads = romFake.controlsOut
      .filter((c) => c.request === Request.RD_LARGE_MEM)
      .map((c) => new DataView(c.data!.buffer).getUint32(0, true))
    expect(reads).toEqual([0xd9013800, 0xd9013800])

    // run sequence: DDR init (flag), BL2 para (no flag: version 0.5), U-Boot, BL2 para
    const runs = romFake.controlsOut
      .filter((c) => c.request === Request.RUN_IN_ADDR)
      .map((c) => new DataView(c.data!.buffer).getUint32(0, true))
    expect(runs).toEqual([0xd9000010, 0xd9013800, 0xd9010010, 0xd9013810])

    expect(tplFake.commands).toEqual([
      '    low_power',
      'disk_initial 0',
      'download store boot normal 8',
      'download get_status',
      'save_setting',
      'burn_complete 3'
    ])
  })

  test('throws when the para block does not read back', async () => {
    const image = await openFixtureImage([], PARA_CONF)
    const fake = createBurnTransport({
      identifies: [IPL, IPL, IPL, [0, 9, 0, 0], IPL], // back at IPL after DDR init
      readMemReplies: [new Uint8Array([0, 0, 0, 0])],
      bulkReplies: [new Uint8Array(0x200)] // zero magic
    })

    await expect(
      flashImage(new Device(fake.transport, { timeout: 100 }), image, {
        timings: ZERO_TIMINGS,
        noEraseBootloader: true
      })
    ).rejects.toThrow(/failed to read back para block: 0x0/)
  })

  test('throws on an unexpected stage after SPL', async () => {
    const image = await openFixtureImage()
    const fake = createBurnTransport({
      identifies: [IPL, IPL, IPL, [0, 9, 0, 0], [9, 9, 9, 9]],
      readMemReplies: [new Uint8Array([0, 0, 0, 0])]
    })

    await expect(
      flashImage(new Device(fake.transport, { timeout: 100 }), image, {
        timings: ZERO_TIMINGS,
        noEraseBootloader: true
      })
    ).rejects.toThrow(/unexpected stage after SPL/)
  })

  test('throws on an unexpected stage entering the SPL download', async () => {
    const image = await openFixtureImage()
    const fake = createBurnTransport({
      identifies: [IPL, IPL, [2, 2, 0, 4, 0, 0, 0, 0]],
      readMemReplies: [new Uint8Array([0, 0, 0, 0])]
    })

    await expect(
      flashImage(new Device(fake.transport, { timeout: 100 }), image, {
        timings: ZERO_TIMINGS,
        noEraseBootloader: true
      })
    ).rejects.toThrow(/unexpected stage:/)
  })

  test('throws on an unexpected stage before U-Boot', async () => {
    const image = await openFixtureImage()
    const fake = createBurnTransport({
      identifies: [SPL_AMLC, SPL_AMLC, SPL_AMLC, [2, 2, 0, 4, 0, 0, 0, 0]]
    })

    await expect(
      flashImage(new Device(fake.transport, { timeout: 100 }), image, {
        timings: ZERO_TIMINGS,
        noEraseBootloader: true
      })
    ).rejects.toThrow(/unexpected stage before U-Boot/)
  })

  test('throws on a short read while streaming the DDR image', async () => {
    const image = await openFixtureImage()
    const ddr = image.itemGet('USB', 'DDR')!
    vi.spyOn(ddr, 'read')
      .mockResolvedValueOnce(new Uint8Array(32))
      .mockResolvedValue(new Uint8Array())

    const fake = createBurnTransport({
      identifies: [IPL],
      readMemReplies: [new Uint8Array([0, 0, 0, 0])]
    })

    const rejection = expect(
      flashImage(new Device(fake.transport, { timeout: 100 }), image, {
        timings: ZERO_TIMINGS,
        noEraseBootloader: true
      })
    ).rejects
    await rejection.toThrow(AmlImageError)
    await rejection.toThrow(/short read streaming DDR: 32 < 64/)
  })
})

describe('flashImage secure TPL flow', () => {
  test('swaps the dtb for meson1_ENC and tolerates a lost burn_complete reply', async () => {
    const image = await openFixtureImage([
      // downloadUboot resolves the (secure) boot item before its TPL early return
      { mainType: 'USB', subType: 'UBOOT_ENC', payload: new Uint8Array(64).fill(0xcc) },
      { mainType: 'dtb', subType: 'meson1', payload: new Uint8Array(24).fill(0x11) },
      { mainType: 'dtb', subType: 'meson1_ENC', payload: new Uint8Array(16).fill(0x22) }
    ])

    const fake = createBurnTransport({
      identifies: [TPL],
      bulkReplies: [
        'success', //     low_power (erase-bootloader step)
        'failed', //      bootloader_is_old -> "new", skip erase
        'success', //     upload mem (secure check)
        new Uint8Array([0x10, 0, 0, 0]), // encrypt reg value -> secure boot
        'success', //     low_power
        'success', //     disk_initial
        asciiBytes('OK!!', 0x200), // dtb media ack
        'success', //     download get_status
        'success' //      save_setting
      ],
      failControlCommands: ['burn_complete 3'] // reply lost mid-poweroff (swallowed)
    })

    const device = new Device(fake.transport, { timeout: 100 })
    await expect(flashImage(device, image, { timings: ZERO_TIMINGS })).resolves.toBe(device)

    expect(fake.commands).toEqual([
      '    echo 1234',
      '    low_power',
      'bootloader_is_old',
      'upload mem 0xc8100228 normal 0x4',
      '    low_power',
      'disk_initial 0',
      'download mem dtb normal 16', // the 16-byte ENC item, not the 24-byte plain one
      'download get_status',
      'save_setting',
      'burn_complete 3'
    ])
    expect(fake.bulkSent.filter((b) => b.length === 16 && b[0] === 0x22)).toHaveLength(1)
    expect(fake.bulkSent.some((b) => b[0] === 0x11)).toBe(false)
  })

  test('throws when the device explicitly refuses burn_complete', async () => {
    const image = await openFixtureImage()
    const fake = createBurnTransport({
      identifies: [TPL],
      bulkReplies: [
        'success', //     low_power (erase-bootloader step)
        'failed', //      bootloader_is_old -> "new", skip erase
        'success', //     upload mem (secure check)
        new Uint8Array([0, 0, 0, 0]), // encrypt reg value -> not secure
        'success', //     low_power
        'success', //     disk_initial
        'success', //     save_setting
        'failed' //       burn_complete refused
      ]
    })

    await expect(
      flashImage(new Device(fake.transport, { timeout: 100 }), image, { timings: ZERO_TIMINGS })
    ).rejects.toThrow(BulkCmdError)
  })
})
