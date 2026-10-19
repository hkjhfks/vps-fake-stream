<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import { api, extractModelIds, getErrorMessage } from '@/api/client';
import type { ModelSource } from '@/api/types';
import { sourceLabel } from '@/utils/format';

interface ModelItem {
  id: string;
  provider: string;
}

const props = defineProps<{
  modelValue: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const MODELS_STORAGE = 'fake-stream-model';
const root = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const models = ref<ModelItem[]>([]);
const sources = ref<ModelSource[]>([]);
const loading = ref(false);
const error = ref('');
const open = ref(false);
const query = ref('');
const manual = ref('');

function inferProvider(id: string): string {
  if (!id) return '未选择';
  if (/^(gemini|gemma|models\/|tunedModels\/)/i.test(id)) return 'Gemini';
  if (/^(gpt|chatgpt|o[1-4]|text-|davinci|whisper)/i.test(id)) return 'OpenAI';
  return '自定义';
}

const currentProvider = computed(() => {
  const found = models.value.find((item) => item.id === props.modelValue);
  return found?.provider || inferProvider(props.modelValue);
});

const providerKind = computed(() => {
  if (currentProvider.value === 'Gemini') return 'gemini';
  if (currentProvider.value === 'OpenAI') return 'openai';
  return 'custom';
});

const modeLabel = computed(() => {
  if (loading.value) return '加载中…';
  if (error.value) return '列表不可用';
  if (sources.value.length > 1) return '自动路由';
  if (sources.value.length === 1) return sourceLabel(sources.value[0].format);
  return '手动输入';
});

const filteredModels = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return models.value;
  return models.value.filter((item) => (
    item.id.toLowerCase().includes(needle) || item.provider.toLowerCase().includes(needle)
  ));
});

function close() {
  open.value = false;
  query.value = '';
}

function toggle() {
  open.value = !open.value;
  if (open.value) {
    query.value = '';
    nextTick(() => searchInput.value?.focus());
  }
}

function choose(id: string) {
  const value = id.trim();
  if (!value) return;
  emit('update:modelValue', value);
  try { localStorage.setItem(MODELS_STORAGE, value); } catch { /* ignore */ }
  close();
}

function applyManual() {
  choose(manual.value);
  manual.value = '';
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const payload = await api.models();
    const ids = extractModelIds(payload);
    const format = payload.upstream_format;
    models.value = ids.map((id) => ({
      id,
      provider: format === 'gemini' ? 'Gemini' : format === 'openai' ? 'OpenAI' : inferProvider(id),
    }));
    sources.value = Array.isArray(payload.sources) ? payload.sources : [];

    if (!props.modelValue && ids.length) {
      let saved = '';
      try { saved = localStorage.getItem(MODELS_STORAGE) || ''; } catch { /* ignore */ }
      if (saved && ids.includes(saved)) emit('update:modelValue', saved);
      else emit('update:modelValue', ids[0]);
    }
  } catch (err) {
    models.value = [];
    sources.value = [];
    error.value = getErrorMessage(err);
  } finally {
    loading.value = false;
  }
}

function onDocumentPointerDown(event: MouseEvent) {
  if (!open.value || !root.value) return;
  if (!root.value.contains(event.target as Node)) close();
}

function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) close();
}

watch(open, (value) => {
  if (!value) return;
  nextTick(() => searchInput.value?.focus());
});

onMounted(() => {
  load();
  document.addEventListener('mousedown', onDocumentPointerDown);
  document.addEventListener('keydown', onDocumentKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentPointerDown);
  document.removeEventListener('keydown', onDocumentKeydown);
});
</script>

<template>
  <div ref="root" class="model-picker-wrap" @keydown.esc="close">
    <button
      type="button"
      class="model-picker"
      :aria-expanded="open"
      aria-haspopup="listbox"
      @click="toggle"
    >
      <span class="model-provider-dot" :class="providerKind" />
      <span class="model-picker-copy">
        <strong>{{ modelValue || '选择模型' }}</strong>
        <span>
          {{ currentProvider }}<template v-if="modeLabel && modeLabel !== currentProvider"> · {{ modeLabel }}</template>
        </span>
      </span>
      <AppIcon name="chevronDown" :size="13" />
    </button>

    <Transition name="popover">
      <div v-if="open" class="model-popover glass" role="listbox" aria-label="选择模型">
        <div class="model-search input-wrap">
          <AppIcon name="search" :size="13" />
          <input ref="searchInput" v-model="query" class="input" placeholder="搜索模型…" aria-label="搜索模型">
        </div>

        <div v-if="sources.length" class="model-source-row">
          <span
            v-for="source in sources"
            :key="`${source.format}-${source.base_url}`"
            class="model-source"
            :class="{ 'is-error': !source.ok }"
            :title="source.error || source.base_url"
          >
            <span class="model-source-dot" />
            {{ sourceLabel(source.format) }} {{ source.ok ? source.count : '失败' }}
          </span>
        </div>

        <div class="model-list">
          <button
            v-for="item in filteredModels"
            :key="item.id"
            type="button"
            class="model-option"
            :class="{ 'is-active': item.id === modelValue }"
            role="option"
            :aria-selected="item.id === modelValue"
            @click="choose(item.id)"
          >
            <span class="model-option-name">{{ item.id }}</span>
            <span class="model-option-provider">{{ item.provider }}</span>
            <AppIcon v-if="item.id === modelValue" name="check" :size="12" />
          </button>

          <div v-if="loading" class="model-empty">正在获取模型列表…</div>
          <div v-else-if="error" class="model-error">
            <span>{{ error }}</span>
            <button type="button" @click="load">重试</button>
          </div>
          <div v-else-if="!filteredModels.length" class="model-empty">没有匹配的模型</div>
        </div>

        <div class="model-manual">
          <span class="model-manual-label">手动输入</span>
          <div class="model-manual-row">
            <input
              v-model="manual"
              class="input"
              placeholder="例如 gpt-4o-mini"
              aria-label="手动输入模型 ID"
              @keydown.enter.prevent="applyManual"
            >
            <button type="button" class="btn btn-secondary btn-sm" @click="applyManual">使用</button>
          </div>
        </div>

        <div class="model-popover-foot">
          <button type="button" @click="load">
            <AppIcon name="refresh" :size="11" />
            刷新列表
          </button>
          <span>{{ models.length }} 个模型</span>
        </div>
      </div>
    </Transition>
  </div>
</template>
