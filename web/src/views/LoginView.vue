<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppIcon from '@/components/AppIcon.vue';
import BrandMark from '@/components/BrandMark.vue';
import { ApiError } from '@/api/client';
import { useSession } from '@/composables/useSession';
import { useStatus } from '@/composables/useStatus';
import { useToast } from '@/composables/useToast';
import { safeNext } from '@/router';

const route = useRoute();
const router = useRouter();
const { state, login, ensureSession } = useSession();
const { status, ensure } = useStatus();
const { showToast } = useToast();

const password = ref('');
const showPassword = ref(false);
const pending = computed(() => state.pending);
const error = ref('');
const passwordInput = ref<HTMLInputElement | null>(null);

const notice = computed(() => {
  if (route.query.reason === 'password-changed') return '管理员密码已更新，请使用新密码重新登录。';
  if (route.query.expired === '1' || route.query.reason === 'expired') return '会话已过期，请重新登录。';
  return '';
});

const authEnabled = computed(() => state.authEnabled);
const serviceOnline = computed(() => status.value?.status === 'ok');
const version = computed(() => status.value?.version || '1.0.0');

function redirectAfterLogin() {
  const next = safeNext(route.query.next);
  return router.replace(next || { name: 'settings' });
}

async function submit() {
  error.value = '';
  const value = password.value.trim();
  if (!value) {
    error.value = '请输入管理员密码';
    passwordInput.value?.focus();
    return;
  }

  try {
    await login(value);
    showToast('登录成功', 'success');
    await redirectAfterLogin();
  } catch (err) {
    if (err instanceof ApiError && err.status === 429) {
      const seconds = err.retryAfter;
      error.value = seconds
        ? `尝试次数过多，请在 ${Math.max(1, Math.ceil(seconds / 60))} 分钟后再试`
        : '尝试次数过多，请稍后再试';
    } else if (err instanceof ApiError && err.type === 'admin_not_configured') {
      error.value = '管理员密码尚未配置';
      await refreshSession();
    } else {
      error.value = err instanceof Error ? err.message : '登录失败，请重试';
    }
    await nextTick();
    passwordInput.value?.focus();
  }
}

async function refreshSession() {
  await ensureSession(true);
  if (state.authenticated) {
    await redirectAfterLogin();
    return;
  }
  if (state.authEnabled) showToast('已重新检查登录状态', 'info');
}

async function togglePassword() {
  showPassword.value = !showPassword.value;
  await nextTick();
  passwordInput.value?.focus();
}

onMounted(async () => {
  ensure();
  if (state.authenticated) {
    await redirectAfterLogin();
    return;
  }
  await nextTick();
  passwordInput.value?.focus();
});
</script>

<template>
  <div class="login-shell">
    <div class="login-orbit-wrap" aria-hidden="true">
      <div class="login-orbit" />
    </div>

    <div class="login-top">
      <div class="brand">
        <BrandMark />
        <div class="brand-text">
          <strong>FakeStream</strong>
          <span>伪流式代理控制台</span>
        </div>
      </div>
      <div class="login-side-status">
        <span class="status-dot" :class="serviceOnline ? 'is-live' : 'gray'" />
        {{ serviceOnline ? '服务在线' : '服务连接中' }}
      </div>
    </div>

    <section class="login-card glass" aria-labelledby="loginTitle">
      <div class="login-mark">
        <AppIcon name="waveform" :size="26" />
      </div>
      <h1 id="loginTitle" class="login-title">欢迎回来</h1>
      <p class="login-sub">登录以进入 FakeStream 控制台：配置、调试台与请求日志。</p>

      <div v-if="notice" class="login-banner">
        <AppIcon name="info" :size="13" />
        <span>{{ notice }}</span>
      </div>

      <form v-if="authEnabled" class="login-form" @submit.prevent="submit">
        <label class="field">
          <span class="field-label">管理员密码 <span class="label-hint">仅限本人</span></span>
          <span class="input-wrap">
            <AppIcon name="lock" :size="15" />
            <input
              ref="passwordInput"
              v-model="password"
              class="input"
              :type="showPassword ? 'text' : 'password'"
              placeholder="输入 ADMIN_PASSWORD"
              autocomplete="current-password"
              aria-label="管理员密码"
              :disabled="pending"
            >
            <button
              type="button"
              class="input-action"
              :title="showPassword ? '隐藏密码' : '显示密码'"
              @click="togglePassword"
            >
              <AppIcon :name="showPassword ? 'eyeOff' : 'eye'" :size="14" />
            </button>
          </span>
        </label>

        <button class="btn btn-primary" type="submit" :disabled="pending">
          <AppIcon v-if="!pending" name="arrowRight" :size="15" />
          <span v-else class="button-spinner" />
          {{ pending ? '验证中…' : '进入控制台' }}
        </button>
      </form>

      <div v-else class="login-setup">
        <div class="login-setup-title">
          <AppIcon name="alert" :size="15" />
          管理员密码未配置
        </div>
        <p>在 <code>config/config.json</code> 中设置 <code>ADMIN_PASSWORD</code>，保存后热读取生效，无需重启。</p>
        <pre class="login-setup-code">{
  "ADMIN_PASSWORD": "your-strong-password"
}</pre>
        <button type="button" class="btn btn-secondary btn-sm" @click="refreshSession">
          <AppIcon name="refresh" :size="13" />
          重新检查
        </button>
      </div>

      <div v-if="error" class="login-error" role="alert">
        <AppIcon name="alert" :size="12" />
        <span>{{ error }}</span>
      </div>

      <div class="login-meta">
        <AppIcon name="shield" :size="12" />
        会话有效期 {{ state.ttlHours }} 小时 · 连续失败会暂时锁定
      </div>
    </section>

    <div class="login-foot">FakeStream v{{ version }} · 仅管理员访问</div>
  </div>
</template>
