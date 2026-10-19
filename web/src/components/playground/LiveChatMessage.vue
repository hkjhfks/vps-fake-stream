<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue';
import { usePlaygroundLive } from '@/composables/usePlaygroundLive';
import type { Metrics } from './types';

defineProps<{
  model: string;
  metrics: Metrics;
}>();

const emit = defineEmits<{
  stop: [];
}>();

const { content } = usePlaygroundLive();
</script>

<template>
  <div class="msg">
    <span class="msg-avatar"><AppIcon name="waveform" :size="13" /></span>
    <div class="msg-main">
      <div class="msg-meta">
        <strong>FakeStream</strong>
        <span>{{ model }}</span>
        <span class="pill pill-green">流式</span>
      </div>

      <div class="msg-content streaming-text">
        {{ content || '正在等待上游…' }}<span class="typing-caret" />
      </div>

      <div class="stream-status">
        <span class="status-dot is-live" />
        正在生成 · 已收到 {{ metrics.chunks }} 块
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          style="margin-left:auto;height:24px;padding:0 8px;font-size:9px;"
          @click="emit('stop')"
        >
          <AppIcon name="stop" :size="10" /> 停止
        </button>
      </div>
    </div>
  </div>
</template>
