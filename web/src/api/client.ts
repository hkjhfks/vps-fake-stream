import type {
  AppConfig,
  ConfigResponse,
  LoginResponse,
  LogsResponse,
  ModelsResponse,
  RequestLog,
  SessionInfo,
  StatusResponse,
} from './types';

export class ApiError extends Error {
  status: number;
  type: string;
  retryAfter: number | null;

  constructor(message: string, status = 0, type = 'request_failed', retryAfter: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
    this.retryAfter = retryAfter;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  admin?: boolean;
  skipAuthEvent?: boolean;
  signal?: AbortSignal;
  /** Return null for 304 Not Modified instead of throwing. */
  notModifiedAsNull?: boolean;
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, Math.round((at - Date.now()) / 1000));
  return null;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.headers || {}),
  };

  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers,
      body,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('网络连接失败，请检查服务是否在线', 0, 'network_error');
  }

  // A fetched 304 keeps its cached body in most browsers, but guard for the
  // case where the status surfaces to script.
  if (response.status === 304 && options.notModifiedAsNull) {
    return null as unknown as T;
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const errorRecord = record.error && typeof record.error === 'object'
      ? record.error as Record<string, unknown>
      : record;
    const message = typeof errorRecord.message === 'string'
      ? errorRecord.message
      : typeof payload === 'string' && payload
        ? payload.slice(0, 240)
        : `请求失败（${response.status}）`;
    const type = typeof errorRecord.type === 'string' ? errorRecord.type : 'request_failed';
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));

    if (response.status === 401 && options.admin && !options.skipAuthEvent) {
      window.dispatchEvent(new CustomEvent('fake-stream:auth-expired'));
    }

    throw new ApiError(message, response.status, type, retryAfter);
  }

  return payload as T;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '未知错误';
}

export const api = {
  admin: {
    session: () => request<SessionInfo>('/api/admin/session', { skipAuthEvent: true }),
    login: (password: string) => request<LoginResponse>('/api/admin/login', {
      method: 'POST',
      body: { password },
      skipAuthEvent: true,
    }),
    logout: () => request<{ status: string }>('/api/admin/logout', {
      method: 'POST',
      skipAuthEvent: true,
    }),
  },

  status: () => request<StatusResponse>('/api/status'),

  models: () => request<ModelsResponse>('/api/models?simple=1'),

  config: {
    get: () => request<ConfigResponse>('/api/config', { admin: true }),
    save: (patch: Partial<AppConfig>) => request<ConfigResponse>('/api/config', {
      method: 'PUT',
      body: patch,
      admin: true,
    }),
  },

  logs: {
    /** Resolves to null when the server answers 304 Not Modified. */
    list: (limit = 200, full = false) => {
      const query = `/api/logs?limit=${encodeURIComponent(String(limit))}${full ? '&full=1' : ''}`;
      return request<LogsResponse | null>(query, { admin: true, notModifiedAsNull: true });
    },
    detail: (id: string) => request<{ status: string; log: RequestLog }>(
      `/api/logs/${encodeURIComponent(id)}`,
      { admin: true },
    ),
    clear: () => request<{ status: string; message: string }>('/api/logs', { method: 'DELETE', admin: true }),
  },
};

export function extractModelIds(payload: ModelsResponse): string[] {
  const list = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];

  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of list) {
    const raw = typeof item === 'string'
      ? item
      : item?.id || item?.name || item?.model || '';
    const id = String(raw).trim().replace(/^models\//, '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}
