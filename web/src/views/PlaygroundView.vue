<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import AppIcon from '@/components/AppIcon.vue';
import ModelPicker from '@/components/ModelPicker.vue';
import PageHeader from '@/components/PageHeader.vue';
import { getErrorMessage } from '@/api/client';
import { sendChat } from '@/api/chat';
import type { ChatMessage, StreamEvent, TokenUsage } from '@/api/types';
import { useToast } from '@/composables/useToast';
import { copyText } from '@/utils/format';
import { renderMarkdown } from '@/utils/markdown';

interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  model: string;
  streaming: boolean;
  aborted: boolean;
  error: string;
  createdAt: number;
}

interface Metrics {
  active: boolean;
  streaming: boolean;
  ttft: number | null;
  total: number | null;
  chunks: number;
  chars: number;
  chunkSizes: number[];
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  requestId: string;
  aborted: boolean;
  model: string;
  temperature: number;
  rawEvents: StreamEvent[];
}

const router = useRouter();
const { showToast } = useToast();

const model = ref('');
const stream = ref(true);
const temperature = ref(0.7);
const draft = ref('');
const apiKey = ref('');
const systemPrompt = ref('');
const showAdvanced = ref(false);
const showRaw = ref(false);
const sending = ref(false);
const messages = ref<UiMessage[]>([]);
const chatBody = ref<HTMLElement | null>(null);
const composer = ref<HTMLTextAreaElement | null>(null);
const autoScroll = ref(true);
let abortController: AbortController | null = null;
let sequence = 0;

const metrics = reactive<Metrics>({
  active: false,
  streaming: false,
  ttft: null,
  total: null,
  chunks: 0,
  chars: 0,
  chunkSizes: [],
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
  requestId: '',
  aborted: false,
  model: '',
  temperature: 0.7,
  rawEvents: [],
});

const canSend = computed(() => Boolean(draft.value.trim() && model.value.trim() && !sending.value));
const chatCount = computed(() => messages.value.length);
const ttfbSeconds = computed(() => metrics.ttft === null ? '—' : (metrics.ttft / 1000).toFixed(2));
const totalSeconds = computed(() => metrics.total === null ? '—' : (metrics.total / 1000).toFixed(2));
const ttfbPct = computed(() => {
  if (!metrics.total || metrics.ttft === null) return 0;
  return Math.min(100, Math.max(2, (metrics.ttft / metrics.total) * 100));
});
const chunkBars = computed(() => {
  const sizes = metrics.chunkSizes.slice(-24);
  const max = Math.max(...sizes, 1);
  return sizes.map((size) => Math.max(10, Math.round((size / max) * 100)));
});
const rawEventsText = computed(() => {
  if (!metrics.rawEvents.length) return '还没有收到 SSE 事件。';
  return metrics.rawEvents.map((event) => `+${event.at}ms  ${JSON.stringify(event.data)}`).join('\n');
});

const suggestions = [
  '用三句话介绍你自己。',
  '写一个 TypeScript 防抖函数，并解释适用场景。',
  '返回一个包含 name、version、ready 三个字段的 JSON。',
];

function uid(prefix: string) {
  sequence += 1;
  return `${prefix}_${Date.now()}_${sequence}`;
}

function formatSeconds(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return `${(ms / 1000).toFixed(2)} s`;
}

function resetMetrics() {
  metrics.active = false;
  metrics.streaming = false;
  metrics.ttft = null;
  metrics.total = null;
  metrics.chunks = 0;
  metrics.chars = 0;
  metrics.chunkSizes = [];
  metrics.promptTokens = null;
  metrics.completionTokens = null;
  metrics.totalTokens = null;
  metrics.requestId = '';
  metrics.aborted = false;
  metrics.model = '';
  metrics.temperature = 0.7;
  metrics.rawEvents = [];
  showRaw.value = false;
}

function maybeScroll() {
  if (!autoScroll.value) return;
  nextTick(() => {
    const element = chatBody.value;
    if (element) element.scrollTop = element.scrollHeight;
  });
}

function onChatScroll() {
  const element = chatBody.value;
  if (!element) return;
  autoScroll.value = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
}

function scrollToBottom() {
  autoScroll.value = true;
  maybeScroll();
}

function fillSuggestion(text: string) {
  draft.value = text;
  nextTick(() => composer.value?.focus());
}

function insertCodeBlock() {
  const textarea = composer.value;
  if (!textarea) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = draft.value.slice(start, end) || 'const answer = 42;';
  const next = `${draft.value.slice(0, start)}\`\`\`ts\n${selected}\n\`\`\`\n${draft.value.slice(end)}`;
  draft.value = next;
  nextTick(() => {
    textarea.focus();
    const position = start + 6 + selected.length;
    textarea.setSelectionRange(position, position);
  });
}

function buildHistory(): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (const message of messages.value) {
    if (message.role === 'user') {
      history.push({ role: 'user', content: message.content });
    } else if (message.content && !message.error && !message.aborted) {
      history.push({ role: 'assistant', content: message.content });
    }
  }
  return history;
}

async function send() {
  if (sending.value || !canSend.value) return;
  const text = draft.value.trim();
  if (!text) return;
  if (!model.value.trim()) {
    showToast('请先选择或输入模型', 'error');
    return;
  }

  const prior = buildHistory();
  const activeModel = model.value.trim();
  const rawTemperature = Number(temperature.value);
  const activeTemperature = Number.isFinite(rawTemperature)
    ? Math.min(2, Math.max(0, rawTemperature))
    : 0.7;
  const userMessage: UiMessage = {
    id: uid('user'),
    role: 'user',
    content: text,
    model: activeModel,
    streaming: false,
    aborted: false,
    error: '',
    createdAt: Date.now(),
  };
  const assistant: UiMessage = {
    id: uid('assistant'),
    role: 'assistant',
    content: '',
    model: activeModel,
    streaming: true,
    aborted: false,
    error: '',
    createdAt: Date.now(),
  };

  messages.value.push(userMessage, assistant);
  draft.value = '';
  sending.value = true;
  autoScroll.value = true;
  resetMetrics();
  metrics.active = true;
  metrics.streaming = true;
  metrics.model = activeModel;
  metrics.temperature = activeTemperature;
  showRaw.value = false;

  const requestMessages: ChatMessage[] = [];
  if (systemPrompt.value.trim()) requestMessages.push({ role: 'system', content: systemPrompt.value.trim() });
  requestMessages.push(...prior, { role: 'user', content: text });

  abortController = new AbortController();
  const started = performance.now();
  maybeScroll();

  try {
    const result = await sendChat(
      {
        model: activeModel,
        messages: requestMessages,
        stream: stream.value,
        temperature: activeTemperature,
        apiKey: apiKey.value,
      },
      {
        onDelta: (_delta, fullContent) => {
          assistant.content = fullContent;
          metrics.chars = fullContent.length;
          metrics.chunks += 1;
          if (metrics.ttft === null) metrics.ttft = Math.round(performance.now() - started);
          maybeScroll();
        },
        onEvent: (event) => {
          if (metrics.rawEvents.length < 600) metrics.rawEvents.push(event);
        },
      },
      abortController.signal,
    );

    assistant.content = result.content;
    assistant.streaming = false;
    assistant.aborted = result.aborted;
    if (result.aborted) {
      assistant.content = result.content || '已停止生成。';
    } else if (!result.content) {
      assistant.error = '上游返回了空内容。';
    }

    metrics.streaming = false;
    metrics.ttft = result.firstChunkMs;
    metrics.total = result.totalMs;
    metrics.chunks = result.chunks;
    metrics.chars = result.content.length;
    metrics.chunkSizes = result.chunkSizes;
    metrics.promptTokens = result.usage.prompt_tokens ?? null;
    metrics.completionTokens = result.usage.completion_tokens ?? null;
    metrics.totalTokens = result.usage.total_tokens ?? null;
    metrics.requestId = result.requestId || '';
    metrics.aborted = result.aborted;
    maybeScroll();
  } catch (error) {
    assistant.streaming = false;
    assistant.error = getErrorMessage(error);
    metrics.streaming = false;
    metrics.total = metrics.total ?? Math.round(performance.now() - started);
    showToast(assistant.error, 'error');
  } finally {
    sending.value = false;
    abortController = null;
    maybeScroll();
  }
}

function stopGeneration() {
  if (!abortController) return;
  abortController.abort();
  showToast('正在停止…', 'info');
}

function clearConversation() {
  if (sending.value) return;
  messages.value = [];
  draft.value = '';
  resetMetrics();
  showToast('已清空对话', 'info');
}

async function copyMessage(message: UiMessage) {
  const ok = await copyText(message.content);
  showToast(ok ? '回复已复制' : '复制失败', ok ? 'success' : 'error');
}

async function copyRequestId() {
  if (!metrics.requestId) return;
  const ok = await copyText(metrics.requestId);
  showToast(ok ? '请求 ID 已复制' : '复制失败', ok ? 'success' : 'error');
}

function openLogs() {
  if (!metrics.requestId) return;
  router.push({ name: 'logs', query: { request: metrics.requestId } });
}

function regenerate() {
  if (sending.value) return;
  const lastUserIndex = [...messages.value].reverse().findIndex((message) => message.role === 'user');
  if (lastUserIndex === -1) return;
  const userIndex = messages.value.length - 1 - lastUserIndex;
  const user = messages.value[userIndex];
  messages.value.splice(userIndex);
  draft.value = user.content;
  nextTick(() => send());
}

function keydownComposer(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    send();
  }
}

onBeforeUnmount(() => {
  abortController?.abort();
});
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="测试"
      title="调试台"
      subtitle="发一条消息，验证当前上游与伪流式分块。"
    >
      <template #actions>
        <span class="pill pill-blue"><AppIcon name="zap" :size="10" /> 伪流式</span>
        <button type="button" class="btn btn-secondary btn-sm" @click="router.push({ name: 'logs' })">
          <AppIcon name="logs" :size="13" />
          请求日志
        </button>
      </template>
    </PageHeader>

    <div class="stack">
      <section class="playground-toolbar glass" aria-label="请求参数">
        <ModelPicker v-model="model" />

        <div class="segmented" role="group" aria-label="响应模式">
          <button type="button" :class="{ 'is-active': stream }" :disabled="sending" @click="stream = true">流式</button>
          <button type="button" :class="{ 'is-active': !stream }" :disabled="sending" @click="stream = false">非流式</button>
        </div>

        <label class="toolbar-control temperature-control">
          <AppIcon name="sliders" :size="14" />
          <span>temperature</span>
          <input v-model.number="temperature" type="number" min="0" max="2" step="0.1" aria-label="temperature" :disabled="sending">
        </label>

        <button type="button" class="toolbar-control" :class="{ 'is-active': showAdvanced }" @click="showAdvanced = !showAdvanced">
          <AppIcon name="key" :size="14" />
          使用自己的 Key
        </button>

        <div class="toolbar-spacer" />

        <button type="button" class="toolbar-control" :disabled="sending" @click="clearConversation">
          <AppIcon name="trash" :size="14" />
          清空
        </button>
      </section>

      <section v-if="showAdvanced" class="advanced-panel glass">
        <div class="advanced-panel-grid">
          <label class="field">
            <span class="field-label">本次请求 API Key <span class="label-hint">不保存</span></span>
            <span class="input-wrap">
              <AppIcon name="key" :size="14" />
              <input v-model="apiKey" class="input mono" type="password" placeholder="留空则按服务端配置处理" autocomplete="off">
            </span>
            <span class="field-hint">只在当前页面内存中使用，刷新即清空。</span>
          </label>
          <label class="field">
            <span class="field-label">系统提示词 <span class="label-hint">可选</span></span>
            <textarea v-model="systemPrompt" class="textarea" rows="3" placeholder="例如：你是一个只回答 JSON 的助手。" />
          </label>
        </div>
      </section>

      <div class="playground-grid">
        <section class="chat-panel card" aria-label="对话">
          <div class="chat-head">
            <div class="chat-head-title"><AppIcon name="chat" :size="15" /> 对话</div>
            <span class="pill">{{ chatCount }} 条消息</span>
            <span v-if="model" class="pill pill-blue" style="margin-left:0">{{ model }}</span>
          </div>

          <div ref="chatBody" class="chat-body" @scroll="onChatScroll">
            <div v-if="!messages.length" class="playground-empty">
              <div class="playground-empty-icon"><AppIcon name="waveform" :size="22" /></div>
              <strong>开始验证上游</strong>
              <span>选一个模型，发一条消息。流式模式下会显示分块节奏、首块延迟与 Token 用量。</span>
              <div class="suggestion-list">
                <button v-for="suggestion in suggestions" :key="suggestion" type="button" @click="fillSuggestion(suggestion)">
                  {{ suggestion }}
                </button>
              </div>
            </div>

            <div v-for="message in messages" :key="message.id" class="msg" :class="{ 'msg-user': message.role === 'user' }">
              <template v-if="message.role === 'user'">
                <div class="msg-bubble">{{ message.content }}</div>
              </template>
              <template v-else>
                <span class="msg-avatar"><AppIcon name="waveform" :size="13" /></span>
                <div class="msg-main">
                  <div class="msg-meta">
                    <strong>FakeStream</strong>
                    <span>{{ message.model }}</span>
                    <span v-if="message.streaming" class="pill pill-green">流式</span>
                    <span v-else-if="message.aborted" class="pill">已停止</span>
                  </div>

                  <div v-if="message.error" class="stream-error">
                    <AppIcon name="alert" :size="13" />
                    <span>{{ message.error }}</span>
                  </div>

                  <div v-if="message.streaming" class="msg-content streaming-text">
                    {{ message.content || '正在等待上游…' }}<span class="typing-caret" />
                  </div>
                  <div v-else class="md-content" v-html="renderMarkdown(message.content)" />

                  <div v-if="!message.streaming && message.content" class="msg-actions">
                    <button type="button" class="msg-action" @click="copyMessage(message)">
                      <AppIcon name="copy" :size="11" /> 复制
                    </button>
                    <button type="button" class="msg-action" :disabled="sending" @click="regenerate">
                      <AppIcon name="rotate" :size="11" /> 重新生成
                    </button>
                  </div>

                  <div v-if="message.streaming" class="stream-status">
                    <span class="status-dot is-live" />
                    正在生成 · 已收到 {{ metrics.chunks }} 块
                    <button type="button" class="btn btn-secondary btn-sm" style="margin-left:auto;height:24px;padding:0 8px;font-size:9px;" @click="stopGeneration">
                      <AppIcon name="stop" :size="10" /> 停止
                    </button>
                  </div>
                </div>
              </template>
            </div>
          </div>

          <button v-if="!autoScroll && messages.length" type="button" class="scroll-bottom" @click="scrollToBottom">
            <AppIcon name="chevronDown" :size="13" /> 回到底部
          </button>

          <div class="chat-composer">
            <div class="composer-box">
              <textarea
                ref="composer"
                v-model="draft"
                placeholder="继续追问，或粘贴一段更长的内容…"
                aria-label="输入消息"
                @keydown="keydownComposer"
              />
              <div class="composer-foot">
                <button type="button" class="composer-tool" title="插入代码块" @click="insertCodeBlock">
                  <AppIcon name="code" :size="14" />
                </button>
                <span class="composer-hint"><span class="kbd">⌘</span><span class="kbd">↵</span> 发送</span>
                <button v-if="sending" type="button" class="composer-send is-stop" title="停止生成" @click="stopGeneration">
                  <AppIcon name="stop" :size="14" />
                </button>
                <button v-else type="button" class="composer-send" :disabled="!canSend" title="发送" @click="send">
                  <AppIcon name="send" :size="14" />
                </button>
              </div>
            </div>
          </div>
        </section>

        <aside class="metrics-panel glass" aria-label="本次请求指标">
          <div class="metrics-head">
            <strong>本次请求</strong>
            <span v-if="metrics.active" class="pill" :class="metrics.streaming ? 'pill-green' : metrics.aborted ? 'pill-orange' : 'pill-blue'">
              {{ metrics.streaming ? '流式生成中' : metrics.aborted ? '已停止' : '已完成' }}
            </span>
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
              <button type="button" class="metrics-action" :disabled="!metrics.requestId" @click="copyRequestId">
                <AppIcon name="copy" :size="12" /> 复制请求 ID
                <AppIcon name="chevronRight" :size="10" class="chev" />
              </button>
              <button v-if="metrics.requestId" type="button" class="metrics-action" @click="openLogs">
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
      </div>
    </div>
  </div>
</template>
