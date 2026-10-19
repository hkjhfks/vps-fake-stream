<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import ToastHost from '@/components/ToastHost.vue';
import { useSession } from '@/composables/useSession';
import { useTheme } from '@/composables/useTheme';
import { useToast } from '@/composables/useToast';

const route = useRoute();
const router = useRouter();
const { expireSession } = useSession();
const { initTheme } = useTheme();
const { showToast } = useToast();
const redirecting = ref(false);

initTheme();

function handleAuthExpired() {
  if (redirecting.value || route.name === 'login') return;
  redirecting.value = true;
  expireSession('会话已过期，请重新登录');
  showToast('会话已过期，请重新登录', 'error');
  const next = route.fullPath;
  router.replace({ name: 'login', query: { next, expired: '1' } }).finally(() => {
    redirecting.value = false;
  });
}

onMounted(() => {
  window.addEventListener('fake-stream:auth-expired', handleAuthExpired);
});

onBeforeUnmount(() => {
  window.removeEventListener('fake-stream:auth-expired', handleAuthExpired);
});
</script>

<template>
  <div class="ambient" aria-hidden="true">
    <span class="orb orb-a" />
    <span class="orb orb-b" />
    <span class="orb orb-c" />
  </div>
  <div class="grain" aria-hidden="true" />

  <a class="skip-link" href="#mainContent">跳到主内容</a>

  <RouterView v-slot="{ Component }">
    <component :is="Component" />
  </RouterView>

  <ToastHost />
</template>
