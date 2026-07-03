import { CHECKSUM_ALG_ADDSUM, MAX_COMMAND_LENGTH } from './constants'
import { AmlcError, AmlUsbError } from './errors'
import { decodeCString, encodeAscii } from './utils/bytes'

/** Split a 32-bit address into control transfer wValue/wIndex halves. */
export function splitAddress(address: number): { value: number; index: number } {
  return { value: address >>> 16, index: address & 0xffff }
}

/** Encode a NUL-terminated ASCII command, enforcing U-Boot's length limit. */
export function encodeCommand(command: string): Uint8Array<ArrayBuffer> {
  if (command.length + 1 >= MAX_COMMAND_LENGTH) {
    throw new AmlUsbError(`command must be shorter than ${MAX_COMMAND_LENGTH - 1} characters`)
  }
  const bytes = new Uint8Array(command.length + 1)
  bytes.set(encodeAscii(command))
  return bytes
}

/** 16-byte WR/RD_LARGE_MEM control payload: `<IIII>(address, length, 0, 0)` LE */
export function buildLargeMemoryHeader(address: number, length: number): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(16)
  const view = new DataView(header.buffer)
  view.setUint32(0, address, true)
  view.setUint32(4, length, true)
  return header
}

/** 32-byte WRITE_MEDIA control payload: `<IIIIHH>` zero-padded, addsum checksum alg */
export function buildWriteMediaHeader(
  retryTimes: number,
  dataLength: number,
  seq: number,
  checksum: number,
  ackLen: number
): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(32)
  const view = new DataView(header.buffer)
  view.setUint32(0, retryTimes, true)
  view.setUint32(4, dataLength, true)
  view.setUint32(8, seq, true)
  view.setUint32(12, checksum, true)
  view.setUint16(16, CHECKSUM_ALG_ADDSUM, true)
  view.setUint16(18, ackLen, true)
  return header
}

/** 16-byte AMLS trailer header: `<4sBBBBII>('AMLS', seq, 0, 0, 0, checksum, 0)` */
export function buildAmlsHeader(seq: number, checksum: number): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(16)
  header.set([0x41, 0x4d, 0x4c, 0x53]) // 'AMLS'
  header[4] = seq
  new DataView(header.buffer).setUint32(8, checksum, true)
  return header
}

/** Parse a 512-byte AMLC data request block: tag at 0, dataSize at 8, offset at 12 (LE). */
export function parseAmlcRequest(block: Uint8Array): { length: number; offset: number } {
  if (block.length < 16 || !startsWithAscii(block, 'AMLC')) {
    throw new AmlcError(`invalid AMLC request: '${trimNulls(block.slice(0, 16))}'`)
  }
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength)
  return { length: view.getUint32(8, true), offset: view.getUint32(12, true) }
}

/** 16-byte `OKAY` ack packet for AMLC requests. */
export function buildOkayPacket(): Uint8Array<ArrayBuffer> {
  const packet = new Uint8Array(16)
  packet.set([0x4f, 0x4b, 0x41, 0x59]) // 'OKAY'
  return packet
}

export function startsWithAscii(bytes: Uint8Array, text: string): boolean {
  if (bytes.length < text.length) return false
  for (let i = 0; i < text.length; i++) {
    if (bytes[i] !== text.charCodeAt(i)) return false
  }
  return true
}

/** Decode ASCII and strip everything from the first NUL. */
export function trimNulls(bytes: Uint8Array): string {
  return decodeCString(bytes)
}
