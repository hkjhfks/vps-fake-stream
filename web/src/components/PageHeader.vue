<script setup lang="ts">
withDefaults(defineProps<{
  eyebrow?: string;
  title: string;
  subtitle?: string;
}>(), {
  eyebrow: '',
  subtitle: '',
});
</script>

<template>
  <header class="page-head">
    <div class="page-head-copy">
      <div v-if="eyebrow" class="eyebrow">{{ eyebrow }}</div>
      <h1 class="page-title">{{ title }}</h1>
      <p v-if="subtitle" class="page-sub">{{ subtitle }}</p>
    </div>
    <div v-if="$slots.actions" class="page-actions">
      <slot name="actions" />
    </div>
  </header>
</template>
