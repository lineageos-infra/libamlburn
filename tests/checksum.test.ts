import { describe, expect, test } from 'vitest'
import { amlsChecksum } from '../src/utils/checksum'

// expected values generated with pyamlboot's _amlsChecksum
describe('amlsChecksum', () => {
  test('empty input', () => {
    expect(amlsChecksum(new Uint8Array())).toBe(0)
  })

  test('single word', () => {
    expect(amlsChecksum(new Uint8Array([1, 2, 3, 4]))).toBe(0x04030201)
  })

  test('exact multiple of 4', () => {
    expect(amlsChecksum(new Uint8Array(8).fill(0xff))).toBe(0xfffffffe)
  })

  test('ragged 3-byte tail', () => {
    expect(amlsChecksum(new Uint8Array([1, 2, 3, 4, 5, 6, 7]))).toBe(0x040a0806)
  })

  test('ragged 2-byte tail', () => {
    expect(amlsChecksum(new Uint8Array([0xab, 0xcd]))).toBe(0xcdab)
  })

  test('ragged 1-byte tail', () => {
    expect(amlsChecksum(new Uint8Array([0x7f]))).toBe(0x7f)
  })

  test('wraps around 2^32', () => {
    expect(amlsChecksum(new Uint8Array(12).fill(0xff))).toBe(0xfffffffd)
  })

  test('larger vector matches python', () => {
    const data = new Uint8Array(768)
    for (let i = 0; i < data.length; i++) data[i] = i % 256
    expect(amlsChecksum(data)).toBe(0x205f9e80)
  })

  test('respects byteOffset of subarray views', () => {
    const buffer = new Uint8Array([0xee, 0xee, 1, 2, 3, 4])
    expect(amlsChecksum(buffer.subarray(2))).toBe(0x04030201)
  })
})
