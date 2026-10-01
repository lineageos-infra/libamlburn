import { describe, expect, test, vi } from 'vitest'
import { asBlob, prefetch, readBlob } from '../src/utils/blob'

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

describe('prefetch', () => {
  test('marks a rejection handled but still rejects when awaited', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const pending = prefetch(Promise.reject(new Error('read failed')))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).not.toHaveBeenCalled()
      await expect(pending).rejects.toThrow('read failed')
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})
