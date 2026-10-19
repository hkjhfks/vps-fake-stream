import type { StreamEvent } from '@/api/types';

/** A message that will never change again, so its rendered HTML is computed once. */
export interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  html: string;
  model: string;
  aborted: boolean;
  error: string;
  createdAt: number;
}

export interface Metrics {
  /** Incremented for every request so child views can reset local UI state. */
  runId: number;
  active: boolean;
  streaming: boolean;
  ttft: number | null;
  total: number | null;
  chunks: number;
  chars: number;
  chunkSizes: number[];
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  requestId: string;
  aborted: boolean;
  model: string;
  temperature: number;
  rawEvents: StreamEvent[];
}
