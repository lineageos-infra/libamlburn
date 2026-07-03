/**
 * Additive checksum over little-endian 32-bit words, used by the AMLS trailer
 * and `writeMedia` (checksum algorithm 0x00ef, "addsum"). Ragged tails of
 * 3/2/1 bytes are read as zero-padded 24/16/8-bit values.
 */
export function amlsChecksum(data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let checksum = 0
  let offset = 0

  while (offset < data.length) {
    const left = data.length - offset
    let value: number
    if (left >= 4) {
      value = view.getUint32(offset, true)
    } else if (left === 3) {
      value = view.getUint16(offset, true) | (view.getUint8(offset + 2) << 16)
    } else if (left === 2) {
      value = view.getUint16(offset, true)
    } else {
      value = view.getUint8(offset)
    }
    checksum = (checksum + value) % 0x100000000
    offset += 4
  }

  return checksum
}
