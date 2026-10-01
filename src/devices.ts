import type { AdnlDevice } from './adnl/device'
import { AmlUsbError } from './errors'
import { startsWithAscii } from './headers'
import { consoleLogger, Logger, LogLevel } from './logger'
import type { OptimusDevice } from './optimus/device'
import { UsbTransport, WebUsbTransport } from './transport'
import { delay } from './utils/timeout'

/** A device in USB burn mode; narrow on `protocol` for protocol-specific methods. */
export type Device = OptimusDevice | AdnlDevice

export type DeviceOptions = {
  /** whether to enable additional logging (basic logging is already enabled) */
  logging: boolean
  /** the number of milliseconds to time out after */
  timeout: number
  /** where to send log output; defaults to the console */
  logger?: Logger
}

export type Progress = {
  bytesTransferred: number
  totalBytes: number
}

export type ProgressCallback = (progress: Progress) => void

const DEFAULT_DEVICE_OPTIONS: DeviceOptions = {
  logging: false,
  timeout: 5000
}

function isUsbDevice(value: UsbTransport | USBDevice): value is USBDevice {
  return 'controlTransferIn' in value && typeof value.controlTransferIn === 'function'
}

/** Connection handling shared by the Optimus and ADNL protocol drivers. */
export abstract class BaseDevice {
  abstract readonly protocol: 'optimus' | 'adnl'

  transport: UsbTransport
  deviceOptions: DeviceOptions

  constructor(transport: UsbTransport | USBDevice, options?: Partial<DeviceOptions>) {
    this.transport = isUsbDevice(transport) ? new WebUsbTransport(transport) : transport
    this.deviceOptions = { ...DEFAULT_DEVICE_OPTIONS, ...options }
  }

  /** The underlying WebUSB device, when connected over WebUSB. */
  get usbDevice(): USBDevice | undefined {
    return this.transport instanceof WebUsbTransport ? this.transport.device : undefined
  }

  _log(level: LogLevel, ...data: unknown[]) {
    if (level === 'debug' && !this.deviceOptions.logging) return
    ;(this.deviceOptions.logger ?? consoleLogger)(level, ...data)
  }

  /** Open and claim the device */
  async initialize() {
    try {
      await this.transport.connect(this.deviceOptions.timeout)
    } catch (errorMsg) {
      this._log('debug', errorMsg)
      throw new AmlUsbError('Unable to open and claim device', { cause: errorMsg })
    }
  }

  async close() {
    try {
      await this.transport.close(this.deviceOptions.timeout)
    } catch (error) {
      throw new AmlUsbError('Unable to close device', { cause: error })
    }
  }

  onDisconnect(callback: () => void) {
    this.transport.onDisconnect(callback)
  }

  protected get timeout() {
    return this.deviceOptions.timeout
  }

  /**
   * Poll `read` through busy replies starting with `busyPrefix` (and transient
   * errors) until a real reply arrives or the deadline passes. The deadline is
   * checked before each busy pause, so a single busy reply always gets at
   * least one more poll even when the pause is as long as the timeout.
   */
  protected async pollThroughBusy(
    read: () => Promise<Uint8Array<ArrayBuffer>>,
    busyPrefix: string,
    timeout: number,
    busyRetryDelay: number,
    timeoutMessage: string
  ): Promise<Uint8Array<ArrayBuffer>> {
    const deadline = Date.now() + timeout
    for (;;) {
      let error: unknown
      try {
        const response = await read()
        if (!startsWithAscii(response, busyPrefix)) return response
      } catch (e) {
        error = e
      }
      if (Date.now() >= deadline) {
        if (error instanceof Error) throw error
        throw new AmlUsbError(timeoutMessage)
      }
      if (error === undefined) await delay(busyRetryDelay)
    }
  }
}
