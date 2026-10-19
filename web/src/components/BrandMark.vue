<script setup lang="ts">
withDefaults(defineProps<{
  size?: number;
}>(), { size: 18 });
</script>

<template>
  <span class="brand-mark">
    <svg :width="size" :height="size" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M3.2 5.2h11.6M3.2 9h8M3.2 12.8h10.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
    </svg>
  </span>
</template>
