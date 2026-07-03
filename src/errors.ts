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
    readonly attempts: number
  ) {
    super(`media write failed at block ${seq} after ${attempts} attempts`)
  }
}

export class AmlcError extends AmlUsbError {}

export class PasswordError extends AmlUsbError {}

export class AmlImageError extends AmlUsbError {}
