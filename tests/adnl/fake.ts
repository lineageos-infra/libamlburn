import { UsbTransport } from '../../src/transport'
import { asciiBytes } from '../fixtures'

export type Reply = string | Uint8Array<ArrayBuffer>

/**
 * Decide the device's replies to one bulk OUT transfer: none (raw data the
 * device just absorbs), one, or several (busy INFO replies before OKAY).
 */
export type Responder = (sent: Uint8Array, text: string | undefined) => Reply | Reply[] | undefined

function printable(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0 || bytes.length > 256) return undefined
  for (const b of bytes) if (b < 0x20 || b > 0x7e) return undefined
  return String.fromCharCode(...bytes)
}

/** A bulk-only transport whose replies come from a responder function. */
export function createAdnlTransport(respond: Responder) {
  const sent: Uint8Array[] = []
  const commands: string[] = []
  const replies: Uint8Array<ArrayBuffer>[] = []

  const transport = {
    connect: () => Promise.resolve(),
    controlOut: () => Promise.reject(new Error('ADNL uses no control transfers')),
    controlIn: () => Promise.reject(new Error('ADNL uses no control transfers')),
    bulkOut: (data: Uint8Array<ArrayBuffer>) => {
      sent.push(data.slice())
      const text = printable(data)
      if (text !== undefined) commands.push(text)
      const reply = respond(data, text)
      for (const r of reply === undefined ? [] : Array.isArray(reply) ? reply : [reply]) {
        replies.push(typeof r === 'string' ? asciiBytes(r) : r)
      }
      return Promise.resolve()
    },
    bulkIn: () => {
      const reply = replies.shift()
      if (!reply) return Promise.reject(new Error('no ADNL reply pending'))
      return Promise.resolve(reply)
    },
    close: () => Promise.resolve(),
    onDisconnect: () => {}
  } satisfies UsbTransport

  return { transport, sent, commands }
}

/** `OKAY` + identify payload: protocol, minor, stage at byte 7, chipinfo page map at 11 */
export function identifyReply(
  stage: number,
  protocolType = 5,
  pagesMap = 0
): Uint8Array<ArrayBuffer> {
  const reply = asciiBytes('OKAY', 16)
  reply[4] = protocolType
  reply[5] = 1
  reply[7] = stage
  reply[11] = pagesMap
  return reply
}

/** `OKAY` + a chipinfo-1 page carrying the SoC family (0x4) and FEAT (0x24) */
export function chipInfo1Reply(family: number, feat: number): Uint8Array<ArrayBuffer> {
  const reply = asciiBytes('OKAY', 4 + 64)
  const view = new DataView(reply.buffer)
  view.setUint32(4 + 0x4, family, true)
  view.setUint32(4 + 0x24, feat, true)
  return reply
}

/** `OKAY` + a CBW: `AMLC` magic, seq, size, offset, flags, request type (1 = done) */
export function cbwReply(
  seq: number,
  size: number,
  offset: number,
  done = false,
  { flags = 0, requestType = done ? 1 : 0 } = {}
) {
  const reply = asciiBytes('OKAYAMLC', 32)
  const view = new DataView(reply.buffer)
  view.setUint32(8, seq, true)
  view.setUint32(12, size, true)
  view.setUint32(16, offset, true)
  reply[20] = flags
  reply[21] = requestType
  return reply
}

export function checksumBytes(sum: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, sum, true)
  return bytes
}
