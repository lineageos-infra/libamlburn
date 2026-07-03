import { describe, expect, test } from 'vitest'
import { asBlob, readBlob } from '../src/utils/blob'

describe('asBlob', () => {
  test('wraps a Uint8Array', async () => {
    const blob = asBlob(new Uint8Array([1, 2, 3]))
    expect(blob.size).toBe(3)
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  test('passes a Blob through unchanged', () => {
    const blob = new Blob([new Uint8Array(4)])
    expect(asBlob(blob)).toBe(blob)
  })
})

describe('readBlob', () => {
  test('reads a window', async () => {
    const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4, 5])])
    expect(await readBlob(blob, 2, 3)).toEqual(new Uint8Array([2, 3, 4]))
  })

  test('clamps reads past the end', async () => {
    const blob = new Blob([new Uint8Array([0, 1, 2])])
    expect(await readBlob(blob, 2, 10)).toEqual(new Uint8Array([2]))
  })
})
