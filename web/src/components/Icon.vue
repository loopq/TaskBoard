<script setup lang="ts">
const PATHS = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  flag: 'M5 21V4M5 4h12l-2.5 4L17 12H5',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  subtasks: 'M3 6l2 2 3-3M3 14l2 2 3-3M11 6.5h10M11 14.5h10M11 20h10',
  comment: 'M4 5h16v11H9l-4 4v-4H4z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9.5h.01',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  send: 'M4 12l16-8-6 16-2.5-6.5z',
} as const;
defineProps<{ name: keyof typeof PATHS; size?: number }>();
</script>

<template>
  <svg
    class="icon"
    :width="size ?? 16"
    :height="size ?? 16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="PATHS[name]" />
  </svg>
</template>
