import { ref } from 'vue';
import { api, getErrorMessage } from '@/api/client';
import type { StatusResponse } from '@/api/types';

const status = ref<StatusResponse | null>(null);
const loading = ref(false);
const error = ref('');
const updatedAt = ref<Date | null>(null);
let inflight: Promise<void> | null = null;

async function refresh(): Promise<void> {
  if (inflight) return inflight;
  loading.value = true;
  error.value = '';
  inflight = (async () => {
    try {
      status.value = await api.status();
      updatedAt.value = new Date();
    } catch (err) {
      error.value = getErrorMessage(err);
    } finally {
      loading.value = false;
      inflight = null;
    }
  })();
  return inflight;
}

async function ensure(): Promise<void> {
  if (!status.value) await refresh();
}

export function useStatus() {
  return { status, loading, error, updatedAt, refresh, ensure };
}
