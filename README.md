# libamlburn

WebUSB library for communicating with Amlogic devices in USB boot mode (the legacy/Optimus
protocol, VID `1b8e` PID `c003`). A TypeScript port of [pyamlboot](https://github.com/superna9999/pyamlboot).

## Features

- ROM primitives: `identify`, memory read/write, `run`
- Large-memory streaming writes with programmable block length
- Arbitrary bulk string commands (`bulkCmd` — U-Boot command execution)
- Media (partition) streaming writes with per-block acks and checksums
- AMLC/AMLS BL2 → U-Boot streaming for G12A/G12B/SM1
- `AmlImage` — parse `aml_upgrade_package.img` firmware packages (v1 and v2) from a `Blob`
  without loading them into memory
- `flashImage` — the full Optimus burn flow (aml-flash-tool parity): SPL → U-Boot →
  `disk_initial` → per-partition flash + verify → `save_setting` → `burn_complete`

## Usage

```ts
import { AmlImage, flashImage, requestDevice } from 'libamlburn'

const device = await requestDevice()
await device.initialize()

console.log((await device.identify()).toString())

// run an arbitrary U-Boot command
const reply = await device.checkBulkCmd('printenv')

// flash a full upgrade package
const file = fileInput.files[0]
const image = await AmlImage.open(file)
await flashImage(device, image, {
  wipe: 0,
  reboot: true,
  onProgress: (p) => console.log(p.stage, p.partition, p.bytesTransferred, p.totalBytes)
})
```

## Caveats

- WebUSB is only available in Chromium-based browsers, over HTTPS (or localhost).
- On Linux, grant access to the device with a udev rule:

  ```
  SUBSYSTEM=="usb", ATTR{idVendor}=="1b8e", MODE="0666"
  ```

- The device resets and re-enumerates during a flash; `flashImage` reacquires it via
  `navigator.usb.getDevices()` (no extra permission prompt for an already-authorized device).
