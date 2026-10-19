import { reactive } from 'vue';
import { api, getErrorMessage } from '@/api/client';

const state = reactive({
  checked: false,
  checking: false,
  pending: false,
  authenticated: false,
  authEnabled: true,
  ttlHours: 24,
  error: '',
});

let inflight: Promise<boolean> | null = null;

export async function ensureSession(force = false): Promise<boolean> {
  if (state.checked && !force) return state.authenticated;
  if (inflight) return inflight;

  state.checking = true;
  state.error = '';
  inflight = (async () => {
    try {
      const session = await api.admin.session();
      state.authenticated = Boolean(session.authenticated);
      state.authEnabled = Boolean(session.auth_enabled);
      state.ttlHours = Number(session.session_ttl_hours) || 24;
      state.checked = true;
      return state.authenticated;
    } catch (error) {
      state.authenticated = false;
      state.checked = true;
      state.error = getErrorMessage(error);
      return false;
    } finally {
      state.checking = false;
      inflight = null;
    }
  })();

  return inflight;
}

async function login(password: string): Promise<void> {
  state.pending = true;
  state.error = '';
  try {
    const result = await api.admin.login(password);
    state.authenticated = Boolean(result.authenticated);
    state.authEnabled = Boolean(result.auth_enabled);
    state.ttlHours = Number(result.session_ttl_hours) || 24;
    state.checked = true;
  } catch (error) {
    state.error = getErrorMessage(error);
    throw error;
  } finally {
    state.pending = false;
  }
}

async function logout(): Promise<void> {
  try {
    await api.admin.logout();
  } catch {
    /* the cookie may already be gone */
  }
  expireSession();
}

function expireSession(message = ''): void {
  state.authenticated = false;
  state.checked = true;
  state.error = message;
}

function resetSession(): void {
  state.checked = false;
  state.authenticated = false;
  state.error = '';
}

export function useSession() {
  return { state, ensureSession, login, logout, expireSession, resetSession };
}
