import { describe, expect, test } from 'vitest'
import { AmlImageError } from '../src/errors'
import { AmlImage, crc32 } from '../src/image'
import { buildImage, FixtureItem } from './fixtures'

// expected values generated with python's zlib.crc32
describe('crc32', () => {
  test('empty input', () => {
    expect(crc32(new Uint8Array())).toBe(0)
  })

  test('ascii vector', () => {
    const data = new Uint8Array([...'hello world'].map((c) => c.charCodeAt(0)))
    expect(crc32(data)).toBe(0x0d4a1185)
  })

  test('binary vector', () => {
    const data = new Uint8Array(512)
    for (let i = 0; i < data.length; i++) data[i] = i % 256
    expect(crc32(data)).toBe(0x1c613576)
  })
})

const FIXTURE_ITEMS: FixtureItem[] = [
  { mainType: 'conf', subType: 'platform', payload: new Uint8Array([0x50, 0x3a, 0x30]) },
  { mainType: 'USB', subType: 'DDR', payload: new Uint8Array(48).fill(0xdd) },
  {
    mainType: 'PARTITION',
    subType: 'boot',
    fileType: 0xfe,
    verify: 1,
    payload: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
  },
  {
    mainType: 'VERIFY',
    subType: 'boot',
    payload: new Uint8Array([...'sha1sum abc123'].map((c) => c.charCodeAt(0)))
  }
]

describe.each([1, 2] as const)('AmlImage v%i', (version) => {
  test('parses the item table', async () => {
    const image = await AmlImage.open(buildImage(version, FIXTURE_ITEMS))

    expect(image.version).toBe(version)
    expect(image.itemCount()).toBe(4)
    expect(image.itemCount('PARTITION')).toBe(1)

    const boot = image.itemRequire('PARTITION', 'boot')
    expect(boot.size).toBe(8)
    expect(boot.fileType).toBe('sparse')
    expect(boot.verify).toBe(true)

    const ddr = image.itemRequire('USB', 'DDR')
    expect(ddr.fileType).toBe('normal')
    expect(ddr.verify).toBe(false)
  })

  test('items read windowed payload bytes', async () => {
    const image = await AmlImage.open(buildImage(version, FIXTURE_ITEMS))
    const boot = image.itemRequire('PARTITION', 'boot')

    expect([...(await boot.read(0, boot.size))]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect([...(await boot.read(2, 3))]).toEqual([3, 4, 5])
    expect(boot.blob.size).toBe(8)
  })

  test('text items decode as UTF-8', async () => {
    const image = await AmlImage.open(buildImage(version, FIXTURE_ITEMS))
    await expect(image.itemRequire('VERIFY', 'boot').text()).resolves.toBe('sha1sum abc123')
  })

  test('verifies the crc when asked', async () => {
    await expect(
      AmlImage.open(buildImage(version, FIXTURE_ITEMS), { verifyCrc: true })
    ).resolves.toBeInstanceOf(AmlImage)

    await expect(
      AmlImage.open(buildImage(version, FIXTURE_ITEMS, true), { verifyCrc: true })
    ).rejects.toThrow(/crc mismatch/)
  })

  test('itemGet returns undefined for missing items, itemRequire throws', async () => {
    const image = await AmlImage.open(buildImage(version, FIXTURE_ITEMS))
    expect(image.itemGet('USB', 'UBOOT')).toBeUndefined()
    expect(() => image.itemRequire('USB', 'UBOOT')).toThrow(AmlImageError)
  })

  test('accepts a Blob source', async () => {
    const image = await AmlImage.open(new Blob([buildImage(version, FIXTURE_ITEMS)]))
    expect(image.itemCount()).toBe(4)
  })
})

describe('AmlImage error handling', () => {
  test('rejects a bad magic', async () => {
    const image = buildImage(1, [])
    new DataView(image.buffer).setUint32(8, 0x12345678, true)
    await expect(AmlImage.open(image)).rejects.toThrow(/bad magic/)
  })

  test('rejects an unknown version', async () => {
    const image = buildImage(1, [])
    new DataView(image.buffer).setUint32(4, 3, true)
    await expect(AmlImage.open(image)).rejects.toThrow(/unknown image version/)
  })

  test('rejects a truncated file', async () => {
    await expect(AmlImage.open(new Uint8Array(10))).rejects.toThrow(/too small/)
  })

  test('rejects a truncated item table', async () => {
    const image = buildImage(1, [])
    new DataView(image.buffer).setUint32(24, 5, true) // claims 5 items, has none
    await expect(AmlImage.open(image)).rejects.toThrow(/truncated item table/)
  })

  test('rejects an item that overruns the package (truncated download)', async () => {
    const full = buildImage(2, FIXTURE_ITEMS)
    const truncated = full.subarray(0, full.length - 4)
    await expect(AmlImage.open(truncated)).rejects.toThrow(/overruns the package/)
  })
})
