<script setup lang="ts">
import { computed } from 'vue';
import paths, { type IconName } from './iconPaths';

const props = withDefaults(defineProps<{
  name: IconName;
  size?: number;
  strokeWidth?: number;
}>(), {
  size: 16,
  strokeWidth: 1.75,
});

const body = computed(() => paths[props.name] || paths.dot);
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="body"
  />
</template>
