# vps-fake-stream

一个部署在 VPS 上的 Node.js 代理服务，用来把上游一次性返回的 Chat Completion 结果改造成伪流式 SSE。

对外始终提供 OpenAI 风格接口（`/v1/chat/completions`、`/v1/models`），上游支持两种格式：

- OpenAI Chat Completions
- Google Gemini `generateContent`

它适合这种场景：

- 你的客户端只认识 OpenAI 风格接口
- 上游可能是 OpenAI 兼容服务，也可能是 Gemini，并且只返回非流式结果
- 你希望前端消费流式输出，但不想改上游
- 你不想每次改配置都去改环境变量再重启服务
- 你需要一个简单的网页来改配置、看日志和检查服务状态

## 功能概览

- 兼容接口：
  - `POST /v1/chat/completions`
  - `GET /v1/models`
- 上游格式（`UPSTREAM_FORMAT`）：
  - `openai`：OpenAI Chat Completions
  - `gemini`：Google Gemini `generateContent`
  - `auto`：按模型名自动选择（`gemini*` / `gemma*` 走 Gemini，其余走 OpenAI）
- 模型列表简化模式：
  - `GET /api/models?simple=1`
  - 返回统一格式的模型 ID 列表，便于前端直接渲染下拉框
  - `gemini` / `auto` 模式下会把 Gemini 模型列表转换为 OpenAI 风格
- 配置文件热读取：
  - 配置存放在 `config/config.json`
  - 修改后无需重启进程
- 管理登录：
  - `ADMIN_PASSWORD` 保护配置页、日志页和管理 API
  - 登录后使用 HttpOnly Cookie 保持会话
- 内置页面：
  - `/` 测试请求
  - `/admin.html` 管理登录
  - `/config.html` 配置中心
  - `/logs.html` 请求日志
- 请求日志：
  - 记录请求元信息、输出内容、token 用量、响应时间
  - 不记录输入文本

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动服务

```bash
npm run start
```

默认监听 `3000` 端口，也可以这样改：

```bash
PORT=8080 npm run start
```

### 3. 初始化管理员密码

第一次启动后，先编辑 `config/config.json`，至少设置：

```json
{
  "ADMIN_PASSWORD": "your-strong-password"
}
```

然后访问：

- `http://你的IP:端口/admin.html`
- 登录后再进入 `http://你的IP:端口/config.html`

## 配置文件

配置文件路径：`config/config.json`

| 字段 | 说明 | 默认值 |
| --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI 上游兜底 API Key；Gemini Key 留空时也会作为 Gemini 的兜底 | 空 |
| `SOURCE_API_URL` | OpenAI 兼容上游的根地址；`UPSTREAM_FORMAT=gemini` 时不使用 | `https://api.openai.com` |
| `UPSTREAM_FORMAT` | 上游接口格式：`openai`、`gemini` 或 `auto` | `openai` |
| `GEMINI_API_KEY` | Gemini 上游 API Key；留空时回退到 `OPENAI_API_KEY` | 空 |
| `GEMINI_BASE_URL` | Gemini API 根地址，可填自定义 Gemini 兼容网关 | `https://generativelanguage.googleapis.com` |
| `GEMINI_API_VERSION` | Gemini API 版本 | `v1beta` |
| `CORS_ALLOW_ORIGIN` | CORS 允许来源，支持单个域名、逗号分隔或换行分隔多个域名 | `*` |
| `ALLOW_ENV_API_KEY` | 请求未带 API Key 时，是否回退到配置文件里的 Key | `false` |
| `ADMIN_PASSWORD` | 管理页面和管理 API 的登录密码 | 空 |
| `ADMIN_SESSION_TTL_HOURS` | 管理会话有效期，单位小时 | `24` |
| `HEARTBEAT_INTERVAL_MS` | SSE 心跳间隔 | `3000` |
| `CHUNK_TARGET_LENGTH` | 伪流式分块目标长度 | `30` |
| `CHUNK_DELAY_MS` | 分块发送延迟 | `35` |
| `DEBUG` | 是否输出调试日志 | `false` |
| `UPSTREAM_EXTRA_HEADERS_JSON` | 额外上游请求头，JSON 对象字符串 | 空 |
| `LOG_MAX_OUTPUT_CHARS` | 日志中最多保存多少输出字符 | `12000` |
| `LOG_RETENTION` | 日志最多保留多少条 | `2000` |

说明：

- 服务每次请求都会按文件 mtime 检查配置是否变化
- 你可以手动改文件，也可以通过 `/config.html` 保存
- 如果 `ADMIN_PASSWORD` 为空，管理页和管理 API 会要求先配置密码
- `CORS_ALLOW_ORIGIN` 可填写 `https://a.example.com, https://b.example.com`，服务会按请求头里的 `Origin` 精确匹配并回显

## 上游格式

### `openai`（默认）

- 请求地址：`{SOURCE_API_URL}/v1/chat/completions`
- 鉴权：`Authorization: Bearer <key>`
- 响应原样返回给客户端（流式时由本服务拆分）
- 模型列表：`{SOURCE_API_URL}/v1/models`

### `gemini`

- 请求地址：`{GEMINI_BASE_URL}/{GEMINI_API_VERSION}/models/{model}:generateContent`
- 鉴权：`x-goog-api-key: <key>`（请求方传 `Authorization: Bearer` 也可以）
- 上游固定使用非流式 `generateContent`，伪流式由本服务完成
- 模型列表：`{GEMINI_BASE_URL}/{GEMINI_API_VERSION}/models`
- 模型名可以写成 `gemini-2.5-flash`、`models/gemini-2.5-flash` 或 `tunedModels/xxx`

直接使用 Gemini 的配置示例：

```json
{
  "UPSTREAM_FORMAT": "gemini",
  "GEMINI_API_KEY": "AIza...",
  "GEMINI_BASE_URL": "https://generativelanguage.googleapis.com",
  "GEMINI_API_VERSION": "v1beta",
  "ALLOW_ENV_API_KEY": true
}
```

### `auto`

`auto` 会按模型名选择上游：

- `gemini*`、`gemma*`、`models/*`、`tunedModels/*` → Gemini
- 其它 → OpenAI

两条通道各用各的配置：

- OpenAI：`SOURCE_API_URL` + `OPENAI_API_KEY`
- Gemini：`GEMINI_BASE_URL` + `GEMINI_API_KEY`

示例：一个代理同时提供 `gpt-4o-mini` 与 `gemini-2.5-flash`。

```json
{
  "UPSTREAM_FORMAT": "auto",
  "SOURCE_API_URL": "https://api.openai.com",
  "OPENAI_API_KEY": "sk-...",
  "GEMINI_API_KEY": "AIza...",
  "ALLOW_ENV_API_KEY": true
}
```

> `auto` 是“按模型名路由”，不是“失败后自动重试另一个上游”。如果某个模型名在两边都存在，会按上面的前缀规则判断。

### 鉴权优先级

1. 请求头 `x-goog-api-key` / `Authorization: Bearer <key>`
   - Gemini 格式优先使用 `x-goog-api-key`
   - OpenAI 格式优先使用 `Authorization`
2. 请求头没有 Key 且 `ALLOW_ENV_API_KEY=true` 时回退到配置文件：
   - Gemini：`GEMINI_API_KEY` → `OPENAI_API_KEY`
   - OpenAI：`OPENAI_API_KEY`

### OpenAI → Gemini 转换说明

| OpenAI 请求 | Gemini 请求 |
| --- | --- |
| `messages[role=system/developer]` | `systemInstruction.parts[]` |
| `messages[role=user]` | `contents[role=user].parts[]` |
| `messages[role=assistant]` | `contents[role=model].parts[]` |
| `assistant.tool_calls` | `functionCall` part |
| `messages[role=tool/function]` | `functionResponse` part（需要能解析函数名） |
| `content[type=text]` | `{ text }` |
| `content[type=image_url]` 的 `data:` URL | `inlineData` |
| `content[type=input_audio]` | `inlineData` |
| `content[type=file]` 的 `file_data` | `inlineData`（PDF 等） |
| `temperature` / `top_p` / `top_k` | `generationConfig.temperature` / `topP` / `topK` |
| `max_tokens` / `max_completion_tokens` | `maxOutputTokens` |
| `stop`（最多 5 个） | `stopSequences` |
| `presence_penalty` / `frequency_penalty` / `seed` | `presencePenalty` / `frequencyPenalty` / `seed` |
| `response_format=json_object` | `responseMimeType=application/json` |
| `response_format=json_schema` | `responseMimeType` + `responseSchema` |
| `tools` / `functions` | `tools[].functionDeclarations[]` |
| `tool_choice` | `toolConfig.functionCallingConfig` |
| `reasoning_effort`（仅 Gemini 3） | `generationConfig.thinkingConfig.thinkingLevel` |

Gemini 响应会转换成 OpenAI 形状：

- `candidates[]` → `choices[]`
- `candidates[].content.parts[].text` → `message.content`
- `functionCall` → `message.tool_calls`
- `usageMetadata.promptTokenCount` / `candidatesTokenCount` / `thoughtsTokenCount` → OpenAI `usage`
- `finishReason` 映射：`STOP → stop`、`MAX_TOKENS → length`、`SAFETY/BLOCKLIST/... → content_filter`、有工具调用 → `tool_calls`
- 被 prompt 安全策略拦截时返回 `finish_reason=content_filter` 和空内容

限制与注意事项：

- 远程图片 URL（`http(s)://...`）不会由本服务代下载（避免 SSRF）。请传 `data:` URL，或先通过 Gemini File API 上传。
- 不支持 OpenAI File API 的 `file_id`，请使用内联 `file_data`。
- 请求体上限由 `express.json({ limit: '2mb' })` 控制，内联图片/音频不宜过大。
- Gemini 的 thought part 默认不会拼进 `content`；如果显式设置 `thinkingConfig.includeThoughts=true`，会按上游返回拼接。`usage.completion_tokens` 始终包含 thinking tokens。
- 非流式请求如果上游返回多个 candidate，会全部转成 `choices`；伪流式只发送第一个 candidate。
- 函数名必须符合 Gemini 命名要求（字母、数字、`_`、`.`、`:`、`-`，最长 64 字符），否则请求会直接返回 400。
- 默认按官方 Gemini 的 `x-goog-api-key` 发送 Key。自定义 Gemini 兼容网关如果只接受 `Authorization: Bearer`，可以在 `UPSTREAM_EXTRA_HEADERS_JSON` 里追加静态 `Authorization` 头；不要对官方 `generativelanguage.googleapis.com` 同时带 `Authorization`，否则 Google 会把它当成 OAuth 凭证并返回 401。
- Gemini 3 的工具调用会返回 `thoughtSignature`。本服务把它放在 `message.tool_calls[].extra_content.google.thought_signature`（流式在 `delta.tool_calls[].extra_content`）。多轮工具调用时必须把这个字段原样带回，否则 Gemini 3 可能返回 400 `Function call is missing a thought_signature`。如果你的客户端会丢弃未知字段，需要自行把它存进会话状态再放回 `tool_calls`；如果历史来自其它模型、确实没有签名，可以显式填 `skip_thought_signature_validator` 跳过校验。
- Gemini 的 `responseSchema` 是 OpenAPI Schema 子集；本服务会做 JSON Schema → Gemini Schema 转换，`additionalProperties`、`$defs` 等不支持的字段会被丢弃或内联。

## API

### Chat

- `POST /api/chat`
- `POST /v1/chat/completions`

请求体与 OpenAI Chat Completions 一致；`stream=true` 时返回伪流式 SSE。无论上游是 OpenAI 还是 Gemini，客户端都只调用这一个入口。

Gemini 上游示例（配置了 `ALLOW_ENV_API_KEY=true` 时可省略 Key）：

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'x-goog-api-key: AIza...' \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "你好，请用三句话介绍你自己。"}],
    "stream": true
  }'
```

### Models

- `GET /api/models`
- `GET /v1/models`
- `GET /api/models?simple=1`

`simple=1` 时，返回格式示例：

```json
{
  "object": "list",
  "data": [
    { "id": "gpt-4o-mini", "object": "model" },
    { "id": "gemini-2.5-pro", "object": "model" }
  ],
  "count": 2,
  "upstream_format": "auto",
  "source_api_url": "https://api.openai.com",
  "sources": [
    { "format": "openai", "base_url": "https://api.openai.com", "ok": true, "count": 1 },
    { "format": "gemini", "base_url": "https://generativelanguage.googleapis.com", "ok": true, "count": 1 }
  ],
  "fetched_at": "2026-04-25T00:00:00.000Z"
}
```

说明：

- `UPSTREAM_FORMAT=openai` 且不带 `simple` 参数时，保持原样透传上游 `/v1/models` 响应
- `UPSTREAM_FORMAT=gemini` 时，会把 Gemini 的 `models[]` 转成 OpenAI 的 `{ id, object: "model" }` 列表，并过滤掉不支持 `generateContent` 的模型
- `UPSTREAM_FORMAT=auto` 时会同时尝试 OpenAI 和 Gemini 两个上游并合并结果；某个上游失败不影响另一个，失败原因会写进 `sources`
- 带 `simple=1` 时会尽量兼容不同上游结构并抽取模型 ID

### Status

- `GET /api/status`

状态响应里包含 `environment.upstream_format`、`environment.has_gemini_api_key`、`environment.gemini_base_url`、`environment.gemini_api_version`，可用于快速确认当前走哪条上游。

### Config

- `GET /api/config`
- `PUT /api/config`

### Logs

- `GET /api/logs?limit=100`
- `DELETE /api/logs`

### Admin Session

- `GET /api/admin/session`
- `POST /api/admin/login`
- `POST /api/admin/logout`

## 请求日志

日志文件路径：`data/request-logs.jsonl`

每条 chat 请求会记录：

- 请求 ID、时间、来源 IP、User-Agent
- 接口路径、HTTP 方法、模型名
- 实际使用的上游格式（`upstream_format`）
- 是否流式、状态码、响应耗时
- `message_count`
- `usage.prompt_tokens`
- `usage.completion_tokens`
- `usage.total_tokens`
- `output_text`
- `finish_reason`
- 错误信息（如果失败）

不会记录：

- 输入消息正文

## 页面说明

### `/`

测试代理请求，支持非流式和伪流式两种模式，并可一键获取模型列表填充下拉框。

### `/admin.html`

管理登录页。登录成功后跳转到配置页或日志页。

### `/config.html`

可视化编辑 `config/config.json`，保存后后端自动热读取。可以在 `UPSTREAM_FORMAT` 里切换 `openai` / `gemini` / `auto`，切换到 Gemini 时会展开 `GEMINI_*` 配置项。

### `/logs.html`

查看日志列表、统计信息、响应耗时、token 用量和模型输出。

## 常见问题

### 改配置后要重启吗？

不需要。配置文件是热读取的。

### 为什么配置页/日志页会跳到登录页？

因为这两个页面和对应 API 受 `ADMIN_PASSWORD` 保护。先去 `/admin.html` 登录。

### 为什么登录页提示管理员密码未配置？

因为 `config/config.json` 里的 `ADMIN_PASSWORD` 还是空值。

### 为什么日志里没有输入文本？

这是有意设计，避免把用户输入内容落盘。

### 伪流式到底做了什么？

服务会先请求上游的非流式结果（OpenAI 是 `/v1/chat/completions`，Gemini 是 `:generateContent`），再把完整输出拆成多个 SSE chunk，按时间间隔逐段返回给客户端，同时发送 heartbeat，并在最后输出 `[DONE]`。

### 如何切换到 Gemini？

在 `/config.html` 把 `UPSTREAM_FORMAT` 改成 `gemini`，填写 `GEMINI_API_KEY`，然后按需设置 `ALLOW_ENV_API_KEY=true`。或者直接改 `config/config.json`：

```json
{
  "UPSTREAM_FORMAT": "gemini",
  "GEMINI_API_KEY": "AIza...",
  "GEMINI_BASE_URL": "https://generativelanguage.googleapis.com",
  "GEMINI_API_VERSION": "v1beta",
  "ALLOW_ENV_API_KEY": true
}
```

配置是热读取的，不用重启。

### `auto` 和 `gemini` 有什么区别？

- `gemini`：所有模型都发给 Gemini，`SOURCE_API_URL` 不参与。
- `auto`：按模型名分流，`gemini*` / `gemma*` 走 Gemini，其余走 `SOURCE_API_URL`。适合一个代理同时服务两类模型。

### Gemini 返回 `API key not valid` / `model not found` 怎么办？

- 检查 `GEMINI_API_KEY` 是否是 Gemini（Google AI Studio）的 Key，而不是 OpenAI Key。
- 检查 `GEMINI_BASE_URL` 是否是 `https://generativelanguage.googleapis.com`，或者你的 Gemini 兼容网关地址。
- 模型名不要带错误前缀；`gemini-2.5-flash`、`models/gemini-2.5-flash` 都可以。
- 打开 `DEBUG=true` 可以看到转换警告；用 `/api/models?simple=1` 确认该 Key 实际可用的模型。

### 为什么 Gemini 图片请求返回 400？

Gemini 上游只接受内联 `inlineData` 或 File API 的 `fileUri`。本服务不会代下载远程图片（避免 SSRF），所以 `image_url` 必须使用 `data:` URL，例如：

```json
{
  "type": "image_url",
  "image_url": { "url": "data:image/png;base64,iVBORw0KGgo..." }
}
```

### 为什么 tool 消息报“无法解析函数名”？

Gemini 的 `functionResponse` 必须带函数名。OpenAI 的 `tool` 消息只有 `tool_call_id`，服务会从历史里的 `assistant.tool_calls` 反查；如果历史里没有对应的 assistant 消息，请显式给 tool 消息加 `name` 字段。

### 为什么日志里 `finish_reason` 是 `content_filter`？

Gemini 返回 `SAFETY`、`BLOCKLIST`、`PROHIBITED_CONTENT` 等安全相关 finish reason 时，会映射成 OpenAI 的 `content_filter`。如果 prompt 本身被拦截，响应内容会是空字符串。
