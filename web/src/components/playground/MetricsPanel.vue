<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import type { Metrics } from './types';

const props = defineProps<{
  metrics: Metrics;
  stream: boolean;
}>();

const emit = defineEmits<{
  copyRequestId: [];
  openLogs: [];
}>();

const showRaw = ref(false);

watch(() => props.metrics.runId, () => {
  showRaw.value = false;
});

function formatSeconds(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return `${(ms / 1000).toFixed(2)} s`;
}

const ttfbSeconds = computed(() => (props.metrics.ttft === null ? '—' : (props.metrics.ttft / 1000).toFixed(2)));
const totalSeconds = computed(() => (props.metrics.total === null ? '—' : (props.metrics.total / 1000).toFixed(2)));

const ttfbPct = computed(() => {
  if (!props.metrics.total || props.metrics.ttft === null) return 0;
  return Math.min(100, Math.max(2, (props.metrics.ttft / props.metrics.total) * 100));
});

const chunkBars = computed(() => {
  const sizes = props.metrics.chunkSizes.slice(-24);
  const max = Math.max(...sizes, 1);
  return sizes.map((size) => Math.max(10, Math.round((size / max) * 100)));
});

const rawEventsText = computed(() => {
  if (!props.metrics.rawEvents.length) return '还没有收到 SSE 事件。';
  return props.metrics.rawEvents.map((event) => `+${event.at}ms  ${JSON.stringify(event.data)}`).join('\n');
});

const statusLabel = computed(() => (
  props.metrics.streaming ? '流式生成中' : props.metrics.aborted ? '已停止' : '已完成'
));

const statusClass = computed(() => (
  props.metrics.streaming ? 'pill-green' : props.metrics.aborted ? 'pill-orange' : 'pill-blue'
));
</script>

<template>
  <aside class="metrics-panel glass" aria-label="本次请求指标">
    <div class="metrics-head">
      <strong>本次请求</strong>
      <span v-if="metrics.active" class="pill" :class="statusClass">{{ statusLabel }}</span>
    </div>

    <template v-if="metrics.active">
      <div class="metric-hero">
        <div class="metric-hero-label"><AppIcon name="zap" :size="10" /> 首块延迟</div>
        <div class="metric-hero-value">{{ ttfbSeconds }}<small v-if="metrics.ttft !== null">s</small></div>
        <div class="metric-hero-sub">
          <AppIcon name="checkCircle" :size="10" />
          {{ metrics.streaming ? '正在分块输出' : '首块已返回' }}
        </div>
      </div>

      <div class="metric-grid">
        <div class="metric-cell"><span>总耗时</span><strong>{{ totalSeconds }}<small v-if="metrics.total !== null">s</small></strong></div>
        <div class="metric-cell"><span>分块</span><strong>{{ metrics.chunks }}<small>块</small></strong></div>
        <div class="metric-cell"><span>输出字符</span><strong>{{ metrics.chars }}</strong></div>
        <div class="metric-cell"><span>Tokens</span><strong>{{ metrics.promptTokens ?? '—' }}<small>/ {{ metrics.completionTokens ?? '—' }}</small></strong></div>
      </div>

      <div class="waterfall">
        <div class="waterfall-title"><span>请求时间线</span><strong>{{ formatSeconds(metrics.total) }}</strong></div>
        <div class="waterfall-row">
          <span>请求</span>
          <div class="waterfall-track"><i class="waterfall-bar dim" style="left:0;width:3%" /></div>
          <span class="waterfall-ms">0 ms</span>
        </div>
        <div class="waterfall-row">
          <span>首块</span>
          <div class="waterfall-track"><i class="waterfall-bar" :style="{ left: '0%', width: `${ttfbPct}%` }" /></div>
          <span class="waterfall-ms">{{ formatSeconds(metrics.ttft) }}</span>
        </div>
        <div class="waterfall-row">
          <span>尾块</span>
          <div class="waterfall-track"><i class="waterfall-bar" :style="{ left: `${ttfbPct}%`, width: `${Math.max(0, 100 - ttfbPct)}%` }" /></div>
          <span class="waterfall-ms">{{ formatSeconds(metrics.total) }}</span>
        </div>
      </div>

      <div class="metrics-note">
        上游一次性返回，服务按配置拆分。首块延迟主要来自上游，不是分块器。
      </div>

      <div v-if="chunkBars.length" class="chunk-cadence">
        <div class="chunk-head"><span>分块节奏</span><span>{{ metrics.chunks }} 块</span></div>
        <div class="chunk-bars" aria-hidden="true">
          <i v-for="(height, index) in chunkBars" :key="index" :style="{ height: `${height}%` }" />
        </div>
      </div>

      <div class="param-list">
        <div><span>模型</span><strong>{{ metrics.model }}</strong></div>
        <div><span>温度</span><strong>{{ metrics.temperature }}</strong></div>
        <div><span>模式</span><strong>{{ stream ? '流式' : '非流式' }}</strong></div>
      </div>

      <div class="metrics-actions">
        <button type="button" class="metrics-action" @click="showRaw = !showRaw">
          <AppIcon name="terminal" :size="12" /> {{ showRaw ? '收起原始 SSE' : '查看原始 SSE' }}
          <AppIcon name="chevronRight" :size="10" class="chev" />
        </button>
        <button type="button" class="metrics-action" :disabled="!metrics.requestId" @click="emit('copyRequestId')">
          <AppIcon name="copy" :size="12" /> 复制请求 ID
          <AppIcon name="chevronRight" :size="10" class="chev" />
        </button>
        <button v-if="metrics.requestId" type="button" class="metrics-action" @click="emit('openLogs')">
          <AppIcon name="logs" :size="12" /> 在日志中查看
          <AppIcon name="chevronRight" :size="10" class="chev" />
        </button>
      </div>

      <div v-if="showRaw" class="raw-events-wrap">
        <pre class="raw-events">{{ rawEventsText }}</pre>
      </div>
    </template>

    <div v-else class="metrics-empty">
      <div class="metrics-empty-icon"><AppIcon name="activity" :size="20" /></div>
      <strong>还没有请求</strong>
      <span>发送一条消息后，这里会显示首块延迟、分块节奏和 Token 用量。</span>
    </div>
  </aside>
</template>
