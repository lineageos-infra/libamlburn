import { AdnlCmdError } from '../errors'
import { startsWithAscii, trimNulls } from '../headers'

/** Every ADNL reply opens with one of these 4-byte tags */
export type AdnlReplyTag = 'OKAY' | 'FAIL' | 'INFO' | 'DATA'

/** Describe a command for error messages; data payloads are summarized by size. */
export function describeCommand(command: string | Uint8Array): string {
  return typeof command === 'string' ? command : `<${command.length} bytes>`
}

/** Throw unless `reply` is at least a tag long and starts with `expect`. */
export function checkAdnlReply(
  command: string | Uint8Array,
  reply: Uint8Array,
  expect: AdnlReplyTag
): Uint8Array {
  if (reply.length < 4) {
    throw new AdnlCmdError(describeCommand(command), `too short reply: ${reply.length} bytes`)
  }
  if (!startsWithAscii(reply, expect)) {
    throw new AdnlCmdError(describeCommand(command), trimNulls(reply))
  }
  return reply
}

/** `%08x`, as the BootROM and BL2 expect for `download:` sizes */
export function hex8(value: number): string {
  return value.toString(16).padStart(8, '0')
}

/** A BL2 request for the next window of U-Boot (`getvar:cbw` reply). */
export type Cbw = {
  seq: number
  size: number
  offset: number
  needChecksum: boolean
  done: boolean
  /** BL2 is busy (e.g. handing over to BL2E); identify again and re-ask */
  wait: boolean
}

/**
 * Parse a `getvar:cbw` reply: `OKAY` + `AMLC` magic, seq, size, offset, flags
 * (bit 0 clear: checksum wanted; bit 7: upload), request type (0 data, 1 end,
 * 0xff wait), per the vendor's `usb_cmd_get_cbw`.
 */
export function parseCbw(reply: Uint8Array): Cbw {
  if (reply.length < 22 || !startsWithAscii(reply.subarray(4), 'AMLC')) {
    throw new AdnlCmdError('getvar:cbw', `unexpected CBW: '${trimNulls(reply.subarray(0, 8))}'`)
  }
  const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength)
  const flags = reply[20]!
  const requestType = reply[21]!
  if (requestType !== 0 && requestType !== 1 && requestType !== 0xff) {
    throw new AdnlCmdError('getvar:cbw', `BL2 reported error ${requestType}`)
  }
  if (requestType !== 0xff && flags & 0x80) {
    throw new AdnlCmdError('getvar:cbw', 'BL2 requested an upload, which is unsupported')
  }
  return {
    seq: view.getUint32(8, true),
    size: view.getUint32(12, true),
    offset: view.getUint32(16, true),
    needChecksum: (flags & 1) === 0,
    done: requestType === 1,
    wait: requestType === 0xff
  }
}

/** Parse an `mwrite` window request: `DATAOUT<hex size>:<hex offset>`, each optionally `0x`-prefixed. */
export function parseDataOut(reply: Uint8Array): { size: number; offset: number } {
  const text = trimNulls(reply)
  const match = /^DATAOUT(?:0x)?([0-9a-f]+):(?:0x)?([0-9a-f]+)/i.exec(text)
  if (!match) {
    throw new AdnlCmdError('mwrite:verify=addsum', text)
  }
  return { size: parseInt(match[1]!, 16), offset: parseInt(match[2]!, 16) }
}

/** Parse a `getvar:downloadsize` reply (`OKAY0x10000`), like Python's `int(x, 0)`. */
export function parseDownloadSize(reply: Uint8Array): number {
  const text = trimNulls(reply).slice(4).trim()
  let value = NaN
  if (/^0x[0-9a-f]+$/i.test(text)) value = parseInt(text.slice(2), 16)
  else if (/^\d+$/.test(text)) value = parseInt(text, 10)
  if (Number.isNaN(value)) {
    throw new AdnlCmdError('getvar:downloadsize', trimNulls(reply))
  }
  return value
}
