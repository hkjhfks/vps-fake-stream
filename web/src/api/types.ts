export type UpstreamFormat = 'openai' | 'gemini' | 'auto';

export interface AppConfig {
  OPENAI_API_KEY: string;
  SOURCE_API_URL: string;
  UPSTREAM_FORMAT: UpstreamFormat;
  GEMINI_API_KEY: string;
  GEMINI_BASE_URL: string;
  GEMINI_API_VERSION: string;
  CORS_ALLOW_ORIGIN: string;
  ALLOW_ENV_API_KEY: boolean;
  ADMIN_PASSWORD: string;
  ADMIN_SESSION_TTL_HOURS: number;
  HEARTBEAT_INTERVAL_MS: number;
  CHUNK_TARGET_LENGTH: number;
  CHUNK_DELAY_MS: number;
  DEBUG: boolean;
  UPSTREAM_EXTRA_HEADERS_JSON: string;
  LOG_MAX_OUTPUT_CHARS: number;
  LOG_RETENTION: number;
}

export type ConfigKey = keyof AppConfig;

export interface ConfigResponse {
  status: string;
  config: AppConfig;
  config_path: string;
}

export interface SessionInfo {
  status: string;
  authenticated: boolean;
  auth_enabled: boolean;
  session_ttl_hours: number;
  cookie_name?: string;
}

export interface LoginResponse {
  status: string;
  message: string;
  authenticated: boolean;
  auth_enabled: boolean;
  session_ttl_hours: number;
}

export interface StatusResponse {
  status: string;
  message: string;
  timestamp: string;
  version: string;
  features: Record<string, boolean>;
  endpoints: Record<string, string>;
  environment: {
    has_api_key: boolean;
    has_gemini_api_key: boolean;
    upstream_format: UpstreamFormat;
    source_api_url: string;
    gemini_base_url: string;
    gemini_api_version: string;
    allow_env_api_key: boolean;
    admin_auth_enabled: boolean;
    admin_session_ttl_hours: number;
    heartbeat_interval_ms: number;
    config_path: string;
  };
}

export interface TokenUsage {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
}

export interface RequestLog {
  id: string;
  request_id?: string;
  created_at: string;
  client_ip?: string;
  user_agent?: string;
  endpoint?: string;
  method?: string;
  model?: string;
  upstream_format?: string;
  stream?: boolean;
  status_code?: number;
  response_ms?: number;
  message_count?: number;
  temperature?: number | null;
  max_tokens?: number | null;
  usage?: Partial<TokenUsage>;
  /** Only present on the detail endpoint (`/api/logs/:id`) and `?full=1`. */
  output_text?: string;
  output_chars?: number;
  /** First 160 characters of the output; present on list rows. */
  output_preview?: string;
  has_output?: boolean;
  finish_reason?: string | null;
  error?: { message?: string; type?: string } | null;
  client_aborted?: boolean;
}

export interface LogsResponse {
  status: string;
  count: number;
  logs: RequestLog[];
  log_path: string;
}

export interface ModelInfo {
  id: string;
  object?: string;
  provider?: string;
}

export interface ModelSource {
  format: string;
  base_url: string;
  ok: boolean;
  count: number;
  error?: string;
}

export interface ModelsResponse {
  object?: string;
  data?: Array<{ id?: string; name?: string; model?: string }>;
  models?: Array<{ id?: string; name?: string; model?: string }>;
  count?: number;
  upstream_format?: UpstreamFormat;
  source_api_url?: string;
  sources?: ModelSource[];
  fetched_at?: string;
  error?: { message?: string };
}

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatCompletionChoice {
  index: number;
  message?: { role: string; content: string | null };
  delta?: { role?: string; content?: string };
  finish_reason?: string | null;
}

export interface ChatCompletionResponse {
  id?: string;
  object?: string;
  model?: string;
  choices?: ChatCompletionChoice[];
  usage?: Partial<TokenUsage>;
  error?: { message?: string; type?: string };
}

export interface StreamEvent {
  at: number;
  data: unknown;
}
