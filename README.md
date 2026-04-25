# vps-fake-stream

一个部署在 VPS 上的 Node.js 代理服务，用来把上游一次性返回的 Chat Completion 结果改造成伪流式 SSE。

它适合这种场景：

- 你希望对接 OpenAI 风格接口
- 上游只返回非流式结果，前端却想消费流式输出
- 你不想每次改配置都去改环境变量再重启服务
- 你需要一个简单的网页来改配置、看日志和检查服务状态

## 功能概览

- 兼容接口：
  - `POST /v1/chat/completions`
  - `GET /v1/models`
- 模型列表简化模式：
  - `GET /api/models?simple=1`
  - 返回统一格式的模型 ID 列表，便于前端直接渲染下拉框
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
| `OPENAI_API_KEY` | 服务端兜底 API Key | 空 |
| `SOURCE_API_URL` | 上游 API 根地址 | `https://api.openai.com` |
| `CORS_ALLOW_ORIGIN` | CORS 允许来源，支持单个域名、逗号分隔或换行分隔多个域名 | `*` |
| `ALLOW_ENV_API_KEY` | 请求未带 Authorization 时，是否回退到 `OPENAI_API_KEY` | `false` |
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

## API

### Chat

- `POST /api/chat`
- `POST /v1/chat/completions`

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
  "source_api_url": "https://api.openai.com",
  "fetched_at": "2026-04-25T00:00:00.000Z"
}
```

说明：

- 不带 `simple` 参数时，仍保持原样透传上游 `/v1/models` 响应
- 带 `simple=1` 时会尽量兼容不同上游结构并抽取模型 ID

### Status

- `GET /api/status`

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

可视化编辑 `config/config.json`，保存后后端自动热读取。

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

服务会先请求上游的非流式结果，再把完整输出拆成多个 SSE chunk，按时间间隔逐段返回给客户端，同时发送 heartbeat，并在最后输出 `[DONE]`。
