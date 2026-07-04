<script setup lang="ts">
import {
  AmlImage,
  flashImage,
  reacquireDevice,
  requestDevice,
  WipeMode,
  type BurnProgress,
  type Device,
  type DeviceInfo
} from 'libamlburn'
import { version as libamlburnVersion } from 'libamlburn/package.json'
import { computed, ref } from 'vue'
import ImageItems from './components/ImageItems.vue'

const connectedDevice = ref<Device>()
const deviceInfo = ref<DeviceInfo>()

const verboseLogging = ref(true)
const defaultTimeout = ref(15000)

const commandInput = ref('')
const commandLog = ref<string[]>([])

const imageFile = ref<File>()
const image = ref<AmlImage>()
const wipe = ref<WipeMode>(WipeMode.None)
const rebootAfter = ref(true)
const flashing = ref(false)
const burnProgress = ref<BurnProgress>()
const flashError = ref('')
const reconnectNeeded = ref(false)
let resolveReconnect: ((device: Device) => void) | undefined

const progressPercent = computed(() => {
  const p = burnProgress.value
  if (!p?.totalBytes) return undefined
  return Math.round(((p.bytesTransferred ?? 0) / p.totalBytes) * 100)
})

async function requestDeviceAccess() {
  const device = await requestDevice({
    logging: verboseLogging.value,
    timeout: defaultTimeout.value
  })
  await setupDevice(device)
}

async function setupDevice(device: Device) {
  await device.initialize()
  connectedDevice.value = device
  deviceInfo.value = await device.identify()
  watchDisconnect(device)
}

function watchDisconnect(device: Device) {
  device.onDisconnect(() => {
    // the device re-enumerates mid-flash; flashImage reacquires it itself
    if (!flashing.value) {
      connectedDevice.value = undefined
      deviceInfo.value = undefined
    }
  })
}

async function refreshInfo() {
  if (connectedDevice.value) {
    deviceInfo.value = await connectedDevice.value.identify()
  }
}

async function sendNop() {
  await connectedDevice.value?.nop()
  commandLog.value.push('> nop\nok')
}

async function runCommand() {
  const device = connectedDevice.value
  const command = commandInput.value.trim()
  if (!device || !command) return

  try {
    const reply = await device.checkBulkCmd(command)
    commandLog.value.push(`> ${command}\n${reply}`)
  } catch (error) {
    commandLog.value.push(`> ${command}\n${String(error)}`)
  }
  commandInput.value = ''
}

async function stageImageFile(event: Event) {
  imageFile.value = (event.target as HTMLInputElement).files?.[0]
  image.value = undefined
  flashError.value = ''
  if (imageFile.value) {
    try {
      image.value = await AmlImage.open(imageFile.value)
    } catch (error) {
      flashError.value = String(error)
    }
  }
}

/**
 * The device re-enumerates mid-flash, and U-Boot's gadget has no serial
 * number, so the browser usually forgets the WebUSB grant: try silently first,
 * then ask the user to re-pick the device (requestDevice needs a click).
 */
async function reacquire(): Promise<Device> {
  try {
    return await reacquireDevice(3000, {
      logging: verboseLogging.value,
      timeout: defaultTimeout.value
    })
  } catch {
    reconnectNeeded.value = true
    try {
      return await new Promise<Device>((resolve) => {
        resolveReconnect = resolve
      })
    } finally {
      reconnectNeeded.value = false
      resolveReconnect = undefined
    }
  }
}

async function reconnectDevice() {
  try {
    const device = await requestDevice({
      logging: verboseLogging.value,
      timeout: defaultTimeout.value
    })
    await device.initialize()
    resolveReconnect?.(device)
  } catch {
    // picker dismissed; keep the button so the user can retry
  }
}

async function flash() {
  const device = connectedDevice.value
  if (!device || !image.value) return

  flashing.value = true
  flashError.value = ''
  burnProgress.value = undefined
  let lastProgressUpdate = 0
  try {
    const finished = await flashImage(device, image.value, {
      wipe: wipe.value,
      reboot: rebootAfter.value,
      reacquire,
      onProgress: (p) => {
        // progress fires per 64 KiB block; rendering every event thrashes the UI
        const now = Date.now()
        const stageChanged =
          p.stage !== burnProgress.value?.stage || p.partition !== burnProgress.value?.partition
        if (stageChanged || p.bytesTransferred === p.totalBytes || now - lastProgressUpdate > 100) {
          lastProgressUpdate = now
          burnProgress.value = p
        }
      }
    })
    if (finished !== device) {
      // flashImage reacquired a new device handle; watch it too
      watchDisconnect(finished)
    }
    connectedDevice.value = finished
    try {
      deviceInfo.value = await finished.identify()
    } catch {
      // the device is usually rebooting or powering off at this point
    }
  } catch (error) {
    flashError.value = String(error)
  } finally {
    flashing.value = false
  }
}
</script>

<template>
  <header>
    <h1>libamlburn example</h1>
    <p>libamlburn version: {{ libamlburnVersion }}</p>
  </header>

  <fieldset class="connection-options">
    <legend>Connection options</legend>
    <div>
      <label>Verbose logging: </label>
      <input v-model="verboseLogging" type="checkbox" />
    </div>
    <div>
      <label>Transfer timeout: </label>
      <input v-model="defaultTimeout" type="number" />
    </div>
  </fieldset>

  <button @click="requestDeviceAccess">Request device access (WebUSB)</button>

  <section v-if="connectedDevice && deviceInfo">
    <div class="device-info">
      <span>
        firmware: {{ deviceInfo.toString() }}
        <span class="badge">{{ deviceInfo.stageName }}</span>
      </span>
      <button :disabled="flashing" @click="refreshInfo">Refresh</button>
      <button :disabled="flashing" @click="sendNop">NOP</button>
    </div>

    <fieldset class="console">
      <legend>Bulk command console (U-Boot only)</legend>
      <pre v-if="commandLog.length" class="console-log">{{ commandLog.join('\n') }}</pre>
      <form class="console-input" @submit.prevent="runCommand">
        <input v-model="commandInput" type="text" placeholder="printenv" />
        <button type="submit" :disabled="!commandInput.trim() || flashing">Run</button>
      </form>
    </fieldset>

    <fieldset class="flash">
      <legend>Flash an upgrade package</legend>
      <div class="flash-controls">
        <input type="file" accept=".img" @change="stageImageFile" />
        <label>
          Wipe:
          <select v-model.number="wipe">
            <option :value="0">none</option>
            <option :value="1">keep keys</option>
            <option :value="2">force keep keys</option>
            <option :value="3">all</option>
            <option :value="4">force all</option>
          </select>
        </label>
        <label> <input v-model="rebootAfter" type="checkbox" /> reboot after </label>
        <button :disabled="!image || flashing" @click="flash">
          {{ flashing ? 'Flashing…' : 'Flash' }}
        </button>
      </div>

      <image-items v-if="image" :image="image" />

      <div v-if="reconnectNeeded" class="reconnect">
        <span>The device reconnected as a new USB device and must be re-selected.</span>
        <button @click="reconnectDevice">Re-select device</button>
      </div>

      <div v-if="burnProgress" class="progress">
        <span>
          {{ burnProgress.stage }}
          <template v-if="burnProgress.partition">: {{ burnProgress.partition }}</template>
        </span>
        <progress v-if="progressPercent !== undefined" :value="progressPercent" max="100" />
        <span v-if="progressPercent !== undefined">{{ progressPercent }}%</span>
      </div>
      <p v-if="flashError" class="error">{{ flashError }}</p>
    </fieldset>
  </section>
</template>

<style>
:root {
  color-scheme: light dark;
  --border: color-mix(in srgb, currentColor 20%, transparent);
  --surface: color-mix(in srgb, currentColor 7%, transparent);
}

body {
  font-family: system-ui, sans-serif;
  max-width: 64rem;
  margin: 0 auto;
  padding: 1.5rem;
  line-height: 1.5;
}

h1 {
  font-size: 1.5rem;
  margin-bottom: 0.25rem;
}

button,
input[type='file']::file-selector-button {
  padding: 0.3rem 0.8rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background-color: var(--surface);
  font: inherit;
  font-size: 0.9rem;
  cursor: pointer;
}

button:enabled:hover,
input[type='file']::file-selector-button:hover {
  background-color: color-mix(in srgb, currentColor 14%, transparent);
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

input[type='number'],
input[type='text'],
select {
  padding: 0.2rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background-color: transparent;
  font: inherit;
  font-size: 0.9rem;
}

input[type='file'] {
  font-size: 0.85rem;
}

input[type='file']::file-selector-button {
  margin-right: 0.625rem;
}

fieldset {
  margin-top: 1rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}

.connection-options {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  width: fit-content;
  margin: 0 0 1rem;
}

.device-info {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 2rem;
}

.badge {
  border-radius: 1rem;
  padding: 0.15rem 0.7rem;
  font-size: 0.8rem;
  font-weight: 500;
  background-color: var(--surface);
}

.console-log {
  max-height: 16rem;
  overflow-y: auto;
  padding: 0.5rem;
  background-color: var(--surface);
  border-radius: 0.375rem;
  font-size: 0.85rem;
}

.console-input {
  display: flex;
  gap: 0.5rem;
}

.console-input input {
  flex: 1;
  font-family: monospace;
}

.flash-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.progress {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.75rem;
}

.progress progress {
  flex: 1;
}

.error {
  color: light-dark(#b91c1c, #f87171);
  margin: 0.5rem 0 0;
}

.reconnect {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.75rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid light-dark(#b45309, #f59e0b);
  border-radius: 0.375rem;
}
</style>
