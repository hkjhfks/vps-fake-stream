import { createRouter, createWebHistory } from 'vue-router';
import AppShell from '@/components/AppShell.vue';
import { ensureSession } from '@/composables/useSession';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      component: AppShell,
      children: [
        { path: '', redirect: { name: 'settings' } },
        { path: 'overview', name: 'overview', component: () => import('@/views/OverviewView.vue') },
        { path: 'settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
        { path: 'playground', name: 'playground', component: () => import('@/views/PlaygroundView.vue') },
        { path: 'logs', name: 'logs', component: () => import('@/views/LogsView.vue') },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: { name: 'settings' } },
  ],
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition;
    return { top: 0 };
  },
});

export function safeNext(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (value.startsWith('/login')) return null;
  return value;
}

router.beforeEach(async (to) => {
  if (to.name === 'login') {
    const authenticated = await ensureSession();
    if (authenticated) {
      return safeNext(to.query.next) || { name: 'settings' };
    }
    return true;
  }

  const authenticated = await ensureSession();
  if (!authenticated) {
    return {
      name: 'login',
      query: { next: to.fullPath },
    };
  }
  return true;
});

export default router;
