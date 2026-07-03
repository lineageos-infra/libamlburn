/** A binary image to stream to the device. Uint8Arrays are wrapped in a Blob. */
export type ImageSource = Uint8Array<ArrayBuffer> | Blob

/** Normalize an {@link ImageSource} to a Blob, which slices lazily without copying. */
export function asBlob(source: ImageSource): Blob {
  return source instanceof Blob ? source : new Blob([source])
}

export async function readBlob(
  blob: Blob,
  offset: number,
  length: number
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())
}
