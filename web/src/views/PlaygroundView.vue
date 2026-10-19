<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import AppIcon from '@/components/AppIcon.vue';
import ModelPicker from '@/components/ModelPicker.vue';
import PageHeader from '@/components/PageHeader.vue';
import ChatMessageItem from '@/components/playground/ChatMessageItem.vue';
import LiveChatMessage from '@/components/playground/LiveChatMessage.vue';
import MetricsPanel from '@/components/playground/MetricsPanel.vue';
import type { Metrics, UiMessage } from '@/components/playground/types';
import { getErrorMessage } from '@/api/client';
import { sendChat } from '@/api/chat';
import type { ChatMessage, StreamEvent } from '@/api/types';
import { beginLive, endLive, updateLive, usePlaygroundLive } from '@/composables/usePlaygroundLive';
import { useToast } from '@/composables/useToast';
import { copyText } from '@/utils/format';
import { renderMarkdown } from '@/utils/markdown';

const router = useRouter();
const { showToast } = useToast();

const model = ref('');
const stream = ref(true);
const temperature = ref(0.7);
const draft = ref('');
const apiKey = ref('');
const systemPrompt = ref('');
const showAdvanced = ref(false);
const sending = ref(false);
const messages = ref<UiMessage[]>([]);
const chatBody = ref<HTMLElement | null>(null);
const composer = ref<HTMLTextAreaElement | null>(null);
const autoScroll = ref(true);
const liveModel = ref('');
const { active: liveActive } = usePlaygroundLive();
let abortController: AbortController | null = null;
let sequence = 0;

const metrics = reactive<Metrics>({
  runId: 0,
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
const chatCount = computed(() => messages.value.length + (liveActive.value ? 1 : 0));

const suggestions = [
  '用三句话介绍你自己。',
  '写一个 TypeScript 防抖函数，并解释适用场景。',
  '返回一个包含 name、version、ready 三个字段的 JSON。',
];

function uid(prefix: string) {
  sequence += 1;
  return `${prefix}_${Date.now()}_${sequence}`;
}

/** Finalised messages are immutable: their HTML is rendered once and reused. */
function freezeMessage(message: UiMessage): UiMessage {
  return Object.freeze(message) as UiMessage;
}

let metricsTimer: number | null = null;
let queuedChars = 0;
let queuedChunks = 0;

function clearMetricsTimer() {
  if (metricsTimer !== null) {
    window.clearTimeout(metricsTimer);
    metricsTimer = null;
  }
}

/** Metrics are display-only; refreshing them at ~10 Hz is indistinguishable. */
function queueMetrics(chars: number, chunks: number) {
  queuedChars = chars;
  queuedChunks = chunks;
  if (metricsTimer !== null) return;
  metricsTimer = window.setTimeout(() => {
    metricsTimer = null;
    metrics.chars = queuedChars;
    metrics.chunks = queuedChunks;
  }, 100);
}

function flushMetrics() {
  clearMetricsTimer();
  metrics.chars = queuedChars;
  metrics.chunks = queuedChunks;
}

function resetMetrics() {
  clearMetricsTimer();
  queuedChars = 0;
  queuedChunks = 0;
  metrics.runId += 1;
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
}

let scrollFrame = 0;
let programmaticScroll = false;

/** Coalesce scroll writes into one layout read per frame (was one per chunk). */
function requestScroll(force = false) {
  if (!autoScroll.value && !force) return;
  if (scrollFrame) return;
  scrollFrame = window.requestAnimationFrame(() => {
    scrollFrame = 0;
    const element = chatBody.value;
    if (!element) return;
    programmaticScroll = true;
    element.scrollTop = element.scrollHeight;
    window.requestAnimationFrame(() => {
      programmaticScroll = false;
    });
  });
}

function onChatScroll() {
  const element = chatBody.value;
  if (!element || programmaticScroll) return;
  autoScroll.value = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
}

function scrollToBottom() {
  autoScroll.value = true;
  requestScroll(true);
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

function commitAssistant(input: { content: string; model: string; aborted: boolean; error: string }) {
  messages.value.push(freezeMessage({
    id: uid('assistant'),
    role: 'assistant',
    content: input.content,
    html: renderMarkdown(input.content),
    model: input.model,
    aborted: input.aborted,
    error: input.error,
    createdAt: Date.now(),
  }));
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

  messages.value.push(freezeMessage({
    id: uid('user'),
    role: 'user',
    content: text,
    html: '',
    model: activeModel,
    aborted: false,
    error: '',
    createdAt: Date.now(),
  }));

  draft.value = '';
  sending.value = true;
  autoScroll.value = true;
  resetMetrics();
  metrics.active = true;
  metrics.streaming = true;
  metrics.model = activeModel;
  metrics.temperature = activeTemperature;

  liveModel.value = activeModel;
  beginLive();

  const requestMessages: ChatMessage[] = [];
  if (systemPrompt.value.trim()) requestMessages.push({ role: 'system', content: systemPrompt.value.trim() });
  requestMessages.push(...prior, { role: 'user', content: text });

  abortController = new AbortController();
  const started = performance.now();
  requestScroll(true);

  const rawEvents: StreamEvent[] = [];
  let chunkCount = 0;
  let fullText = '';

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
        onDelta: (_delta, nextContent) => {
          fullText = nextContent;
          chunkCount += 1;
          updateLive(nextContent);
          if (metrics.ttft === null) metrics.ttft = Math.round(performance.now() - started);
          queueMetrics(nextContent.length, chunkCount);
          requestScroll();
        },
        onEvent: (event) => {
          if (rawEvents.length < 600) rawEvents.push(event);
        },
      },
      abortController.signal,
    );

    commitAssistant({
      content: result.aborted ? (result.content || '已停止生成。') : result.content,
      model: activeModel,
      aborted: result.aborted,
      error: !result.aborted && !result.content ? '上游返回了空内容。' : '',
    });

    flushMetrics();
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
    metrics.rawEvents = rawEvents;
    requestScroll();
  } catch (error) {
    const message = getErrorMessage(error);
    commitAssistant({ content: fullText, model: activeModel, aborted: false, error: message });
    clearMetricsTimer();
    metrics.streaming = false;
    metrics.total = metrics.total ?? Math.round(performance.now() - started);
    metrics.rawEvents = rawEvents;
    showToast(message, 'error');
  } finally {
    endLive();
    sending.value = false;
    abortController = null;
    requestScroll();
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

async function copyMessage(content: string) {
  const ok = await copyText(content);
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
  if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
  clearMetricsTimer();
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
            <div v-if="!messages.length && !liveActive" class="playground-empty">
              <div class="playground-empty-icon"><AppIcon name="waveform" :size="22" /></div>
              <strong>开始验证上游</strong>
              <span>选一个模型，发一条消息。流式模式下会显示分块节奏、首块延迟与 Token 用量。</span>
              <div class="suggestion-list">
                <button v-for="suggestion in suggestions" :key="suggestion" type="button" @click="fillSuggestion(suggestion)">
                  {{ suggestion }}
                </button>
              </div>
            </div>

            <ChatMessageItem
              v-for="message in messages"
              :key="message.id"
              :message="message"
              :can-regenerate="!sending"
              @copy="copyMessage"
              @regenerate="regenerate"
            />

            <LiveChatMessage v-if="liveActive" :model="liveModel" :metrics="metrics" @stop="stopGeneration" />
          </div>

          <button v-if="!autoScroll && (messages.length || liveActive)" type="button" class="scroll-bottom" @click="scrollToBottom">
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

        <MetricsPanel
          :metrics="metrics"
          :stream="stream"
          @copy-request-id="copyRequestId"
          @open-logs="openLogs"
        />
      </div>
    </div>
  </div>
</template>
