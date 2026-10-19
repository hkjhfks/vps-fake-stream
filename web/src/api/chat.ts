import { ApiError, getErrorMessage } from './client';
import type { ChatMessage, StreamEvent, TokenUsage } from './types';

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  temperature?: number;
  apiKey?: string;
}

export interface ChatCallbacks {
  onDelta?: (content: string, fullContent: string) => void;
  onEvent?: (event: StreamEvent) => void;
}

export interface ChatResult {
  content: string;
  usage: Partial<TokenUsage>;
  finishReason: string | null;
  requestId: string | null;
  chunks: number;
  chunkSizes: number[];
  firstChunkMs: number | null;
  totalMs: number;
  aborted: boolean;
  rawEvents: StreamEvent[];
}

function contentFromPayload(payload: any): string {
  const choice = payload?.choices?.[0];
  const content = choice?.delta?.content ?? choice?.message?.content ?? choice?.text ?? '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  return '';
}

function usageFromPayload(payload: any): Partial<TokenUsage> {
  const usage = payload?.usage || {};
  return {
    prompt_tokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null,
    completion_tokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null,
    total_tokens: Number.isFinite(usage.total_tokens) ? usage.total_tokens : null,
  };
}

function sseData(rawEvent: string): string | null {
  const lines = rawEvent.split(/\r?\n/);
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length ? data.join('\n') : null;
}

export async function sendChat(
  request: ChatRequest,
  callbacks: ChatCallbacks = {},
  signal?: AbortSignal,
): Promise<ChatResult> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), 180_000);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const startedAt = performance.now();
  const rawEvents: StreamEvent[] = [];
  const chunkSizes: number[] = [];
  let content = '';
  let firstChunkAt: number | null = null;
  let usage: Partial<TokenUsage> = {};
  let finishReason: string | null = null;

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (request.apiKey?.trim()) headers.Authorization = `Bearer ${request.apiKey.trim()}`;

    let response: Response;
    try {
      response = await fetch('/api/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: request.stream,
          temperature: request.temperature,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new ApiError('请求已停止', 0, 'aborted');
      throw new ApiError('网络连接失败，请检查服务是否在线', 0, 'network_error');
    }

    const requestId = response.headers.get('x-request-id');

    if (!response.ok) {
      const text = await response.text();
      let payload: any = null;
      try { payload = JSON.parse(text); } catch { /* ignore */ }
      const message = payload?.error?.message || text.slice(0, 240) || `请求失败（${response.status}）`;
      throw new ApiError(message, response.status, payload?.error?.type || 'request_failed');
    }

    if (!request.stream) {
      const payload = await response.json();
      content = contentFromPayload(payload);
      usage = usageFromPayload(payload);
      finishReason = payload?.choices?.[0]?.finish_reason ?? null;
      const totalMs = Math.round(performance.now() - startedAt);
      return {
        content,
        usage,
        finishReason,
        requestId,
        chunks: content ? 1 : 0,
        chunkSizes: content ? [content.length] : [],
        firstChunkMs: content ? totalMs : null,
        totalMs,
        aborted: false,
        rawEvents,
      };
    }

    if (!response.body) throw new ApiError('上游没有返回可读的流', 502, 'empty_stream');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;

    while (!done) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch (error) {
        if (controller.signal.aborted) break;
        throw new ApiError('流式连接中断', 0, 'stream_error');
      }
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });

      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] || '\n\n';
        buffer = buffer.slice(boundary + separator.length);

        const data = sseData(rawEvent);
        if (data === null) {
          boundary = buffer.search(/\r?\n\r?\n/);
          continue;
        }
        if (data === '[DONE]') {
          done = true;
          break;
        }

        let payload: any;
        try { payload = JSON.parse(data); } catch { payload = null; }
        if (!payload) {
          boundary = buffer.search(/\r?\n\r?\n/);
          continue;
        }

        const event: StreamEvent = { at: Math.round(performance.now() - startedAt), data: payload };
        rawEvents.push(event);
        callbacks.onEvent?.(event);

        if (payload?.error?.message) {
          throw new ApiError(String(payload.error.message), response.status, 'upstream_error');
        }

        const delta = contentFromPayload(payload);
        if (delta) {
          if (firstChunkAt === null) firstChunkAt = performance.now() - startedAt;
          content += delta;
          chunkSizes.push(delta.length);
          callbacks.onDelta?.(delta, content);
        }

        const nextUsage = usageFromPayload(payload);
        if (nextUsage.prompt_tokens !== null || nextUsage.completion_tokens !== null || nextUsage.total_tokens !== null) {
          usage = nextUsage;
        }
        const nextFinish = payload?.choices?.[0]?.finish_reason;
        if (nextFinish) finishReason = nextFinish;

        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }

    const aborted = controller.signal.aborted && !done;
    const totalMs = Math.round(performance.now() - startedAt);
    return {
      content,
      usage,
      finishReason,
      requestId,
      chunks: chunkSizes.length,
      chunkSizes,
      firstChunkMs: firstChunkAt === null ? null : Math.round(firstChunkAt),
      totalMs,
      aborted,
      rawEvents,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        content,
        usage,
        finishReason,
        requestId: null,
        chunks: chunkSizes.length,
        chunkSizes,
        firstChunkMs: firstChunkAt === null ? null : Math.round(firstChunkAt),
        totalMs: Math.round(performance.now() - startedAt),
        aborted: true,
        rawEvents,
      };
    }
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new ApiError('请求超时（180 秒）', 0, 'timeout');
    }
    throw new ApiError(getErrorMessage(error), 0, 'stream_error');
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}
