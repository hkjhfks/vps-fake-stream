<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import AppIcon from '@/components/AppIcon.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import PageHeader from '@/components/PageHeader.vue';
import { api, getErrorMessage } from '@/api/client';
import type { AppConfig, ConfigKey, ModelSource } from '@/api/types';
import type { IconName } from '@/components/iconPaths';
import { useSession } from '@/composables/useSession';
import { useTheme, type ThemeMode } from '@/composables/useTheme';
import { useToast } from '@/composables/useToast';
import { copyText, parseOrigins, sourceLabel } from '@/utils/format';

type SectionId = 'connection' | 'stream' | 'security' | 'logging' | 'appearance' | 'raw';
type ConfirmKind = 'discard' | 'reload' | 'leave' | 'clearLogs';

interface SectionItem {
  id: SectionId;
  label: string;
  icon: IconName;
}

const sections: SectionItem[] = [
  { id: 'connection', label: '上游连接', icon: 'server' },
  { id: 'stream', label: '流式行为', icon: 'waveform' },
  { id: 'security', label: '访问与安全', icon: 'shield' },
  { id: 'logging', label: '日志与调试', icon: 'database' },
  { id: 'appearance', label: '外观', icon: 'sun' },
  { id: 'raw', label: '原始 JSON', icon: 'code' },
];

const sectionIds = sections.map((section) => section.id);
const route = useRoute();
const router = useRouter();
const { expireSession } = useSession();
const { mode, setMode } = useTheme();
const { showToast } = useToast();

const defaultConfig: AppConfig = {
  OPENAI_API_KEY: '',
  SOURCE_API_URL: '',
  UPSTREAM_FORMAT: 'openai',
  GEMINI_API_KEY: '',
  GEMINI_BASE_URL: '',
  GEMINI_API_VERSION: '',
  CORS_ALLOW_ORIGIN: '*',
  ALLOW_ENV_API_KEY: false,
  ADMIN_PASSWORD: '',
  ADMIN_SESSION_TTL_HOURS: 24,
  HEARTBEAT_INTERVAL_MS: 3000,
  CHUNK_TARGET_LENGTH: 30,
  CHUNK_DELAY_MS: 35,
  DEBUG: false,
  UPSTREAM_EXTRA_HEADERS_JSON: '',
  LOG_MAX_OUTPUT_CHARS: 12000,
  LOG_RETENTION: 2000,
};

const form = reactive<AppConfig>({ ...defaultConfig });
const original = ref<AppConfig | null>(null);
const configPath = ref('config/config.json');
const loading = ref(true);
const loadError = ref('');
const saving = ref(false);
const saveError = ref('');
const validationErrors = reactive<Record<string, string>>({});
const activeSection = ref<SectionId>('connection');
const reveal = reactive({ openai: false, gemini: false, admin: false });
const revealJson = ref(false);
const showAdvanced = ref(false);
const newOrigin = ref('');

const test = reactive({
  loading: false,
  ok: false,
  message: '',
  ms: null as number | null,
});

const confirmState = reactive({
  open: false,
  kind: 'discard' as ConfirmKind,
  busy: false,
});

let pendingNext: ((value?: boolean) => void) | null = null;
let skipLeave = false;

const themeOptions: Array<{ value: ThemeMode; label: string; desc: string; icon: IconName }> = [
  { value: 'system', label: '跟随系统', desc: '根据设备外观自动切换', icon: 'monitor' },
  { value: 'light', label: '浅色', desc: '雾白玻璃，适合白天', icon: 'sun' },
  { value: 'dark', label: '深色', desc: '石墨玻璃，适合夜间', icon: 'moon' },
];

function sectionFromQuery(): SectionId {
  const value = route.query.section;
  return typeof value === 'string' && sectionIds.includes(value as SectionId)
    ? value as SectionId
    : 'connection';
}

activeSection.value = sectionFromQuery();

watch(() => route.query.section, () => {
  activeSection.value = sectionFromQuery();
});

const dirtyKeys = computed<ConfigKey[]>(() => {
  if (!original.value) return [];
  return (Object.keys(form) as ConfigKey[]).filter((key) => form[key] !== original.value![key]);
});
const hasDirty = computed(() => dirtyKeys.value.length > 0);
const dirtyCount = computed(() => dirtyKeys.value.length);

const corsOrigins = computed(() => parseOrigins(form.CORS_ALLOW_ORIGIN));
const formattedJson = computed(() => {
  const source = revealJson.value
    ? form
    : {
        ...form,
        OPENAI_API_KEY: form.OPENAI_API_KEY ? '••••••••••••••••' : '',
        GEMINI_API_KEY: form.GEMINI_API_KEY ? '••••••••••••••••' : '',
        ADMIN_PASSWORD: form.ADMIN_PASSWORD ? '••••••••••••' : '',
      };
  return JSON.stringify(source, null, 2);
});
const speed = computed(() => {
  if (form.CHUNK_DELAY_MS <= 0) return '不限速';
  return `${Math.round(form.CHUNK_TARGET_LENGTH / (form.CHUNK_DELAY_MS / 1000))} 字符 / 秒`;
});

const upstreamBadge = computed(() => (
  form.UPSTREAM_FORMAT === 'auto' ? '自动路由' : sourceLabel(form.UPSTREAM_FORMAT)
));

const confirmMeta = computed(() => {
  if (confirmState.kind === 'reload') {
    return {
      title: '重新读取配置',
      message: '当前有未保存的修改，重新读取会覆盖它们。',
      confirmLabel: '重新读取',
      danger: false,
    };
  }
  if (confirmState.kind === 'leave') {
    return {
      title: '离开设置',
      message: `还有 ${dirtyCount.value} 项修改未保存，离开后会丢失。`,
      confirmLabel: '离开',
      danger: true,
    };
  }
  if (confirmState.kind === 'clearLogs') {
    return {
      title: '清空请求日志',
      message: '这会删除 data/request-logs.jsonl 中的全部记录，且不可恢复。',
      confirmLabel: '清空日志',
      danger: true,
    };
  }
  return {
    title: '放弃修改',
    message: `确定放弃 ${dirtyCount.value} 项未保存的修改吗？`,
    confirmLabel: '放弃修改',
    danger: true,
  };
});

function selectSection(section: SectionId) {
  activeSection.value = section;
  router.replace({
    name: 'settings',
    query: section === 'connection' ? {} : { section },
  });
}

function clearValidation() {
  for (const key of Object.keys(validationErrors)) delete validationErrors[key];
}

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validate(): boolean {
  clearValidation();
  saveError.value = '';

  if (!isValidUrl(form.SOURCE_API_URL)) {
    validationErrors.SOURCE_API_URL = '请输入有效的 http(s) 地址';
  }
  if (!isValidUrl(form.GEMINI_BASE_URL)) {
    validationErrors.GEMINI_BASE_URL = '请输入有效的 http(s) 地址';
  }
  if (!form.GEMINI_API_VERSION.trim()) {
    validationErrors.GEMINI_API_VERSION = 'API 版本不能为空';
  } else if (!/^[A-Za-z0-9._-]+$/.test(form.GEMINI_API_VERSION.trim())) {
    validationErrors.GEMINI_API_VERSION = '只能包含字母、数字、点、下划线或短横线';
  }
  if (!form.ADMIN_PASSWORD.trim()) {
    validationErrors.ADMIN_PASSWORD = '管理员密码不能为空；清空会关闭整站登录保护';
  }
  if (!form.CORS_ALLOW_ORIGIN.trim()) {
    validationErrors.CORS_ALLOW_ORIGIN = '不能为空；允许全部来源请填 *';
  }
  if (form.UPSTREAM_EXTRA_HEADERS_JSON.trim()) {
    try {
      const parsed = JSON.parse(form.UPSTREAM_EXTRA_HEADERS_JSON);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    } catch {
      validationErrors.UPSTREAM_EXTRA_HEADERS_JSON = '请输入合法的 JSON 对象';
    }
  }

  const ranges: Array<[ConfigKey, number, number, string]> = [
    ['ADMIN_SESSION_TTL_HOURS', 1, 720, '范围 1–720'],
    ['HEARTBEAT_INTERVAL_MS', 500, 60000, '范围 500–60000'],
    ['CHUNK_TARGET_LENGTH', 1, 500, '范围 1–500'],
    ['CHUNK_DELAY_MS', 0, 10000, '范围 0–10000'],
    ['LOG_MAX_OUTPUT_CHARS', 200, 200000, '范围 200–200000'],
    ['LOG_RETENTION', 100, 200000, '范围 100–200000'],
  ];
  for (const [key, min, max, message] of ranges) {
    const value = Number(form[key]);
    if (!Number.isFinite(value) || value < min || value > max) {
      validationErrors[key] = message;
    }
  }

  return Object.keys(validationErrors).length === 0;
}

async function loadConfig() {
  loading.value = true;
  loadError.value = '';
  try {
    const response = await api.config.get();
    configPath.value = response.config_path || 'config/config.json';
    Object.assign(form, response.config);
    original.value = { ...response.config };
    clearValidation();
    saveError.value = '';
    test.ok = false;
    test.message = '';
    test.ms = null;
  } catch (error) {
    loadError.value = getErrorMessage(error);
  } finally {
    loading.value = false;
  }
}

function resetForm() {
  if (!original.value) return;
  Object.assign(form, original.value);
  clearValidation();
  saveError.value = '';
  test.ok = false;
  test.message = '';
  showToast('已放弃未保存的修改', 'info');
}

async function saveConfig() {
  if (!validate()) {
    saveError.value = '请修正表单中的错误后再保存';
    showToast('有字段需要修正', 'error');
    return;
  }
  if (!hasDirty.value) {
    showToast('没有需要保存的修改', 'info');
    return;
  }

  const patch: Partial<AppConfig> = {};
  for (const key of dirtyKeys.value) {
    (patch as Record<string, unknown>)[key] = form[key];
  }
  const adminChanged = dirtyKeys.value.includes('ADMIN_PASSWORD');

  saving.value = true;
  saveError.value = '';
  try {
    const response = await api.config.save(patch);
    Object.assign(form, response.config);
    configPath.value = response.config_path || configPath.value;
    original.value = { ...response.config };
    showToast('配置已保存，热读取已生效', 'success');

    if (adminChanged) {
      skipLeave = true;
      try { await api.admin.logout(); } catch { /* ignore */ }
      expireSession('管理员密码已更新，请重新登录');
      showToast('管理员密码已更新，请重新登录', 'info');
      await router.replace({ name: 'login', query: { reason: 'password-changed' } });
    }
  } catch (error) {
    saveError.value = getErrorMessage(error);
    showToast('保存失败', 'error');
  } finally {
    saving.value = false;
  }
}

async function runTest() {
  if (test.loading || saving.value) return;
  if (hasDirty.value) {
    showToast('测试会使用已保存的配置，先保存修改才能测试新值', 'info');
  }
  test.loading = true;
  test.message = '';
  test.ok = false;
  const started = performance.now();
  try {
    const payload = await api.models();
    const sources: ModelSource[] = Array.isArray(payload.sources) ? payload.sources : [];
    const count = Array.isArray(payload.data) ? payload.data.length : 0;
    test.ms = Math.round(performance.now() - started);
    test.ok = true;
    test.message = sources.length
      ? sources.map((source) => `${sourceLabel(source.format)} ${source.ok ? `${source.count} 个模型` : '连接失败'}`).join(' · ')
      : `${count} 个模型`;
  } catch (error) {
    test.ok = false;
    test.ms = Math.round(performance.now() - started);
    test.message = getErrorMessage(error);
  } finally {
    test.loading = false;
  }
}

function addOrigin() {
  const value = newOrigin.value.trim();
  if (!value) return;
  if (value !== '*' && !isValidUrl(value)) {
    showToast('请输入有效的 http(s) 来源，或填写 *', 'error');
    return;
  }
  if (corsOrigins.value.includes(value)) {
    showToast('这个来源已经在列表里了', 'info');
    return;
  }
  form.CORS_ALLOW_ORIGIN = value === '*'
    ? '*'
    : [...corsOrigins.value.filter((origin) => origin !== '*'), value].join('\n');
  newOrigin.value = '';
}

function removeOrigin(origin: string) {
  if (origin === '*') {
    showToast('至少保留一个来源', 'error');
    return;
  }
  const next = corsOrigins.value.filter((item) => item !== origin);
  form.CORS_ALLOW_ORIGIN = next.length ? next.join('\n') : '*';
}

function applyTheme(value: ThemeMode) {
  setMode(value);
  const label = themeOptions.find((option) => option.value === value)?.label || value;
  showToast(`外观已切换为${label}`, 'success');
}

async function copyJson() {
  const ok = await copyText(formattedJson.value);
  showToast(ok ? 'JSON 已复制' : '复制失败，请手动选择', ok ? 'success' : 'error');
}

function openConfirm(kind: ConfirmKind) {
  confirmState.kind = kind;
  confirmState.open = true;
  confirmState.busy = false;
}

function openReload() {
  if (hasDirty.value) openConfirm('reload');
  else loadConfig();
}

function handleCancel() {
  confirmState.open = false;
  if (pendingNext) {
    const next = pendingNext;
    pendingNext = null;
    next(false);
  }
}

async function handleConfirm() {
  if (confirmState.busy) return;
  if (confirmState.kind === 'discard') {
    confirmState.open = false;
    resetForm();
    return;
  }
  if (confirmState.kind === 'reload') {
    confirmState.open = false;
    await loadConfig();
    return;
  }
  if (confirmState.kind === 'leave') {
    confirmState.open = false;
    const next = pendingNext;
    pendingNext = null;
    skipLeave = true;
    next?.();
    return;
  }
  if (confirmState.kind === 'clearLogs') {
    confirmState.busy = true;
    try {
      await api.logs.clear();
      showToast('请求日志已清空', 'success');
      confirmState.open = false;
    } catch (error) {
      showToast(getErrorMessage(error), 'error');
    } finally {
      confirmState.busy = false;
    }
  }
}

function onBeforeUnload(event: BeforeUnloadEvent) {
  if (!hasDirty.value) return;
  event.preventDefault();
  event.returnValue = '';
}

onBeforeRouteLeave((to, from, next) => {
  if (!hasDirty.value || skipLeave) {
    next();
    return;
  }
  pendingNext = next;
  openConfirm('leave');
});

function onAuthExpired() {
  skipLeave = true;
  confirmState.open = false;
  const next = pendingNext;
  pendingNext = null;
  next?.();
}

watch(() => form.ADMIN_PASSWORD, (value) => {
  if (original.value && value !== original.value.ADMIN_PASSWORD) {
    saveError.value = '';
  }
});

onMounted(() => {
  loadConfig();
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('fake-stream:auth-expired', onAuthExpired);
});

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload);
  window.removeEventListener('fake-stream:auth-expired', onAuthExpired);
});
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="配置"
      title="设置"
      subtitle="配置上游、流式行为、访问控制与日志。修改后即时生效。"
    >
      <template #actions>
        <span class="pill" :class="hasDirty ? 'pill-orange' : 'pill-green'">
          <AppIcon :name="hasDirty ? 'info' : 'check'" :size="10" />
          {{ hasDirty ? `${dirtyCount} 项未保存` : '已保存' }}
        </span>
        <button type="button" class="icon-btn glass-btn" title="重新读取配置" :disabled="loading || saving" @click="openReload">
          <AppIcon name="refresh" :size="16" :class="{ 'is-spinning': loading }" />
        </button>
      </template>
    </PageHeader>

    <div v-if="loadError" class="inline-banner is-error">
      <AppIcon name="alert" :size="14" />
      <span>{{ loadError }}</span>
      <button type="button" class="btn btn-secondary btn-sm" @click="loadConfig">重试</button>
    </div>

    <div v-else-if="loading" class="settings-layout">
      <aside class="settings-nav card">
        <div v-for="index in 6" :key="index" class="settings-nav-skeleton skeleton" />
      </aside>
      <div class="settings-body">
        <section class="card settings-section">
          <div class="skeleton" style="width:180px;height:18px;margin-bottom:18px" />
          <div class="skeleton" style="width:100%;height:88px;margin-bottom:16px" />
          <div class="provider-grid">
            <div class="skeleton" style="height:190px" />
            <div class="skeleton" style="height:190px" />
          </div>
        </section>
      </div>
    </div>

    <div v-else class="settings-layout">
      <aside class="settings-nav card" aria-label="设置分区">
        <button
          v-for="item in sections"
          :key="item.id"
          type="button"
          class="settings-nav-item"
          :class="{ 'is-active': activeSection === item.id }"
          :data-settings-section="item.id"
          @click="selectSection(item.id)"
        >
          <AppIcon :name="item.icon" :size="15" />
          <span>{{ item.label }}</span>
        </button>
        <div class="settings-nav-note" :title="configPath">
          配置文件
          <code>config/config.json</code>
        </div>
      </aside>

      <div class="settings-body">
        <section v-if="activeSection === 'connection'" class="card settings-section">
          <div class="settings-section-head">
            <div>
              <h2 class="settings-title">上游连接</h2>
              <p class="settings-sub">选择请求如何路由到上游。配置保存后即时生效，无需重启。</p>
            </div>
            <span class="pill pill-blue">{{ upstreamBadge }}</span>
          </div>

          <div class="choice-grid">
            <button type="button" class="choice" :class="{ 'is-active': form.UPSTREAM_FORMAT === 'openai' }" @click="form.UPSTREAM_FORMAT = 'openai'">
              <span class="choice-icon"><AppIcon name="server" :size="13" /></span>
              <strong>OpenAI 兼容</strong>
              <span>标准 Chat Completions</span>
              <span class="choice-check"><AppIcon name="check" :size="9" /></span>
            </button>
            <button type="button" class="choice" :class="{ 'is-active': form.UPSTREAM_FORMAT === 'gemini' }" @click="form.UPSTREAM_FORMAT = 'gemini'">
              <span class="choice-icon"><AppIcon name="sparkles" :size="13" /></span>
              <strong>Google Gemini</strong>
              <span>generateContent 格式</span>
              <span class="choice-check"><AppIcon name="check" :size="9" /></span>
            </button>
            <button type="button" class="choice" :class="{ 'is-active': form.UPSTREAM_FORMAT === 'auto' }" @click="form.UPSTREAM_FORMAT = 'auto'">
              <span class="choice-icon"><AppIcon name="zap" :size="13" /></span>
              <strong>自动路由</strong>
              <span>按模型名分流</span>
              <span class="choice-check"><AppIcon name="check" :size="9" /></span>
            </button>
          </div>

          <div class="provider-grid">
            <div class="provider-card">
              <div class="provider-head">
                <span class="provider-logo"><AppIcon name="server" :size="13" /></span>
                <strong>OpenAI 兼容</strong>
                <span class="pill" :class="form.OPENAI_API_KEY ? 'pill-green' : 'pill-gray'">{{ form.OPENAI_API_KEY ? '已配置' : '未配置' }}</span>
              </div>
              <div class="provider-fields">
                <label class="field">
                  <span class="field-label">Base URL</span>
                  <input v-model.trim="form.SOURCE_API_URL" class="input mono" placeholder="https://api.openai.com" aria-label="OpenAI Base URL">
                  <span v-if="validationErrors.SOURCE_API_URL" class="field-error">{{ validationErrors.SOURCE_API_URL }}</span>
                </label>
                <label class="field">
                  <span class="field-label">API Key <span class="label-hint">{{ form.OPENAI_API_KEY ? '已配置' : '未配置' }}</span></span>
                  <span class="input-wrap">
                    <AppIcon name="key" :size="13" />
                    <input
                      v-model.trim="form.OPENAI_API_KEY"
                      class="input mono"
                      :type="reveal.openai ? 'text' : 'password'"
                      placeholder="输入 OpenAI API Key"
                      autocomplete="off"
                      aria-label="OpenAI API Key"
                    >
                    <button type="button" class="input-action" :title="reveal.openai ? '隐藏密钥' : '显示密钥'" @click="reveal.openai = !reveal.openai">
                      <AppIcon :name="reveal.openai ? 'eyeOff' : 'eye'" :size="13" />
                    </button>
                  </span>
                  <span class="field-hint">使用 Authorization: Bearer；留空时按 ALLOW_ENV_API_KEY 回退。</span>
                </label>
              </div>
            </div>

            <div class="provider-card">
              <div class="provider-head">
                <span class="provider-logo"><AppIcon name="sparkles" :size="13" /></span>
                <strong>Google Gemini</strong>
                <span class="pill" :class="form.GEMINI_API_KEY ? 'pill-green' : 'pill-gray'">{{ form.GEMINI_API_KEY ? '已配置' : '未配置' }}</span>
              </div>
              <div class="provider-fields">
                <label class="field">
                  <span class="field-label">Base URL</span>
                  <input v-model.trim="form.GEMINI_BASE_URL" class="input mono" placeholder="https://generativelanguage.googleapis.com" aria-label="Gemini Base URL">
                  <span v-if="validationErrors.GEMINI_BASE_URL" class="field-error">{{ validationErrors.GEMINI_BASE_URL }}</span>
                </label>
                <label class="field">
                  <span class="field-label">API Version</span>
                  <input v-model.trim="form.GEMINI_API_VERSION" class="input mono" placeholder="v1beta" aria-label="Gemini API Version">
                  <span v-if="validationErrors.GEMINI_API_VERSION" class="field-error">{{ validationErrors.GEMINI_API_VERSION }}</span>
                </label>
                <label class="field">
                  <span class="field-label">API Key <span class="label-hint">{{ form.GEMINI_API_KEY ? '已配置' : '未配置' }}</span></span>
                  <span class="input-wrap">
                    <AppIcon name="key" :size="13" />
                    <input
                      v-model.trim="form.GEMINI_API_KEY"
                      class="input mono"
                      :type="reveal.gemini ? 'text' : 'password'"
                      placeholder="输入 Gemini API Key"
                      autocomplete="off"
                      aria-label="Gemini API Key"
                    >
                    <button type="button" class="input-action" :title="reveal.gemini ? '隐藏密钥' : '显示密钥'" @click="reveal.gemini = !reveal.gemini">
                      <AppIcon :name="reveal.gemini ? 'eyeOff' : 'eye'" :size="13" />
                    </button>
                  </span>
                </label>
              </div>
            </div>
          </div>

          <div class="test-row">
            <button type="button" class="btn btn-secondary btn-sm" :disabled="test.loading || saving" @click="runTest">
              <AppIcon name="zap" :size="13" :class="{ 'is-spinning': test.loading }" />
              {{ test.loading ? '测试中…' : '测试连接' }}
            </button>
            <span v-if="test.message" class="test-result" :class="test.ok ? '' : 'is-error'">
              <AppIcon :name="test.ok ? 'checkCircle' : 'alert'" :size="11" />
              {{ test.message }}
              <span v-if="test.ms !== null">· {{ test.ms }} ms</span>
            </span>
            <span v-else class="test-result muted">使用已保存的配置测试</span>
          </div>

          <button type="button" class="advanced-row" @click="showAdvanced = !showAdvanced">
            <AppIcon name="code" :size="13" />
            <span class="advanced-title">额外上游请求头</span>
            <span class="pill">JSON</span>
            <AppIcon :name="showAdvanced ? 'chevronDown' : 'chevronRight'" :size="13" />
          </button>
          <div v-if="showAdvanced" class="form-stack" style="margin-top:10px">
            <label class="field">
              <span class="field-label">UPSTREAM_EXTRA_HEADERS_JSON</span>
              <textarea v-model="form.UPSTREAM_EXTRA_HEADERS_JSON" class="textarea mono" rows="4" placeholder='{"X-Custom-Header":"value"}' />
              <span v-if="validationErrors.UPSTREAM_EXTRA_HEADERS_JSON" class="field-error">{{ validationErrors.UPSTREAM_EXTRA_HEADERS_JSON }}</span>
              <span class="field-hint">必须是 JSON 对象；不要在这里重复设置 Authorization。</span>
            </label>
          </div>

          <div class="callout" style="margin-top:12px">
            <AppIcon name="info" :size="14" />
            配置直接写入 config/config.json；文件变化会被自动读取。
          </div>
        </section>

        <section v-else-if="activeSection === 'stream'" class="card settings-section">
          <div class="settings-section-head">
            <div>
              <h2 class="settings-title">流式行为</h2>
              <p class="settings-sub">控制伪流式的分块节奏、延迟与心跳。参数越小越像实时输出，但请求数更多。</p>
            </div>
            <span class="pill">即时生效</span>
          </div>

          <div class="speed-card">
            <span class="speed-icon"><AppIcon name="zap" :size="16" /></span>
            <div class="speed-copy">
              <strong>≈ {{ speed }}</strong>
              <span>按 {{ form.CHUNK_TARGET_LENGTH }} 字符分块 / {{ form.CHUNK_DELAY_MS }}ms 间隔估算</span>
            </div>
            <span class="speed-bars" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></span>
          </div>

          <div class="form-stack" style="margin-top:16px">
            <div class="field-row three">
              <label class="field">
                <span class="field-label">分块目标长度</span>
                <span class="unit-input">
                  <input v-model.number="form.CHUNK_TARGET_LENGTH" class="input mono" type="number" min="1" max="500" aria-label="分块目标长度">
                  <span class="unit">字符</span>
                </span>
                <span v-if="validationErrors.CHUNK_TARGET_LENGTH" class="field-error">{{ validationErrors.CHUNK_TARGET_LENGTH }}</span>
                <span class="field-hint">建议 30–60，过小会产生大量 SSE 事件。</span>
              </label>
              <label class="field">
                <span class="field-label">分块发送延迟</span>
                <span class="unit-input">
                  <input v-model.number="form.CHUNK_DELAY_MS" class="input mono" type="number" min="0" max="10000" aria-label="分块发送延迟">
                  <span class="unit">ms</span>
                </span>
                <span v-if="validationErrors.CHUNK_DELAY_MS" class="field-error">{{ validationErrors.CHUNK_DELAY_MS }}</span>
                <span class="field-hint">每块之间的等待时间。</span>
              </label>
              <label class="field">
                <span class="field-label">SSE 心跳间隔</span>
                <span class="unit-input">
                  <input v-model.number="form.HEARTBEAT_INTERVAL_MS" class="input mono" type="number" min="500" max="60000" aria-label="SSE 心跳间隔">
                  <span class="unit">ms</span>
                </span>
                <span v-if="validationErrors.HEARTBEAT_INTERVAL_MS" class="field-error">{{ validationErrors.HEARTBEAT_INTERVAL_MS }}</span>
                <span class="field-hint">长时间无输出时保持连接。</span>
              </label>
            </div>
          </div>

          <div class="callout" style="margin-top:16px">
            <AppIcon name="info" :size="14" />
            分块会按标点与换行优先切分；移动网络建议 30–50 字符 / 35–60ms。
          </div>
        </section>

        <section v-else-if="activeSection === 'security'" class="card settings-section">
          <div class="settings-section-head">
            <div>
              <h2 class="settings-title">访问与安全</h2>
              <p class="settings-sub">控制控制台会话、跨域来源与服务端 Key 回退。</p>
            </div>
            <span class="pill pill-orange">建议检查</span>
          </div>

          <div class="form-stack">
            <div class="form-grid-2">
              <label class="field">
                <span class="field-label">管理员密码 <span class="label-hint">ADMIN_PASSWORD</span></span>
                <span class="input-wrap">
                  <AppIcon name="lock" :size="13" />
                  <input
                    v-model="form.ADMIN_PASSWORD"
                    class="input mono"
                    :type="reveal.admin ? 'text' : 'password'"
                    placeholder="输入管理员密码"
                    autocomplete="new-password"
                    aria-label="管理员密码"
                  >
                  <button type="button" class="input-action" :title="reveal.admin ? '隐藏密码' : '显示密码'" @click="reveal.admin = !reveal.admin">
                    <AppIcon :name="reveal.admin ? 'eyeOff' : 'eye'" :size="13" />
                  </button>
                </span>
                <span v-if="validationErrors.ADMIN_PASSWORD" class="field-error">{{ validationErrors.ADMIN_PASSWORD }}</span>
                <span class="field-hint">修改后当前会话立即失效，需要重新登录。</span>
              </label>
              <label class="field">
                <span class="field-label">会话有效期 <span class="label-hint">ADMIN_SESSION_TTL_HOURS</span></span>
                <span class="unit-input">
                  <input v-model.number="form.ADMIN_SESSION_TTL_HOURS" class="input mono" type="number" min="1" max="720" aria-label="会话有效期">
                  <span class="unit">小时</span>
                </span>
                <span v-if="validationErrors.ADMIN_SESSION_TTL_HOURS" class="field-error">{{ validationErrors.ADMIN_SESSION_TTL_HOURS }}</span>
                <span class="field-hint">登录 Cookie 的最长有效期，范围 1–720 小时。</span>
              </label>
            </div>

            <label class="field">
              <span class="field-label">CORS 允许来源 <span class="label-hint">CORS_ALLOW_ORIGIN</span></span>
              <span class="chip-input">
                <span v-for="origin in corsOrigins" :key="origin" class="chip">
                  {{ origin }}
                  <button type="button" :aria-label="`移除 ${origin}`" @click="removeOrigin(origin)">
                    <AppIcon name="x" :size="9" />
                  </button>
                </span>
                <input
                  v-model="newOrigin"
                  class="chip-input-field"
                  placeholder="添加来源"
                  aria-label="添加 CORS 来源"
                  @keydown.enter.prevent="addOrigin"
                >
                <button type="button" class="chip-add" @click="addOrigin">
                  <AppIcon name="plus" :size="10" />
                  添加
                </button>
              </span>
              <span v-if="validationErrors.CORS_ALLOW_ORIGIN" class="field-error">{{ validationErrors.CORS_ALLOW_ORIGIN }}</span>
              <span class="field-hint">支持逗号或换行分隔；使用 * 表示全部允许。建议只保留自己的域名。</span>
            </label>

            <div class="switch-row">
              <div class="switch-copy">
                <strong>允许服务端 Key 回退</strong>
                <span>请求未带 Key 时，使用 config/config.json 中配置的上游 Key。</span>
              </div>
              <button
                type="button"
                class="switch"
                :class="{ 'is-on': form.ALLOW_ENV_API_KEY }"
                :aria-pressed="form.ALLOW_ENV_API_KEY"
                aria-label="允许服务端 Key 回退"
                @click="form.ALLOW_ENV_API_KEY = !form.ALLOW_ENV_API_KEY"
              />
            </div>
          </div>

          <div v-if="original && form.ADMIN_PASSWORD !== original.ADMIN_PASSWORD" class="callout warn" style="margin-top:16px">
            <AppIcon name="alert" :size="14" />
            修改管理员密码会让当前 Cookie 立即失效；保存后请用新密码重新登录。
          </div>
          <div class="callout" style="margin-top:8px">
            <AppIcon name="shield" :size="14" />
            控制台所有页面都需要登录；/v1/chat/completions 仍按代理接口的鉴权规则运行。
          </div>
        </section>

        <section v-else-if="activeSection === 'logging'" class="card settings-section">
          <div class="settings-section-head">
            <div>
              <h2 class="settings-title">日志与调试</h2>
              <p class="settings-sub">控制请求日志保留量、输出长度与调试信息。</p>
            </div>
            <span class="pill">只记录输出</span>
          </div>

          <div class="form-stack">
            <div class="form-grid-2">
              <label class="field">
                <span class="field-label">单条输出上限 <span class="label-hint">LOG_MAX_OUTPUT_CHARS</span></span>
                <span class="unit-input">
                  <input v-model.number="form.LOG_MAX_OUTPUT_CHARS" class="input mono" type="number" min="200" max="200000" aria-label="单条输出上限">
                  <span class="unit">字符</span>
                </span>
                <span v-if="validationErrors.LOG_MAX_OUTPUT_CHARS" class="field-error">{{ validationErrors.LOG_MAX_OUTPUT_CHARS }}</span>
                <span class="field-hint">超出部分会被截断；默认 12,000 字符。</span>
              </label>
              <label class="field">
                <span class="field-label">日志保留条数 <span class="label-hint">LOG_RETENTION</span></span>
                <span class="unit-input">
                  <input v-model.number="form.LOG_RETENTION" class="input mono" type="number" min="100" max="200000" aria-label="日志保留条数">
                  <span class="unit">条</span>
                </span>
                <span v-if="validationErrors.LOG_RETENTION" class="field-error">{{ validationErrors.LOG_RETENTION }}</span>
                <span class="field-hint">达到上限后自动淘汰最旧的记录。</span>
              </label>
            </div>

            <div class="field">
              <span class="field-label">日志文件</span>
              <div class="endpoint">
                <span class="endpoint-method">JSONL</span>
                <span class="endpoint-path">data/request-logs.jsonl</span>
                <button type="button" class="endpoint-copy" title="复制路径" @click="copyText('data/request-logs.jsonl').then((ok) => showToast(ok ? '路径已复制' : '复制失败', ok ? 'success' : 'error'))">
                  <AppIcon name="copy" :size="11" />
                </button>
              </div>
            </div>

            <div class="switch-row">
              <div class="switch-copy">
                <strong>输出调试日志</strong>
                <span>在服务端控制台打印上游转换与流式分块的调试信息。</span>
              </div>
              <button
                type="button"
                class="switch"
                :class="{ 'is-on': form.DEBUG }"
                :aria-pressed="form.DEBUG"
                aria-label="输出调试日志"
                @click="form.DEBUG = !form.DEBUG"
              />
            </div>

            <div class="danger-row">
              <div class="danger-row-copy">
                <strong>清空请求日志</strong>
                <span>删除 data/request-logs.jsonl 中的全部记录，不可恢复。</span>
              </div>
              <button type="button" class="btn btn-danger btn-sm" @click="openConfirm('clearLogs')">
                <AppIcon name="trash" :size="12" />
                清空
              </button>
            </div>
          </div>

          <div class="callout" style="margin-top:16px">
            <AppIcon name="info" :size="14" />
            输入消息正文不会被记录；只保存模型、耗时、Tokens 与输出文本。
          </div>
        </section>

        <section v-else-if="activeSection === 'appearance'" class="card settings-section">
          <div class="settings-section-head">
            <div>
              <h2 class="settings-title">外观</h2>
              <p class="settings-sub">选择浅色雾白或深色石墨玻璃。设置只保存在当前浏览器。</p>
            </div>
            <span class="pill">{{ mode === 'system' ? '跟随系统' : mode === 'dark' ? '深色' : '浅色' }}</span>
          </div>

          <div class="theme-grid">
            <button
              v-for="option in themeOptions"
              :key="option.value"
              type="button"
              class="theme-choice"
              :class="{ 'is-active': mode === option.value }"
              @click="applyTheme(option.value)"
            >
              <span class="theme-preview" :class="`is-${option.value}`">
                <span class="theme-preview-side" />
                <span class="theme-preview-main"><i /><i /></span>
              </span>
              <span class="theme-choice-copy">
                <strong>{{ option.label }}</strong>
                <span>{{ option.desc }}</span>
              </span>
              <span class="choice-check"><AppIcon name="check" :size="9" /></span>
            </button>
          </div>

          <div class="callout" style="margin-top:16px">
            <AppIcon name="info" :size="14" />
            外观是浏览器本地偏好，不会写入 config/config.json，也不会影响其他人。
          </div>
        </section>

        <section v-else class="card settings-section">
          <div class="settings-section-head">
            <div>
              <h2 class="settings-title">原始 JSON</h2>
              <p class="settings-sub">config/config.json 的只读预览。修改请使用左侧表单，或直接编辑文件。</p>
            </div>
            <span class="pill pill-mono">{{ revealJson ? '密钥可见' : '密钥已遮罩' }}</span>
          </div>

          <div class="raw-viewer">
            <div class="raw-viewer-head">
              <span class="raw-dots"><i /><i /><i /></span>
              config/config.json
              <div class="raw-viewer-tools">
                <button type="button" @click="revealJson = !revealJson">
                  <AppIcon :name="revealJson ? 'eyeOff' : 'eye'" :size="10" /> {{ revealJson ? '隐藏密钥' : '显示密钥' }}
                </button>
                <button type="button" @click="copyJson"><AppIcon name="copy" :size="10" /> 复制 JSON</button>
                <button type="button" @click="openReload"><AppIcon name="refresh" :size="10" /> 重新读取</button>
              </div>
            </div>
            <pre class="raw-json">{{ formattedJson }}</pre>
          </div>

          <div class="callout warn" style="margin-top:14px">
            <AppIcon name="alert" :size="14" />
            表单保存会只提交改动字段；直接编辑文件会绕过前端校验，请确认字段类型。
          </div>
        </section>

        <div v-if="saveError" class="inline-banner is-error">
          <AppIcon name="alert" :size="14" />
          <span>{{ saveError }}</span>
        </div>

        <div v-if="hasDirty" class="save-bar glass">
          <div class="save-copy">
            <span class="status-dot orange" />
            <strong>{{ dirtyCount }} 项未保存</strong>
            <span>修改后即时生效</span>
          </div>
          <div class="save-actions">
            <button type="button" class="btn btn-ghost btn-sm" :disabled="saving" @click="openConfirm('discard')">放弃</button>
            <button type="button" class="btn btn-primary btn-sm" :disabled="saving" @click="saveConfig">
              <AppIcon v-if="!saving" name="check" :size="13" />
              <span v-else class="button-spinner" />
              {{ saving ? '保存中…' : '保存更改' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <ConfirmDialog
      :open="confirmState.open"
      :title="confirmMeta.title"
      :message="confirmMeta.message"
      :confirm-label="confirmMeta.confirmLabel"
      :danger="confirmMeta.danger"
      :busy="confirmState.busy"
      @confirm="handleConfirm"
      @cancel="handleCancel"
    />
  </div>
</template>
