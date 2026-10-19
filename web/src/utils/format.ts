const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const numberFormatter = new Intl.NumberFormat('zh-CN');

export function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return dateTimeFormatter.format(date);
}

export function formatTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return timeFormatter.format(date);
}

export function formatRelative(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const diff = Date.now() - date.getTime();
  if (diff < 45_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`;
  if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))} 小时前`;
  return `${Math.max(1, Math.round(diff / 86_400_000))} 天前`;
}

export function formatLatency(ms?: number | null): string {
  if (!Number.isFinite(ms)) return '—';
  const value = Number(ms);
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`;
}

export function formatNumber(value?: number | null): string {
  if (!Number.isFinite(value)) return '—';
  return numberFormatter.format(Number(value));
}

export function formatCompact(value?: number | null): string {
  if (!Number.isFinite(value)) return '—';
  const number = Number(value);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 1000) return `${(number / 1000).toFixed(1)}k`;
  return String(Math.round(number));
}

export function formatTokens(log: { usage?: { prompt_tokens?: number | null; completion_tokens?: number | null; total_tokens?: number | null } }): string {
  const usage = log.usage || {};
  const prompt = Number(usage.prompt_tokens);
  const completion = Number(usage.completion_tokens);
  if (Number.isFinite(prompt) || Number.isFinite(completion)) {
    return `${Number.isFinite(prompt) ? prompt : '—'} / ${Number.isFinite(completion) ? completion : '—'}`;
  }
  if (Number.isFinite(Number(usage.total_tokens))) return formatNumber(Number(usage.total_tokens));
  return '—';
}

export type StatusKind = 'ok' | 'warn' | 'err' | 'muted';

export function statusKind(status?: number): StatusKind {
  if (!status) return 'muted';
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 400 && status < 500) return 'warn';
  if (status >= 500) return 'err';
  return 'muted';
}

export function sourceLabel(format?: string | null): string {
  if (format === 'openai') return 'OpenAI';
  if (format === 'gemini') return 'Gemini';
  if (format === 'auto') return '自动路由';
  return format || '未知';
}

export function parseOrigins(value: string): string[] {
  return Array.from(new Set(
    String(value || '')
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  ));
}

export function downloadText(filename: string, content: string, mime = 'application/json'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}
