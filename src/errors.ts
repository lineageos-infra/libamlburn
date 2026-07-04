export class AmlUsbError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

export class CommandError extends AmlUsbError {
  constructor(
    kind: string,
    readonly command: string,
    readonly response: string
  ) {
    super(`${kind} command '${command}' failed: '${response}'`)
  }
}

export class BulkCmdError extends CommandError {
  constructor(command: string, response: string) {
    super('bulk', command, response)
  }
}

export class TplCmdError extends CommandError {
  constructor(command: string, response: string) {
    super('TPL', command, response)
  }
}

export class MediaWriteError extends AmlUsbError {
  constructor(
    readonly seq: number,
    readonly attempts: number,
    options?: ErrorOptions
  ) {
    super(`media write failed at block ${seq} after ${attempts} attempts`, options)
  }
}

/**
 * The device re-enumerated and the browser dropped its WebUSB grant — spec
 * behavior for devices without a serial number, which Amlogic's burn-mode
 * gadgets lack. Recover by prompting the user with requestDevice() (requires
 * a user gesture) and passing the result back via FlashOptions.reacquire.
 */
export class ReacquireNeededError extends AmlUsbError {
  constructor() {
    super(
      'the WebUSB grant was dropped on re-enumeration (serial-less device); ' +
        'prompt the user with requestDevice() to reacquire it'
    )
  }
}

export class AmlcError extends AmlUsbError {}

export class PasswordError extends AmlUsbError {}

export class AmlImageError extends AmlUsbError {}
