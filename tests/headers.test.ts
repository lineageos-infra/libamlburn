import { describe, expect, test } from 'vitest'
import { AmlcError, AmlUsbError } from '../src/errors'
import {
  buildAmlsHeader,
  buildLargeMemoryHeader,
  buildOkayPacket,
  buildWriteMediaHeader,
  encodeCommand,
  parseAmlcRequest,
  splitAddress,
  startsWithAscii,
  trimNulls
} from '../src/headers'

describe('splitAddress', () => {
  test('splits into wValue/wIndex halves', () => {
    expect(splitAddress(0xd9000010)).toEqual({ value: 0xd900, index: 0x0010 })
    expect(splitAddress(0x0200c000)).toEqual({ value: 0x0200, index: 0xc000 })
    expect(splitAddress(0)).toEqual({ value: 0, index: 0 })
  })
})

describe('encodeCommand', () => {
  test('appends a NUL terminator', () => {
    expect(encodeCommand('nop')).toEqual(new Uint8Array([0x6e, 0x6f, 0x70, 0]))
  })

  test('rejects commands at the 128-byte U-Boot limit', () => {
    expect(encodeCommand('x'.repeat(126))).toHaveLength(127)
    expect(() => encodeCommand('x'.repeat(127))).toThrow(AmlUsbError)
  })
})

describe('buildLargeMemoryHeader', () => {
  test('packs <IIII>(address, length, 0, 0) LE', () => {
    const header = buildLargeMemoryHeader(0xd9000000, 0x10000)
    expect(header).toHaveLength(16)
    const view = new DataView(header.buffer)
    expect(view.getUint32(0, true)).toBe(0xd9000000)
    expect(view.getUint32(4, true)).toBe(0x10000)
    expect(view.getUint32(8, true)).toBe(0)
    expect(view.getUint32(12, true)).toBe(0)
  })
})

describe('buildWriteMediaHeader', () => {
  test('packs <IIIIHH> zero-padded to 32 bytes', () => {
    const header = buildWriteMediaHeader(2, 0x10000, 7, 0xdeadbeef, 0x200)
    expect(header).toHaveLength(32)
    const view = new DataView(header.buffer)
    expect(view.getUint32(0, true)).toBe(2) // retryTimes
    expect(view.getUint32(4, true)).toBe(0x10000) // data length
    expect(view.getUint32(8, true)).toBe(7) // seq
    expect(view.getUint32(12, true)).toBe(0xdeadbeef) // checksum
    expect(view.getUint16(16, true)).toBe(0x00ef) // addsum algorithm
    expect(view.getUint16(18, true)).toBe(0x200) // ackLen
    expect(header.slice(20)).toEqual(new Uint8Array(12))
  })
})

describe('buildAmlsHeader', () => {
  test("packs <4sBBBBII>('AMLS', seq, 0, 0, 0, checksum, 0)", () => {
    const header = buildAmlsHeader(3, 0x12345678)
    expect(header).toHaveLength(16)
    expect(trimNulls(header)).toBe('AMLS')
    expect(header[4]).toBe(3)
    const view = new DataView(header.buffer)
    expect(view.getUint32(8, true)).toBe(0x12345678)
    expect(view.getUint32(12, true)).toBe(0)
  })
})

describe('parseAmlcRequest', () => {
  const request = (tag: string, length: number, offset: number) => {
    const block = new Uint8Array(512)
    block.set([...tag].map((c) => c.charCodeAt(0)))
    const view = new DataView(block.buffer)
    view.setUint32(8, length, true)
    view.setUint32(12, offset, true)
    return block
  }

  test('parses length and offset', () => {
    expect(parseAmlcRequest(request('AMLC', 0x10000, 0x200))).toEqual({
      length: 0x10000,
      offset: 0x200
    })
  })

  test('rejects a bad tag', () => {
    expect(() => parseAmlcRequest(request('JUNK', 1, 2))).toThrow(AmlcError)
    expect(() => parseAmlcRequest(new Uint8Array(4))).toThrow(AmlcError)
  })
})

describe('buildOkayPacket', () => {
  test("is 16 bytes of 'OKAY' + zeros", () => {
    const packet = buildOkayPacket()
    expect(packet).toHaveLength(16)
    expect(startsWithAscii(packet, 'OKAY')).toBe(true)
    expect(packet.slice(4)).toEqual(new Uint8Array(12))
  })
})

describe('ascii helpers', () => {
  test('startsWithAscii', () => {
    const bytes = new Uint8Array([0x4f, 0x4b, 0x21, 0x21, 0])
    expect(startsWithAscii(bytes, 'OK!!')).toBe(true)
    expect(startsWithAscii(bytes, 'OKAY')).toBe(false)
    expect(startsWithAscii(new Uint8Array([0x4f]), 'OKAY')).toBe(false)
  })

  test('trimNulls stops at the first NUL', () => {
    expect(
      trimNulls(new Uint8Array([0x73, 0x75, 0x63, 0x63, 0x65, 0x73, 0x73, 0, 0])).toString()
    ).toBe('success')
    expect(trimNulls(new Uint8Array([0, 0x61]))).toBe('')
    expect(trimNulls(new Uint8Array([0x61, 0x62]))).toBe('ab')
  })
})
