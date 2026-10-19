<script setup lang="ts">
import AppIcon from './AppIcon.vue';
import { useToast } from '@/composables/useToast';

const { toasts, dismissToast } = useToast();
</script>

<template>
  <Teleport to="body">
    <div class="toast-stack" aria-live="polite" aria-atomic="false">
      <TransitionGroup name="toast">
        <div v-for="item in toasts" :key="item.id" class="toast-item" :class="`is-${item.kind}`">
          <span class="toast-icon">
            <AppIcon
              :name="item.kind === 'success' ? 'checkCircle' : item.kind === 'error' ? 'alert' : 'info'"
              :size="14"
            />
          </span>
          <span class="toast-message">{{ item.message }}</span>
          <button type="button" class="toast-close" aria-label="关闭提示" @click="dismissToast(item.id)">
            <AppIcon name="x" :size="12" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
