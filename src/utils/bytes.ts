/** Encode a string as raw ASCII bytes (one byte per char, no terminator). */
export function encodeAscii(text: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    bytes[i] = text.charCodeAt(i)
  }
  return bytes
}

/** Decode ASCII and strip everything from the first NUL. */
export function decodeCString(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0)
  const end = nul === -1 ? bytes.length : nul
  return new TextDecoder().decode(bytes.subarray(0, end))
}

/** Pack 32-bit values little-endian, zero-padding to `padTo` bytes. */
export function packUint32sLE(values: number[], padTo = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(Math.max(values.length * 4, padTo))
  const view = new DataView(bytes.buffer)
  values.forEach((value, i) => view.setUint32(i * 4, value, true))
  return bytes
}

/** Read a little-endian 32-bit value at `offset`. */
export function readUint32LE(bytes: Uint8Array, offset = 0): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true)
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
