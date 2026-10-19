import { computed, ref } from 'vue';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'fake-stream-theme';
const mode = ref<ThemeMode>('system');
const systemDark = ref(false);
let initialized = false;

function readStoredMode(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    /* ignore */
  }
  return 'system';
}

const resolved = computed<ResolvedTheme>(() => (
  mode.value === 'system' ? (systemDark.value ? 'dark' : 'light') : mode.value
));

const label = computed(() => {
  if (mode.value === 'system') return '跟随系统';
  return mode.value === 'dark' ? '深色' : '浅色';
});

function applyTheme() {
  if (typeof document === 'undefined') return;
  const theme = resolved.value;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.variant = theme === 'dark' ? 'graphite' : 'frost';
  root.style.colorScheme = theme;
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    meta.setAttribute('content', theme === 'dark' ? '#0d0d10' : '#f3f4f7');
  });
}

function initTheme() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  mode.value = readStoredMode();

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  systemDark.value = media.matches;
  media.addEventListener('change', (event) => {
    systemDark.value = event.matches;
    if (mode.value === 'system') applyTheme();
  });

  applyTheme();
}

function setMode(next: ThemeMode) {
  mode.value = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
  applyTheme();
}

export function useTheme() {
  initTheme();
  return { mode, resolved, systemDark, label, setMode, initTheme, applyTheme };
}
