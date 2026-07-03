import { describe, expect, test, vi } from 'vitest'
import { Request } from '../../src/constants'
import { Device } from '../../src/device'
import { AmlImageError, PasswordError } from '../../src/errors'
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
        commands.push(trimNulls(data))
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

const IPL = [2, 2, 0, 0, 0, 0, 0, 0]
const SPL_AMLC = [2, 2, 1, 8, 0, 0, 0, 0]
const TPL = [0, 9, 0, 16, 0, 0, 0, 0]

async function openFixtureImage(extraItems: FixtureItem[] = []) {
  return AmlImage.open(
    buildImage(2, [
      { mainType: 'conf', subType: 'platform', payload: asciiBytes(PLATFORM_CONF) },
      { mainType: 'USB', subType: 'DDR', payload: new Uint8Array(64).fill(0xdd) },
      { mainType: 'USB', subType: 'UBOOT', payload: new Uint8Array(0x400).fill(0xbb) },
      ...extraItems
    ])
  )
}

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
