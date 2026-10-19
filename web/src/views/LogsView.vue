<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppIcon from '@/components/AppIcon.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import PageHeader from '@/components/PageHeader.vue';
import { api, getErrorMessage } from '@/api/client';
import type { RequestLog } from '@/api/types';
import { useToast } from '@/composables/useToast';
import {
  copyText,
  downloadText,
  formatCompact,
  formatDateTime,
  formatLatency,
  formatTime,
  formatTokens,
  sourceLabel,
  statusKind,
} from '@/utils/format';

type StatusFilter = 'all' | 'success' | 'error';
type StreamFilter = 'all' | 'stream' | 'non-stream';
type RangeFilter = 'all' | '1h' | '24h';

const route = useRoute();
const router = useRouter();
const { showToast } = useToast();

const logs = ref<RequestLog[]>([]);
const loading = ref(true);
const refreshing = ref(false);
const error = ref('');
const limit = ref(200);
const autoRefresh = ref(true);
const search = ref('');
const statusFilter = ref<StatusFilter>('all');
const modelFilter = ref('all');
const streamFilter = ref<StreamFilter>('all');
const rangeFilter = ref<RangeFilter>('all');
const page = ref(1);
const pageSize = 20;
const selectedId = ref('');
const drawerOpen = ref(false);
const showRaw = ref(false);
const confirmOpen = ref(false);
const clearing = ref(false);
let timer: number | null = null;
let requestInFlight = false;

const filteredLogs = computed(() => {
  const needle = search.value.trim().toLowerCase();
  const model = modelFilter.value;
  const now = Date.now();
  const rangeMs = rangeFilter.value === '1h' ? 3_600_000 : rangeFilter.value === '24h' ? 86_400_000 : 0;

  return logs.value.filter((log) => {
    const status = Number(log.status_code) || 0;
    if (statusFilter.value === 'success' && !(status >= 200 && status < 300)) return false;
    if (statusFilter.value === 'error' && status >= 200 && status < 300) return false;
    if (model !== 'all' && log.model !== model) return false;
    if (streamFilter.value === 'stream' && !log.stream) return false;
    if (streamFilter.value === 'non-stream' && log.stream) return false;
    if (rangeMs && log.created_at) {
      const time = Date.parse(log.created_at);
      if (Number.isFinite(time) && now - time > rangeMs) return false;
    }
    if (needle) {
      const haystack = [
        log.model,
        log.id,
        log.request_id,
        log.output_text,
        log.error?.message,
        log.upstream_format,
        log.endpoint,
      ].join(' ').toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
});

const modelOptions = computed(() => {
  return Array.from(new Set(logs.value.map((log) => log.model).filter(Boolean))) as string[];
});

const stats = computed(() => {
  const list = filteredLogs.value;
  const count = list.length;
  const success = list.filter((log) => {
    const status = Number(log.status_code) || 0;
    return status >= 200 && status < 300;
  }).length;
  const latencies = list.map((log) => Number(log.response_ms)).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const p95 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : 0;
  const avg = latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : 0;
  const prompt = list.reduce((sum, log) => sum + (Number(log.usage?.prompt_tokens) || 0), 0);
  const completion = list.reduce((sum, log) => sum + (Number(log.usage?.completion_tokens) || 0), 0);
  const total = list.reduce((sum, log) => {
    const usage = log.usage || {};
    return sum + (Number(usage.total_tokens) || (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0));
  }, 0);
  return { count, success, errors: count - success, successRate: count ? (success / count) * 100 : 0, p95, avg, prompt, completion, total };
});

const pageCount = computed(() => Math.max(1, Math.ceil(filteredLogs.value.length / pageSize)));
const pagedLogs = computed(() => {
  const start = (page.value - 1) * pageSize;
  return filteredLogs.value.slice(start, start + pageSize);
});
const rangeStart = computed(() => {
  const start = (page.value - 1) * pageSize + 1;
  if (!filteredLogs.value.length) return 0;
  return start;
});
const rangeEnd = computed(() => Math.min(filteredLogs.value.length, page.value * pageSize));
const selectedLog = computed(() => logs.value.find((log) => log.id === selectedId.value) || null);

function setupTimer() {
  if (timer) window.clearInterval(timer);
  timer = null;
  if (!autoRefresh.value) return;
  timer = window.setInterval(() => {
    if (document.hidden || requestInFlight) return;
    refresh(true);
  }, 5000);
}

async function refresh(silent = false) {
  if (requestInFlight) return;
  requestInFlight = true;
  if (!silent) refreshing.value = true;
  error.value = '';
  try {
    const response = await api.logs.list(limit.value);
    logs.value = response.logs;
    openFromQuery();
  } catch (err) {
    error.value = getErrorMessage(err);
  } finally {
    requestInFlight = false;
    refreshing.value = false;
    loading.value = false;
    if (page.value > pageCount.value) page.value = pageCount.value;
  }
}

function openFromQuery() {
  const id = route.query.request;
  if (typeof id !== 'string' || !id) return;
  const found = logs.value.find((log) => log.id === id);
  if (found) {
    selectedId.value = id;
    drawerOpen.value = true;
    showRaw.value = false;
  }
}

function selectLog(log: RequestLog) {
  selectedId.value = log.id;
  drawerOpen.value = true;
  showRaw.value = false;
  router.replace({ name: 'logs', query: { ...route.query, request: log.id } });
}

function closeDrawer() {
  drawerOpen.value = false;
  selectedId.value = '';
  showRaw.value = false;
  const query = { ...route.query };
  delete query.request;
  router.replace({ name: 'logs', query });
}

async function clearLogs() {
  clearing.value = true;
  try {
    await api.logs.clear();
    logs.value = [];
    selectedId.value = '';
    drawerOpen.value = false;
    confirmOpen.value = false;
    showToast('请求日志已清空', 'success');
  } catch (err) {
    showToast(getErrorMessage(err), 'error');
  } finally {
    clearing.value = false;
  }
}

function exportLogs() {
  if (!filteredLogs.value.length) {
    showToast('当前筛选没有可导出的日志', 'info');
    return;
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  downloadText(`fake-stream-logs-${stamp}.json`, JSON.stringify(filteredLogs.value, null, 2));
  showToast(`已导出 ${filteredLogs.value.length} 条日志`, 'success');
}

async function copyValue(value: string, label = '内容') {
  const ok = await copyText(value);
  showToast(ok ? `${label}已复制` : '复制失败', ok ? 'success' : 'error');
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && drawerOpen.value) closeDrawer();
}

watch([search, statusFilter, modelFilter, streamFilter, rangeFilter], () => {
  page.value = 1;
});
watch(pageCount, (count) => {
  if (page.value > count) page.value = count;
});
watch(autoRefresh, setupTimer);
watch(limit, () => {
  page.value = 1;
  refresh();
});
watch(() => route.query.request, openFromQuery);

onMounted(() => {
  refresh();
  setupTimer();
  document.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer);
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="日志"
      title="请求日志"
      subtitle="最近请求 · 只记录输出、耗时与 Tokens，不保存输入正文。"
    >
      <template #actions>
        <span class="pill" :class="autoRefresh ? 'pill-green' : 'pill-gray'">
          <span class="status-dot" :class="autoRefresh ? 'is-live' : 'gray'" />
          {{ autoRefresh ? '自动刷新 5s' : '已暂停' }}
        </span>
        <button type="button" class="btn btn-secondary btn-sm" @click="exportLogs">
          <AppIcon name="download" :size="13" />
          导出
        </button>
      </template>
    </PageHeader>

    <div class="stack">
      <section class="logs-stats" aria-label="日志统计">
        <div class="log-stat card">
          <div class="log-stat-label">当前结果</div>
          <div class="log-stat-value">{{ stats.count }}<small>条</small></div>
          <div class="log-stat-foot"><span>基于当前筛选</span></div>
        </div>
        <div class="log-stat card">
          <div class="log-stat-label">成功率</div>
          <div class="log-stat-value">{{ stats.successRate.toFixed(1) }}<small>%</small></div>
          <div class="log-stat-foot"><span :class="stats.errors ? 'down' : 'up'">{{ stats.errors }} 条失败</span></div>
        </div>
        <div class="log-stat card">
          <div class="log-stat-label">P95 耗时</div>
          <div class="log-stat-value">{{ (stats.p95 / 1000).toFixed(2) }}<small>s</small></div>
          <div class="log-stat-foot"><span>平均 {{ formatLatency(stats.avg) }}</span></div>
        </div>
        <div class="log-stat card">
          <div class="log-stat-label">总 Tokens</div>
          <div class="log-stat-value">{{ formatCompact(stats.total) }}</div>
          <div class="log-stat-foot"><span>输入 {{ formatCompact(stats.prompt) }} · 输出 {{ formatCompact(stats.completion) }}</span></div>
        </div>
      </section>

      <section class="filter-bar glass" aria-label="筛选请求">
        <div class="filter-search">
          <span class="input-wrap">
            <AppIcon name="search" :size="13" />
            <input v-model="search" class="input" placeholder="搜索模型、请求 ID 或输出…" aria-label="搜索日志">
          </span>
        </div>
        <div class="segmented" role="group" aria-label="状态筛选">
          <button type="button" :class="{ 'is-active': statusFilter === 'all' }" @click="statusFilter = 'all'">全部</button>
          <button type="button" :class="{ 'is-active': statusFilter === 'success' }" @click="statusFilter = 'success'">成功</button>
          <button type="button" :class="{ 'is-active': statusFilter === 'error' }" @click="statusFilter = 'error'">失败</button>
        </div>
        <select v-model="modelFilter" class="select" aria-label="模型筛选">
          <option value="all">全部模型</option>
          <option v-for="model in modelOptions" :key="model" :value="model">{{ model }}</option>
        </select>
        <select v-model="streamFilter" class="select" aria-label="类型筛选">
          <option value="all">全部类型</option>
          <option value="stream">流式</option>
          <option value="non-stream">非流式</option>
        </select>
        <select v-model="rangeFilter" class="select" aria-label="时间范围">
          <option value="all">全部时间</option>
          <option value="1h">最近 1 小时</option>
          <option value="24h">最近 24 小时</option>
        </select>
        <div class="filter-spacer" />
        <button type="button" class="icon-btn" title="刷新日志" :disabled="refreshing" @click="refresh()">
          <AppIcon name="refresh" :size="15" :class="{ 'is-spinning': refreshing }" />
        </button>
      </section>

      <div v-if="error" class="inline-banner is-error">
        <AppIcon name="alert" :size="14" />
        <span>{{ error }}</span>
        <button type="button" class="btn btn-secondary btn-sm" @click="refresh()">重试</button>
      </div>

      <section class="card logs-card" aria-label="请求列表">
        <div class="logs-card-head">
          <strong>请求记录</strong>
          <span class="pill">{{ filteredLogs.length }} 条</span>
          <span class="head-spacer" />
          <select v-model.number="limit" class="select limit-select" aria-label="读取条数">
            <option :value="100">100 条</option>
            <option :value="200">200 条</option>
            <option :value="500">500 条</option>
            <option :value="1000">1000 条</option>
          </select>
          <button type="button" class="live-toggle" :class="{ 'is-on': autoRefresh }" @click="autoRefresh = !autoRefresh">
            <span class="status-dot" :class="autoRefresh ? 'is-live' : 'gray'" />{{ autoRefresh ? '实时' : '暂停' }}
          </button>
          <button type="button" class="icon-btn" title="清空日志" @click="confirmOpen = true">
            <AppIcon name="trash" :size="14" />
          </button>
        </div>

        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>模型</th>
                <th>状态</th>
                <th class="hide-sm">流式</th>
                <th>耗时</th>
                <th class="hide-sm">Tokens</th>
                <th class="hide-sm">请求 ID</th>
              </tr>
            </thead>
            <tbody>
              <template v-if="loading">
                <tr v-for="index in 8" :key="`skeleton-${index}`" class="skeleton-row">
                  <td><span class="skeleton" style="display:block;width:60px;height:10px" /></td>
                  <td><span class="skeleton" style="display:block;width:110px;height:10px" /></td>
                  <td><span class="skeleton" style="display:block;width:28px;height:14px" /></td>
                  <td class="hide-sm"><span class="skeleton" style="display:block;width:40px;height:10px" /></td>
                  <td><span class="skeleton" style="display:block;width:40px;height:10px" /></td>
                  <td class="hide-sm"><span class="skeleton" style="display:block;width:55px;height:10px" /></td>
                  <td class="hide-sm"><span class="skeleton" style="display:block;width:70px;height:10px" /></td>
                </tr>
              </template>

              <template v-else-if="!pagedLogs.length">
                <tr class="empty-row">
                  <td colspan="7">
                    <div class="empty">
                      <div class="empty-icon"><AppIcon name="logs" :size="19" /></div>
                      <strong>{{ logs.length ? '没有匹配的请求' : '还没有请求记录' }}</strong>
                      <span>{{ logs.length ? '换个关键词或清空筛选条件试试。' : '去调试台发一条消息，这里就会出现日志。' }}</span>
                    </div>
                  </td>
                </tr>
              </template>

              <template v-else>
                <tr
                  v-for="log in pagedLogs"
                  :key="log.id"
                  :class="{ 'is-selected': log.id === selectedId }"
                  @click="selectLog(log)"
                >
                  <td><span class="cell-strong mono" :title="formatDateTime(log.created_at)">{{ formatTime(log.created_at) }}</span></td>
                  <td><span class="cell-strong">{{ log.model || '未知模型' }}</span><span v-if="log.upstream_format" class="cell-mono" style="margin-left:6px">{{ sourceLabel(log.upstream_format) }}</span></td>
                  <td><span class="status-code" :class="statusKind(log.status_code)">{{ log.status_code || '—' }}</span></td>
                  <td class="hide-sm">
                    <span class="stream-flag" :class="{ on: log.stream }">
                      <AppIcon :name="log.stream ? 'zap' : 'stop'" :size="10" />{{ log.stream ? '流式' : '非流式' }}
                    </span>
                  </td>
                  <td>{{ formatLatency(log.response_ms) }}</td>
                  <td class="hide-sm">{{ formatTokens(log) }}</td>
                  <td class="hide-sm"><span class="cell-mono request-id" :title="log.id">{{ log.id }}</span></td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>

        <div class="logs-pagination">
          <span>显示 {{ rangeStart }}–{{ rangeEnd }} / {{ filteredLogs.length }} 条</span>
          <div class="pager">
            <button type="button" :disabled="page <= 1" @click="page -= 1">‹</button>
            <button type="button" class="is-active">{{ page }}</button>
            <span class="pager-total">/ {{ pageCount }}</span>
            <button type="button" :disabled="page >= pageCount" @click="page += 1">›</button>
          </div>
        </div>
      </section>
    </div>

    <Teleport to="body">
      <Transition name="modal">
        <div v-if="drawerOpen && selectedLog" class="log-detail-layer">
          <div class="drawer-scrim" @click="closeDrawer" />
          <aside class="drawer glass" role="dialog" aria-modal="true" aria-labelledby="drawerTitle">
            <div class="drawer-head">
              <div class="drawer-head-copy">
                <div class="drawer-eyebrow"><span class="status-dot" :class="statusKind(selectedLog.status_code) === 'ok' ? 'is-live' : 'orange'" />REQUEST DETAIL</div>
                <div id="drawerTitle" class="drawer-title">
                  <span class="status-code" :class="statusKind(selectedLog.status_code)">{{ selectedLog.status_code || '—' }}</span>
                  请求详情
                </div>
              </div>
              <button type="button" class="drawer-close" title="关闭" @click="closeDrawer"><AppIcon name="x" :size="14" /></button>
            </div>

            <div class="drawer-body">
              <div class="drawer-id-row">
                <span>{{ selectedLog.id }}</span>
                <button type="button" title="复制请求 ID" @click="copyValue(selectedLog.id, '请求 ID')"><AppIcon name="copy" :size="10" /></button>
              </div>

              <section class="drawer-section">
                <div class="drawer-section-title"><AppIcon name="activity" :size="10" /> 概览</div>
                <div class="drawer-grid">
                  <div class="drawer-cell"><span>模型</span><strong>{{ selectedLog.model || '—' }}</strong></div>
                  <div class="drawer-cell"><span>上游</span><strong>{{ selectedLog.upstream_format ? sourceLabel(selectedLog.upstream_format) : '—' }}</strong></div>
                  <div class="drawer-cell"><span>流式</span><strong>{{ selectedLog.stream ? '是' : '否' }}</strong></div>
                  <div class="drawer-cell"><span>响应耗时</span><strong>{{ formatLatency(selectedLog.response_ms) }}</strong></div>
                  <div class="drawer-cell"><span>消息数</span><strong>{{ selectedLog.message_count ?? '—' }}</strong></div>
                  <div class="drawer-cell"><span>Tokens</span><strong style="white-space:nowrap">{{ selectedLog.usage?.prompt_tokens ?? '—' }} <span class="sub">/ {{ selectedLog.usage?.completion_tokens ?? '—' }}</span></strong></div>
                  <div class="drawer-cell"><span>温度</span><strong>{{ selectedLog.temperature ?? '—' }}</strong></div>
                  <div class="drawer-cell"><span>完成原因</span><strong>{{ selectedLog.finish_reason || '—' }}</strong></div>
                </div>
              </section>

              <section class="drawer-section">
                <div class="drawer-section-title"><AppIcon name="clock" :size="10" /> 时间线</div>
                <div class="drawer-timeline" aria-hidden="true">
                  <div class="timeline-node"><span class="timeline-dot" /><span>请求</span></div>
                  <span class="timeline-line" />
                  <div class="timeline-node"><span class="timeline-dot dim" /><span>{{ selectedLog.client_aborted ? '中断' : '完成' }}</span></div>
                </div>
                <div class="drawer-time-row">
                  <span>{{ formatDateTime(selectedLog.created_at) }}</span>
                  <strong>{{ formatLatency(selectedLog.response_ms) }}</strong>
                </div>
              </section>

              <section v-if="selectedLog.error?.message" class="drawer-section">
                <div class="drawer-section-title"><AppIcon name="alert" :size="10" /> 错误信息</div>
                <div class="error-box">{{ selectedLog.error.message }}</div>
              </section>

              <section class="drawer-section">
                <div class="drawer-section-title"><AppIcon name="code" :size="10" /> 输出文本</div>
                <div v-if="selectedLog.output_text" class="output-box">{{ selectedLog.output_text }}</div>
                <div v-else class="output-box is-empty">{{ selectedLog.client_aborted ? '客户端在输出完成前中断了请求。' : '没有记录到输出内容。' }}</div>
                <div v-if="selectedLog.output_text" class="output-actions">
                  <button type="button" class="copy-link" @click="copyValue(selectedLog.output_text || '', '输出')">
                    <AppIcon name="copy" :size="11" /> 复制输出
                  </button>
                  <span class="output-note">输入内容不会被记录</span>
                </div>
              </section>

              <section class="drawer-section">
                <div class="drawer-section-title"><AppIcon name="globe" :size="10" /> 请求信息</div>
                <div class="drawer-grid">
                  <div class="drawer-cell"><span>接口</span><strong class="mono">{{ selectedLog.method || 'POST' }} {{ selectedLog.endpoint || '/v1/chat/completions' }}</strong></div>
                  <div class="drawer-cell"><span>客户端</span><strong class="mono">{{ selectedLog.client_ip || '—' }}</strong></div>
                  <div class="drawer-cell"><span>max_tokens</span><strong>{{ selectedLog.max_tokens ?? '—' }}</strong></div>
                  <div class="drawer-cell"><span>User-Agent</span><strong class="mono">{{ selectedLog.user_agent || '—' }}</strong></div>
                </div>
              </section>

              <section v-if="showRaw" class="drawer-section">
                <div class="drawer-section-title"><AppIcon name="terminal" :size="10" /> 原始 JSON</div>
                <pre class="drawer-json">{{ JSON.stringify(selectedLog, null, 2) }}</pre>
              </section>
            </div>

            <div class="drawer-foot">
              <AppIcon name="shield" :size="11" /> 只记录输出与元信息
              <button type="button" class="btn btn-secondary btn-sm" @click="showRaw = !showRaw">
                <AppIcon name="code" :size="11" /> {{ showRaw ? '收起 JSON' : '原始 JSON' }}
              </button>
            </div>
          </aside>
        </div>
      </Transition>
    </Teleport>

    <ConfirmDialog
      :open="confirmOpen"
      title="清空请求日志"
      message="这会删除 data/request-logs.jsonl 中的全部记录，且不可恢复。"
      confirm-label="清空日志"
      :busy="clearing"
      danger
      @confirm="clearLogs"
      @cancel="confirmOpen = false"
    />
  </div>
</template>
