import { reactive } from 'vue';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastItem {
  id: string;
  kind: ToastKind;
  message: string;
}

const toasts = reactive<ToastItem[]>([]);
const timers = new Map<string, number>();

function makeId() {
  return `toast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function dismissToast(id: string) {
  const index = toasts.findIndex((item) => item.id === id);
  if (index !== -1) toasts.splice(index, 1);
  const timer = timers.get(id);
  if (timer) window.clearTimeout(timer);
  timers.delete(id);
}

function showToast(message: string, kind: ToastKind = 'info', duration = 2800) {
  const id = makeId();
  toasts.push({ id, kind, message });
  while (toasts.length > 4) {
    const oldest = toasts.shift();
    if (oldest) {
      const timer = timers.get(oldest.id);
      if (timer) window.clearTimeout(timer);
      timers.delete(oldest.id);
    }
  }
  const timer = window.setTimeout(() => dismissToast(id), duration);
  timers.set(id, timer);
  return id;
}

export function useToast() {
  return { toasts, showToast, dismissToast };
}
