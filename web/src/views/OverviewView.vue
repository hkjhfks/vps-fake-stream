<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import AppIcon from '@/components/AppIcon.vue';
import PageHeader from '@/components/PageHeader.vue';
import { api, getErrorMessage } from '@/api/client';
import type { RequestLog } from '@/api/types';
import { useStatus } from '@/composables/useStatus';
import { useToast } from '@/composables/useToast';
import {
  copyText,
  formatCompact,
  formatLatency,
  formatTime,
  sourceLabel,
  statusKind,
} from '@/utils/format';

const router = useRouter();
const { showToast } = useToast();
const { status, loading: statusLoading, error: statusError, updatedAt, refresh: refreshStatus, ensure } = useStatus();

const logs = ref<RequestLog[]>([]);
const loadingLogs = ref(true);
const logsError = ref('');
const refreshing = ref(false);
let timer: number | null = null;

const origin = window.location.origin;
const statusOk = computed(() => status.value?.status === 'ok');
const upstream = computed(() => sourceLabel(status.value?.environment.upstream_format));
const upstreamUrl = computed(() => status.value?.environment.source_api_url || '—');
const version = computed(() => status.value?.version || '1.0.0');
const lastChecked = computed(() => updatedAt.value ? formatTime(updatedAt.value.toISOString()) : '—');

const stats = computed(() => {
  const list = logs.value;
  const count = list.length;
  const success = list.filter((log) => (log.status_code || 0) >= 200 && (log.status_code || 0) < 300).length;
  const latency = list.map((log) => Number(log.response_ms)).filter((value) => Number.isFinite(value));
  const sorted = [...latency].sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
  const avg = latency.length ? latency.reduce((sum, value) => sum + value, 0) / latency.length : 0;
  const prompt = list.reduce((sum, log) => sum + (Number(log.usage?.prompt_tokens) || 0), 0);
  const completion = list.reduce((sum, log) => sum + (Number(log.usage?.completion_tokens) || 0), 0);
  const totalTokens = list.reduce((sum, log) => {
    const usage = log.usage || {};
    return sum + (Number(usage.total_tokens) || (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0));
  }, 0);

  return {
    count,
    success,
    errors: count - success,
    successRate: count ? (success / count) * 100 : 0,
    avg,
    p95,
    prompt,
    completion,
    totalTokens,
  };
});

const recent = computed(() => logs.value.slice(0, 4));
const modelHint = computed(() => logs.value[0]?.model || 'gpt-4o-mini');
const errorCount = computed(() => stats.value.errors);

const curlExample = computed(() => [
  `curl ${origin}/v1/chat/completions \\`,
  '  -H "Content-Type: application/json" \\',
  `  -d '{"model":"${modelHint.value}","stream":true}'`,
].join('\n'));

async function loadLogs(showSpinner = false) {
  if (showSpinner) refreshing.value = true;
  logsError.value = '';
  try {
    const response = await api.logs.list(100);
    // null means 304 Not Modified: the cached rows are still current.
    if (response) logs.value = response.logs;
  } catch (error) {
    logsError.value = getErrorMessage(error);
  } finally {
    loadingLogs.value = false;
    refreshing.value = false;
  }
}

async function refreshAll(manual = false) {
  refreshing.value = true;
  await Promise.all([refreshStatus(), loadLogs()]);
  refreshing.value = false;
  if (manual) {
    // The toast is intentionally silent when the API is unavailable; the banner covers it.
  }
}

function openLog(log: RequestLog) {
  router.push({ name: 'logs', query: { request: log.id } });
}

async function copyEndpoint(value: string) {
  const ok = await copyText(value);
  showToast(ok ? '接口地址已复制' : '复制失败', ok ? 'success' : 'error');
}

onMounted(() => {
  ensure();
  loadLogs();
  timer = window.setInterval(() => {
    if (document.hidden) return;
    refreshStatus();
    loadLogs();
  }, 30_000);
});

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer);
});
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="控制台"
      title="概览"
      subtitle="服务状态、常用操作与接入信息。"
    >
      <template #actions>
        <span class="pill" :class="statusOk ? 'pill-green' : 'pill-gray'">
          <span class="status-dot" :class="statusOk ? 'is-live' : 'gray'" />
          {{ statusOk ? '运行中' : '状态未知' }}
        </span>
        <button
          type="button"
          class="icon-btn glass-btn"
          title="刷新状态"
          :disabled="refreshing || statusLoading"
          @click="refreshAll(true)"
        >
          <AppIcon name="refresh" :size="16" :class="{ 'is-spinning': refreshing || statusLoading }" />
        </button>
      </template>
    </PageHeader>

    <div v-if="statusError" class="inline-banner is-error">
      <AppIcon name="alert" :size="14" />
      <span>{{ statusError }}</span>
      <button type="button" class="btn btn-secondary btn-sm" @click="refreshAll(true)">重试</button>
    </div>

    <div class="stack">
      <section class="hero glass" aria-labelledby="heroTitle">
        <div class="hero-left">
          <div class="hero-eyebrow">
            <span class="status-dot" :class="statusOk ? 'is-live' : 'gray'" />
            当前状态
          </div>
          <div id="heroTitle" class="hero-title">{{ statusOk ? '服务运行中' : '状态获取中' }}</div>
          <div class="hero-url">{{ upstreamUrl }}</div>
          <div class="hero-meta">
            <span>{{ upstream }}</span>
            <span class="sep" />
            <span>配置热读取已开启</span>
            <span class="sep" />
            <span>最后检查 {{ lastChecked }}</span>
          </div>
        </div>
        <div class="hero-right">
          <div class="hero-metric"><span>上游模式</span><strong>{{ upstream }}</strong></div>
          <div class="hero-metric"><span>服务版本</span><strong>{{ version }}</strong></div>
          <div class="hero-metric"><span>控制台</span><strong>整站登录</strong></div>
          <div class="hero-metric"><span>配置热读取</span><strong>已开启</strong></div>
        </div>
      </section>

      <section class="action-grid" aria-label="常用操作">
        <button type="button" class="action-card card primary" @click="router.push({ name: 'settings' })">
          <span class="action-icon"><AppIcon name="sliders" :size="17" /></span>
          <span class="action-title">配置</span>
          <span class="action-desc">上游、密钥、流式参数与访问控制。</span>
          <span class="action-go">打开设置 <AppIcon name="arrowRight" :size="12" /></span>
        </button>
        <button type="button" class="action-card card" @click="router.push({ name: 'playground' })">
          <span class="action-icon"><AppIcon name="chat" :size="17" /></span>
          <span class="action-title">调试台</span>
          <span class="action-desc">发一条消息，验证当前上游与伪流式。</span>
          <span class="action-go">开始测试 <AppIcon name="arrowRight" :size="12" /></span>
        </button>
        <button type="button" class="action-card card" @click="router.push({ name: 'logs' })">
          <span class="action-icon"><AppIcon name="logs" :size="17" /></span>
          <span class="action-title">
            请求日志
            <span v-if="errorCount" class="pill pill-red" style="height:18px;padding:0 6px;font-size:8px;">
              {{ errorCount }} 条失败
            </span>
          </span>
          <span class="action-desc">最近请求、耗时、Tokens 与失败原因。</span>
          <span class="action-go">查看日志 <AppIcon name="arrowRight" :size="12" /></span>
        </button>
      </section>

      <section class="card stat-strip" aria-label="请求统计">
        <div class="stat">
          <div class="stat-label">最近请求</div>
          <div class="stat-value">{{ stats.count }}<small>条</small></div>
          <div class="stat-foot"><span>最近 100 条</span></div>
        </div>
        <div class="stat">
          <div class="stat-label">成功率</div>
          <div class="stat-value">{{ stats.successRate.toFixed(1) }}<small>%</small></div>
          <div class="stat-foot"><span :class="stats.errors ? 'down' : 'up'">{{ stats.errors }} 条失败</span></div>
        </div>
        <div class="stat">
          <div class="stat-label">平均耗时</div>
          <div class="stat-value">{{ formatLatency(stats.avg) }}</div>
          <div class="stat-foot"><span>P95 {{ formatLatency(stats.p95) }}</span></div>
        </div>
        <div class="stat">
          <div class="stat-label">总 Tokens</div>
          <div class="stat-value">{{ formatCompact(stats.totalTokens) }}</div>
          <div class="stat-foot"><span>输入 {{ formatCompact(stats.prompt) }} · 输出 {{ formatCompact(stats.completion) }}</span></div>
        </div>
      </section>

      <div class="overview-grid">
        <section class="card card-pad">
          <div class="card-head">
            <div>
              <h2 class="card-title">最近请求</h2>
              <p class="card-sub">最近 100 条中的最后 4 条</p>
            </div>
            <span v-if="stats.errors" class="pill pill-red">{{ stats.errors }} 条失败</span>
            <span v-else class="pill pill-green">全部成功</span>
          </div>

          <div v-if="loadingLogs" class="recent-list">
            <div v-for="index in 4" :key="index" class="recent-row skeleton-row">
              <span class="skeleton" style="width:54px;height:10px" />
              <span class="skeleton" style="width:140px;height:10px" />
              <span class="skeleton" style="width:32px;height:14px" />
              <span class="skeleton" style="width:40px;height:10px" />
            </div>
          </div>

          <div v-else-if="logsError" class="inline-banner is-error compact">
            <AppIcon name="alert" :size="13" />
            <span>{{ logsError }}</span>
            <button type="button" class="btn btn-secondary btn-sm" @click="loadLogs(true)">重试</button>
          </div>

          <div v-else-if="!recent.length" class="empty">
            <div class="empty-icon"><AppIcon name="logs" :size="19" /></div>
            <strong>还没有请求记录</strong>
            <span>去调试台发一条消息，这里就会出现日志。</span>
          </div>

          <div v-else class="recent-list">
            <button
              v-for="log in recent"
              :key="log.id"
              type="button"
              class="recent-row"
              @click="openLog(log)"
            >
              <span class="recent-time">{{ formatTime(log.created_at) }}</span>
              <span class="recent-model">{{ log.model || '未知模型' }}<span v-if="log.upstream_format">{{ sourceLabel(log.upstream_format) }}</span></span>
              <span class="status-code" :class="statusKind(log.status_code)">{{ log.status_code || '—' }}</span>
              <span class="recent-ms">{{ formatLatency(log.response_ms) }}</span>
            </button>
          </div>

          <div class="section-foot">
            <span>输入内容不会写入日志</span>
            <a href="#" @click.prevent="router.push({ name: 'logs' })">查看全部 <AppIcon name="arrowRight" :size="11" /></a>
          </div>
        </section>

        <section class="card card-pad">
          <div class="card-head">
            <div>
              <h2 class="card-title">接入</h2>
              <p class="card-sub">OpenAI 兼容接口</p>
            </div>
            <span class="pill pill-green"><AppIcon name="shield" :size="10" /> 整站登录</span>
          </div>
          <div class="access-endpoints">
            <div class="endpoint">
              <span class="endpoint-method">POST</span>
              <span class="endpoint-path">/v1/chat/completions</span>
              <button type="button" class="endpoint-copy" title="复制" @click="copyEndpoint('/v1/chat/completions')">
                <AppIcon name="copy" :size="11" />
              </button>
            </div>
            <div class="endpoint">
              <span class="endpoint-method">GET</span>
              <span class="endpoint-path">/v1/models</span>
              <button type="button" class="endpoint-copy" title="复制" @click="copyEndpoint('/v1/models')">
                <AppIcon name="copy" :size="11" />
              </button>
            </div>
          </div>
          <div class="curl">{{ curlExample }}</div>
          <div class="access-note">
            <AppIcon name="lock" :size="13" />
            <span>
              API Key 回退{{ status?.environment.allow_env_api_key ? '已开启' : '已关闭' }}；控制台整站登录，代理接口仍按 Key 规则运行。
            </span>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
