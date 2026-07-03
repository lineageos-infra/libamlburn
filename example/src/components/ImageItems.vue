<script setup lang="ts">
import type { AmlImage } from 'libamlburn'

defineProps<{ image: AmlImage }>()

function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} B`
}
</script>

<template>
  <table class="items-table">
    <thead>
      <tr>
        <th>Main type</th>
        <th>Sub type</th>
        <th>File type</th>
        <th>Size</th>
        <th>Verify</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="item in image.items()" :key="`${item.mainType}:${item.subType}`">
        <td>{{ item.mainType }}</td>
        <td>{{ item.subType }}</td>
        <td>{{ item.fileType }}</td>
        <td>{{ formatSize(item.size) }}</td>
        <td>{{ item.verify ? 'yes' : '' }}</td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.items-table {
  border-collapse: collapse;
  width: 100%;
  margin-top: 0.75rem;
  font-size: 0.9rem;
}

.items-table th,
.items-table td {
  padding: 0.4rem 0.75rem;
  text-align: left;
}

.items-table th {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.6;
  border-bottom: 2px solid var(--border);
}

.items-table td {
  border-bottom: 1px solid var(--border);
}

.items-table tbody tr:hover {
  background-color: var(--surface);
}
</style>
