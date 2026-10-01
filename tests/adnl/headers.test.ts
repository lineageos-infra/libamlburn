import { describe, expect, test } from 'vitest'
import {
  checkAdnlReply,
  hex8,
  parseCbw,
  parseDataOut,
  parseDownloadSize
} from '../../src/adnl/headers'
import { AdnlCmdError } from '../../src/errors'
import { asciiBytes } from '../fixtures'
import { cbwReply } from './fake'

describe('checkAdnlReply', () => {
  test('accepts the expected tag', () => {
    const reply = asciiBytes('OKAYextra')
    expect(checkAdnlReply('cmd', reply, 'OKAY')).toBe(reply)
  })

  test('rejects another tag with the reply text', () => {
    expect(() => checkAdnlReply('cmd', asciiBytes('FAILnope', 16), 'OKAY')).toThrow(
      "ADNL command 'cmd' failed: 'FAILnope'"
    )
  })

  test('rejects a reply shorter than a tag', () => {
    expect(() => checkAdnlReply('cmd', asciiBytes('OK'), 'OKAY')).toThrow(/too short reply/)
  })

  test('summarizes binary commands by size', () => {
    expect(() => checkAdnlReply(new Uint8Array(4), asciiBytes('FAIL'), 'OKAY')).toThrow(
      "'<4 bytes>'"
    )
  })
})

test('hex8 zero-pads to 8 hex digits', () => {
  expect(hex8(0x10000)).toBe('00010000')
  expect(hex8(0x4000)).toBe('00004000')
})

describe('parseCbw', () => {
  test('reads seq, size, offset and flags', () => {
    expect(parseCbw(cbwReply(3, 0x4000, 0x8000))).toEqual({
      seq: 3,
      size: 0x4000,
      offset: 0x8000,
      needChecksum: true,
      done: false,
      wait: false
    })
    expect(parseCbw(cbwReply(4, 0, 0, true)).done).toBe(true)
    expect(parseCbw(cbwReply(5, 0x4000, 0, false, { flags: 1 })).needChecksum).toBe(false)
  })

  test('reads a wait request', () => {
    const cbw = parseCbw(cbwReply(0, 0, 0, false, { requestType: 0xff }))
    expect(cbw.wait).toBe(true)
    expect(cbw.done).toBe(false)
  })

  test('rejects BL2 error codes and upload requests', () => {
    expect(() => parseCbw(cbwReply(0, 0, 0, false, { requestType: 2 }))).toThrow(/error 2/)
    expect(() => parseCbw(cbwReply(0, 0x10, 0, false, { flags: 0x80 }))).toThrow(/upload/)
  })

  test('rejects a reply without the AMLC magic', () => {
    expect(() => parseCbw(asciiBytes('OKAYXXXX', 32))).toThrow(AdnlCmdError)
  })
})

describe('parseDataOut', () => {
  test('reads hex size and offset', () => {
    expect(parseDataOut(asciiBytes('DATAOUT4000:10000', 64))).toEqual({
      size: 0x4000,
      offset: 0x10000
    })
  })

  test('accepts 0x-prefixed values, as real U-Boot sends', () => {
    expect(parseDataOut(asciiBytes('DATAOUT0x8600:0x0', 64))).toEqual({ size: 0x8600, offset: 0 })
  })

  test('rejects anything else', () => {
    expect(() => parseDataOut(asciiBytes('FAILbad', 16))).toThrow(AdnlCmdError)
  })
})

describe('parseDownloadSize', () => {
  test('parses hex and decimal like int(x, 0)', () => {
    expect(parseDownloadSize(asciiBytes('OKAY0x10000', 32))).toBe(0x10000)
    expect(parseDownloadSize(asciiBytes('OKAY65536', 32))).toBe(65536)
  })

  test('rejects garbage', () => {
    expect(() => parseDownloadSize(asciiBytes('OKAYzz', 32))).toThrow(AdnlCmdError)
  })
})
