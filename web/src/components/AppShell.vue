<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import AppIcon from './AppIcon.vue';
import BrandMark from './BrandMark.vue';
import { useSession } from '@/composables/useSession';
import { useStatus } from '@/composables/useStatus';
import { useTheme } from '@/composables/useTheme';
import { useToast } from '@/composables/useToast';
import { sourceLabel } from '@/utils/format';
import type { IconName } from './iconPaths';

interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  to: string;
}

const navItems: NavItem[] = [
  { id: 'overview', label: '概览', icon: 'overview', to: '/overview' },
  { id: 'settings', label: '设置', icon: 'settings', to: '/settings' },
  { id: 'playground', label: '调试台', icon: 'chat', to: '/playground' },
  { id: 'logs', label: '请求日志', icon: 'logs', to: '/logs' },
];

const route = useRoute();
const router = useRouter();
const { state: session, logout } = useSession();
const { status, ensure } = useStatus();
const { label: themeLabel } = useTheme();
const { showToast } = useToast();

const statusOk = computed(() => status.value?.status === 'ok');
const upstream = computed(() => sourceLabel(status.value?.environment.upstream_format));
const version = computed(() => status.value?.version || '1.0.0');
const sessionLabel = computed(() => `会话 ${session.ttlHours}h`);

function isActive(id: string) {
  return route.name === id;
}

function openAppearance() {
  router.push({ name: 'settings', query: { section: 'appearance' } });
}

async function handleLogout() {
  await logout();
  showToast('已退出登录', 'success');
  await router.replace({ name: 'login' });
}

onMounted(() => {
  ensure();
});
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar glass" aria-label="主导航">
      <RouterLink class="brand" to="/overview" aria-label="FakeStream 概览">
        <BrandMark />
        <div class="brand-text">
          <strong>FakeStream</strong>
          <span>伪流式代理控制台</span>
        </div>
      </RouterLink>

      <nav class="nav">
        <RouterLink
          v-for="item in navItems"
          :key="item.id"
          :to="item.to"
          class="nav-item"
          :class="{ 'is-active': isActive(item.id) }"
          :aria-current="isActive(item.id) ? 'page' : undefined"
        >
          <AppIcon :name="item.icon" :size="18" class="nav-icon" />
          <span class="nav-label">{{ item.label }}</span>
        </RouterLink>
      </nav>

      <div class="sidebar-spacer" />

      <div class="side-card">
        <div class="side-status">
          <span class="status-dot" :class="statusOk ? 'is-live' : 'gray'" />
          <div class="side-status-main">
            <strong>{{ statusOk ? '服务运行中' : '状态未知' }}</strong>
            <span>{{ upstream }}</span>
          </div>
          <span class="side-version">v{{ version.split('.').slice(0, 2).join('.') }}</span>
        </div>
      </div>

      <button type="button" class="side-row" @click="openAppearance">
        <AppIcon :name="themeLabel === '深色' ? 'moon' : themeLabel === '浅色' ? 'sun' : 'monitor'" :size="15" class="nav-icon" />
        <span>外观</span>
        <span class="side-row-value">{{ themeLabel }}</span>
        <AppIcon name="chevronRight" :size="12" class="side-row-chevron" />
      </button>

      <div class="side-user">
        <span class="avatar">A</span>
        <div class="side-user-main">
          <strong>管理员</strong>
          <span>{{ sessionLabel }}</span>
        </div>
        <button type="button" class="side-logout" title="退出登录" @click="handleLogout">
          <AppIcon name="logout" :size="14" />
        </button>
      </div>
    </aside>

    <header class="mobile-topbar glass">
      <RouterLink class="mobile-brand" to="/overview" aria-label="回到概览">
        <BrandMark :size="15" />
        <strong>FakeStream</strong>
        <span class="mobile-brand-sub">控制台</span>
      </RouterLink>
      <div class="mobile-status">
        <span class="status-dot" :class="statusOk ? 'is-live' : 'gray'" />
        {{ statusOk ? '在线' : '未知' }}
      </div>
    </header>

    <main class="main" id="mainContent">
      <RouterView v-slot="{ Component }">
        <Transition name="page" mode="out-in">
          <component :is="Component" />
        </Transition>
      </RouterView>
    </main>

    <nav class="mobile-tabbar glass" aria-label="移动端导航">
      <RouterLink
        v-for="item in navItems"
        :key="item.id"
        :to="item.to"
        class="mobile-tab"
        :class="{ 'is-active': isActive(item.id) }"
        :aria-current="isActive(item.id) ? 'page' : undefined"
      >
        <span class="tab-icon"><AppIcon :name="item.icon" :size="18" /></span>
        <span>{{ item.label }}</span>
      </RouterLink>
    </nav>
  </div>
</template>
