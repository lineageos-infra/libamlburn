import { AmlImageError } from './errors'
import { asBlob, ImageSource, readBlob } from './utils/blob'
import { decodeCString } from './utils/bytes'

const HEADER_SIZE = 64
const MAGIC = 0x27b51956

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  CRC_TABLE[n] = c
}

/** zlib-compatible CRC-32, used for the package header checksum */
export function crc32(data: Uint8Array, seed = 0): number {
  let crc = ~seed >>> 0
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return ~crc >>> 0
}

/** verifyCrc reads the package in slices this large rather than all at once */
const CRC_CHUNK_SIZE = 4 * 1024 * 1024

const ITEM_SIZE = { 1: 0x80, 2: 0x240 } as const
const TYPE_FIELD_SIZE = { 1: 32, 2: 256 } as const

const FILE_TYPES: Record<number, string> = {
  0x000: 'normal',
  0x0fe: 'sparse',
  0x1fe: 'ubi',
  0x2fe: 'ubifs'
}

function readUint64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AmlImageError(`64-bit field at ${offset} exceeds Number.MAX_SAFE_INTEGER`)
  }
  return Number(value)
}

/** One file inside an Amlogic upgrade package. */
export class AmlImageItem {
  constructor(
    private readonly pkg: Blob,
    readonly id: number,
    readonly fileType: string,
    private readonly offsetInImg: number,
    readonly size: number,
    readonly mainType: string,
    readonly subType: string,
    readonly verify: boolean
  ) {}

  /** The item's bytes as a lazy zero-copy slice of the package. */
  get blob(): Blob {
    return this.pkg.slice(this.offsetInImg, this.offsetInImg + this.size)
  }

  /** Read a window of the item's bytes. */
  read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    return readBlob(this.blob, offset, length)
  }

  /** Read the whole item and decode it as UTF-8 (for conf/VERIFY text items). */
  async text(): Promise<string> {
    return new TextDecoder().decode(await this.read(0, this.size))
  }
}

/**
 * An Amlogic Upgrade Package (`aml_upgrade_package.img`), read lazily from a
 * Blob so multi-gigabyte packages are never loaded into memory.
 */
export class AmlImage {
  private constructor(
    readonly version: number,
    private readonly imageItems: AmlImageItem[]
  ) {}

  static async open(source: ImageSource, options?: { verifyCrc?: boolean }): Promise<AmlImage> {
    const blob = asBlob(source)
    if (blob.size < HEADER_SIZE) {
      throw new AmlImageError('image is too small to contain a header')
    }

    const header = await readBlob(blob, 0, HEADER_SIZE)
    const view = new DataView(header.buffer)
    const storedCrc = view.getUint32(0, true)
    const version = view.getUint32(4, true)
    const magic = view.getUint32(8, true)
    const itemCount = view.getUint32(24, true)

    if (magic !== MAGIC) {
      throw new AmlImageError(`bad magic 0x${magic.toString(16)}`)
    }
    if (version !== 1 && version !== 2) {
      throw new AmlImageError(`unknown image version ${version}`)
    }

    if (options?.verifyCrc) {
      // the stored value is ~crc32 of everything after the crc field; checksum
      // in chunks so multi-gigabyte packages are never fully materialized
      let running = 0
      for (let offset = 4; offset < blob.size; offset += CRC_CHUNK_SIZE) {
        const chunk = await readBlob(blob, offset, Math.min(CRC_CHUNK_SIZE, blob.size - offset))
        running = crc32(chunk, running)
      }
      const computed = (running ^ 0xffffffff) >>> 0
      if (computed !== storedCrc) {
        throw new AmlImageError(
          `crc mismatch: stored 0x${storedCrc.toString(16)}, computed 0x${computed.toString(16)}`
        )
      }
    }

    const itemSize = ITEM_SIZE[version]
    const typeSize = TYPE_FIELD_SIZE[version]
    const table = await readBlob(blob, HEADER_SIZE, itemCount * itemSize)
    if (table.length < itemCount * itemSize) {
      throw new AmlImageError('truncated item table')
    }

    const items: AmlImageItem[] = []
    for (let i = 0; i < itemCount; i++) {
      const entry = table.subarray(i * itemSize, (i + 1) * itemSize)
      const entryView = new DataView(entry.buffer, entry.byteOffset, entry.byteLength)
      const fileType = entryView.getUint32(4, true)
      const offsetInImg = readUint64(entryView, 0x10)
      const size = readUint64(entryView, 0x18)
      const mainType = decodeCString(entry.subarray(0x20, 0x20 + typeSize))
      const subType = decodeCString(entry.subarray(0x20 + typeSize, 0x20 + 2 * typeSize))
      // Blob.slice would silently clamp an overrunning item, streaming fewer
      // bytes than the burn flow promises the device
      if (offsetInImg + size > blob.size) {
        throw new AmlImageError(
          `item ${mainType}:${subType} overruns the package ` +
            `(${offsetInImg} + ${size} > ${blob.size}); is the image truncated?`
        )
      }
      items.push(
        new AmlImageItem(
          blob,
          entryView.getUint32(0, true),
          FILE_TYPES[fileType] ?? `0x${fileType.toString(16)}`,
          offsetInImg,
          size,
          mainType,
          subType,
          entryView.getUint32(0x20 + 2 * typeSize, true) !== 0
        )
      )
    }

    return new AmlImage(version, items)
  }

  items(filter?: { mainType?: string; subType?: string; fileType?: string }): AmlImageItem[] {
    return this.imageItems.filter(
      (item) =>
        (filter?.mainType === undefined || item.mainType === filter.mainType) &&
        (filter?.subType === undefined || item.subType === filter.subType) &&
        (filter?.fileType === undefined || item.fileType === filter.fileType)
    )
  }

  itemCount(mainType?: string): number {
    return this.items(mainType === undefined ? undefined : { mainType }).length
  }

  /** Find an item by type, or undefined if the package does not contain it. */
  itemGet(mainType: string, subType: string): AmlImageItem | undefined {
    return this.items({ mainType, subType })[0]
  }

  /** Find an item by type, throwing if the package does not contain it. */
  itemRequire(mainType: string, subType: string): AmlImageItem {
    const item = this.itemGet(mainType, subType)
    if (!item) {
      throw new AmlImageError(`item ${mainType}:${subType} not found`)
    }
    return item
  }
}
