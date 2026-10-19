<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue';
import AppIcon from './AppIcon.vue';

const props = withDefaults(defineProps<{
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
}>(), {
  message: '',
  confirmLabel: '确认',
  cancelLabel: '取消',
  danger: false,
  busy: false,
});

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();

function onKeydown(event: KeyboardEvent) {
  if (!props.open) return;
  if (event.key === 'Escape' && !props.busy) emit('cancel');
}

watch(() => props.open, (open) => {
  if (open) window.addEventListener('keydown', onKeydown);
  else window.removeEventListener('keydown', onKeydown);
}, { immediate: true });

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="confirm-layer">
        <div class="confirm-scrim" @click="!busy && emit('cancel')" />
        <section class="confirm-card glass" role="dialog" aria-modal="true" :aria-label="title">
          <div class="confirm-icon" :class="{ 'is-danger': danger }">
            <AppIcon :name="danger ? 'alert' : 'info'" :size="18" />
          </div>
          <h2 class="confirm-title">{{ title }}</h2>
          <p v-if="message" class="confirm-message">{{ message }}</p>
          <div class="confirm-actions">
            <button type="button" class="btn btn-secondary" :disabled="busy" @click="emit('cancel')">
              {{ cancelLabel }}
            </button>
            <button
              type="button"
              class="btn"
              :class="danger ? 'btn-danger' : 'btn-primary'"
              :disabled="busy"
              @click="emit('confirm')"
            >
              {{ busy ? '处理中…' : confirmLabel }}
            </button>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>
