import { crc32 } from '../src/image'

export type FixtureItem = {
  mainType: string
  subType: string
  fileType?: number
  verify?: number
  payload: Uint8Array
}

/** Assemble a minimal but structurally correct Amlogic upgrade package. */
export function buildImage(version: 1 | 2, items: FixtureItem[], corruptCrc = false) {
  const itemSize = version === 1 ? 0x90 : 0x240
  const typeSize = version === 1 ? 32 : 256
  const headerSize = 64

  const tableEnd = headerSize + items.length * itemSize
  const totalSize = tableEnd + items.reduce((sum, item) => sum + item.payload.length, 0)
  const image = new Uint8Array(totalSize)
  const view = new DataView(image.buffer)

  view.setUint32(4, version, true)
  view.setUint32(8, 0x27b51956, true)
  view.setBigUint64(12, BigInt(totalSize), true)
  view.setUint32(24, items.length, true)

  let payloadOffset = tableEnd
  items.forEach((item, i) => {
    const base = headerSize + i * itemSize
    view.setUint32(base, i, true) // id
    view.setUint32(base + 4, item.fileType ?? 0, true)
    view.setBigUint64(base + 0x10, BigInt(payloadOffset), true) // offset in image
    view.setBigUint64(base + 0x18, BigInt(item.payload.length), true) // size
    image.set(
      [...item.mainType].map((c) => c.charCodeAt(0)),
      base + 0x20
    )
    image.set(
      [...item.subType].map((c) => c.charCodeAt(0)),
      base + 0x20 + typeSize
    )
    view.setUint32(base + 0x20 + 2 * typeSize, item.verify ?? 0, true)

    image.set(item.payload, payloadOffset)
    payloadOffset += item.payload.length
  })

  const storedCrc = corruptCrc ? 0xdeadbeef : (crc32(image.subarray(4)) ^ 0xffffffff) >>> 0
  view.setUint32(0, storedCrc, true)
  return image
}

export function asciiBytes(text: string, padTo = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(Math.max(text.length, padTo))
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
  return bytes
}
