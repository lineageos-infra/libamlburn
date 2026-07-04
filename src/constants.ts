export const VENDOR_AMLOGIC = 0x1b8e
export const PRODUCT_GX_CHIP = 0xc003
// ADNL-protocol devices (bulk-only, unsupported) enumerate as 0x1b8e:0xc004

export const DeviceFilters: USBDeviceFilter[] = [
  { vendorId: VENDOR_AMLOGIC, productId: PRODUCT_GX_CHIP }
]

/** Vendor control request codes (bRequest) */
export const Request = {
  WRITE_MEM: 0x01,
  READ_MEM: 0x02,
  FILL_MEM: 0x03,
  MODIFY_MEM: 0x04,
  RUN_IN_ADDR: 0x05,
  WRITE_AUX: 0x06,
  READ_AUX: 0x07,
  WR_LARGE_MEM: 0x11,
  RD_LARGE_MEM: 0x12,
  IDENTIFY_HOST: 0x20,
  TPL_CMD: 0x30,
  TPL_STAT: 0x31,
  WRITE_MEDIA: 0x32,
  READ_MEDIA: 0x33,
  BULKCMD: 0x34,
  PASSWORD: 0x35,
  NOP: 0x36,
  GET_AMLC: 0x50,
  WRITE_AMLC: 0x60
} as const

export const FLAG_KEEP_POWER_ON = 0x10

export const SIMPLE_MEMORY_CHUNK = 64
/** blockCount is carried in the 16-bit wIndex, capping blocks per WR/RD_LARGE_MEM transfer */
export const MAX_LARGE_BLOCK_COUNT = 65535

export const AMLC_AMLS_BLOCK_LENGTH = 0x200
export const AMLC_MAX_BLOCK_LENGTH = 0x4000
export const AMLC_MAX_TRANSFER_LENGTH = 65536

export const BULK_REPLY_LEN = 512
export const TPL_STAT_LEN = 0x40
/** A command's NUL-terminated length must stay under this (U-Boot's USB buffer) */
export const MAX_COMMAND_LENGTH = 128

export const WRITE_MEDIA_BLOCK_SIZE = 0x10000
export const DEFAULT_ACK_LEN = 0x200

export const CHECKSUM_ALG_NONE = 0x00ee
export const CHECKSUM_ALG_ADDSUM = 0x00ef
export const CHECKSUM_ALG_CRC32 = 0x00f0
