const axios = require('axios');
const { randomUUID } = require('crypto');
const { getConfig, getUpstreamExtraHeaders } = require('../lib/config-store');
const { appendRequestLog } = require('../lib/request-logs');
const { applyCors } = require('../lib/cors');

// 延迟函数
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 统一日志控制
const log = (configValue, ...args) => {
  if (configValue.DEBUG) {
    console.log('[proxy]', ...args);
  }
};

// 心跳包发送函数
function sendHeartbeat(res) {
  try {
    // 发送空的 SSE 注释行作为心跳包
    res.write(': heartbeat\n\n');
  } catch (error) {
    // 避免因连接关闭导致异常
  }
}

// 启动心跳定时器
function startHeartbeat(res, interval = 3000) {
  const heartbeatTimer = setInterval(() => {
    sendHeartbeat(res);
  }, interval);
  return heartbeatTimer;
}

// 停止心跳
function stopHeartbeat(timer) {
  if (timer) clearInterval(timer);
}

// 将文本分解为合理的块（兼容中英文）
function chunkText(text, targetLen = 30) {
  if (!text || typeof text !== 'string') return [];
  const chunks = [];
  let buffer = '';

  const push = () => {
    if (buffer) {
      chunks.push(buffer);
      buffer = '';
    }
  };

  // 先按换行与句号/问号/叹号等断句
  const sentences = text.split(/([。！？!?\n])/).reduce((acc, part, idx, arr) => {
    if (["。", "！", "？", "!", "?", "\n"].includes(part)) {
      acc[acc.length - 1] += part;
    } else if (part) {
      acc.push(part);
    }
    return acc;
  }, []);

  for (const s of sentences) {
    // 若句子很长，按固定长度切
    if (s.length > targetLen * 2) {
      push();
      for (let i = 0; i < s.length; i += targetLen) {
        chunks.push(s.slice(i, i + targetLen));
      }
      continue;
    }
    if ((buffer + s).length >= targetLen) {
      push();
    }
    buffer += s;
  }
  push();
  return chunks.filter(Boolean);
}

// 生成 SSE 格式的数据
function formatSSEData(data) {
  if (typeof data === 'string') {
    return `data: ${data}\n\n`;
  }
  return `data: ${JSON.stringify(data)}\n\n`;
}

function extractUsageFromUpstream(data) {
  const usage = data?.usage || data?.usageMetadata || data?.meta?.usage;

  const promptTokens = usage?.prompt_tokens ?? usage?.promptTokenCount ?? null;
  const completionTokens = usage?.completion_tokens ?? usage?.candidatesTokenCount ?? usage?.completionTokenCount ?? null;
  const totalTokens = usage?.total_tokens ?? usage?.totalTokenCount ?? null;

  return {
    prompt_tokens: Number.isFinite(promptTokens) ? promptTokens : null,
    completion_tokens: Number.isFinite(completionTokens) ? completionTokens : null,
    total_tokens: Number.isFinite(totalTokens) ? totalTokens : null,
  };
}

function truncateOutputText(text, maxLength) {
  if (typeof text !== 'string') return '';
  if (!Number.isFinite(maxLength) || maxLength <= 0) return text;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...[truncated]`;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || '';
}

// 兼容提取上游返回的文本（OpenAI Chat Completions / Gemini candidates 等）
function extractTextFromUpstream(data) {
  try {
    // OpenAI Chat Completions 标准：choices[0].message.content 可能是字符串或数组
    const choice0 = data?.choices?.[0];
    const msg = choice0?.message;
    if (msg) {
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        // 聚合文本片段
        return msg.content
          .map((p) => (typeof p === 'string' ? p : (p?.text || p?.content || '')))
          .join('');
      }
    }
    // 一些代理会直接返回 choices[0].text
    if (typeof choice0?.text === 'string') return choice0.text;

    // Gemini 风格：candidates[0].content.parts[].text
    const cand0 = data?.candidates?.[0];
    const parts = cand0?.content?.parts;
    if (Array.isArray(parts)) {
      return parts.map((p) => p?.text || '').join('');
    }
  } catch (_) { }
  return '';
}

module.exports = async (req, res) => {
  const configValue = getConfig();

  const startedAt = Date.now();
  const requestId = randomUUID();

  const writeLog = (payload) => {
    try {
      appendRequestLog({
        request_id: requestId,
        created_at: new Date().toISOString(),
        endpoint: req.path || '/api/chat',
        method: req.method,
        client_ip: getClientIp(req),
        user_agent: req.headers['user-agent'] || '',
        ...payload,
      }, configValue.LOG_RETENTION);
    } catch (_) {
      // 日志写入失败不影响主流程
    }
  };

  applyCors(req, res, {
    allowOrigin: configValue.CORS_ALLOW_ORIGIN,
    methods: 'POST, OPTIONS',
    headers: 'Content-Type, Authorization',
  });
  res.setHeader('X-Request-Id', requestId);

  if (req.method === 'OPTIONS') return res.status(200).end();

  // 只允许 POST 请求
  if (req.method !== 'POST') {
    writeLog({
      status_code: 405,
      response_ms: Date.now() - startedAt,
      error: { message: 'Method not allowed', type: 'invalid_request_error' },
    });
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    model = 'gpt-4o-mini',
    messages,
    temperature = 0.7,
    max_tokens,
    stream = false,
    ...otherParams
  } = req.body || {};

  const messageCount = Array.isArray(messages) ? messages.length : 0;

  // 参数校验（不记录message内容避免泄露）
  if (!Array.isArray(messages)) {
    writeLog({
      model,
      stream: !!stream,
      message_count: 0,
      temperature,
      max_tokens: max_tokens ?? null,
      status_code: 400,
      response_ms: Date.now() - startedAt,
      error: {
        message: 'messages is required and must be an array',
        type: 'invalid_request_error',
      },
    });
    return res.status(400).json({
      error: {
        message: 'messages is required and must be an array',
        type: 'invalid_request_error',
      },
    });
  }

  // 获取配置（支持热读取）
  const envApiKey = configValue.OPENAI_API_KEY;
  const sourceApiUrl = configValue.SOURCE_API_URL || 'https://api.openai.com';
  const allowEnvKeyFallback = !!configValue.ALLOW_ENV_API_KEY;
  const heartbeatInterval = Number(configValue.HEARTBEAT_INTERVAL_MS ?? 3000);

  // 从请求头获取 API 密钥
  const authHeader = req.headers.authorization || '';
  const headerKey = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : '';
  const hasHeaderKey = !!headerKey;

  if (!hasHeaderKey && !allowEnvKeyFallback) {
    writeLog({
      model,
      stream: !!stream,
      message_count: messageCount,
      temperature,
      max_tokens: max_tokens ?? null,
      status_code: 401,
      response_ms: Date.now() - startedAt,
      error: { message: 'Missing Authorization header', type: 'unauthorized' },
    });
    return res.status(401).json({
      error: { message: 'Missing Authorization header', type: 'unauthorized' },
    });
  }

  if (!hasHeaderKey && allowEnvKeyFallback && !envApiKey) {
    writeLog({
      model,
      stream: !!stream,
      message_count: messageCount,
      temperature,
      max_tokens: max_tokens ?? null,
      status_code: 500,
      response_ms: Date.now() - startedAt,
      error: {
        message: 'ALLOW_ENV_API_KEY is enabled but OPENAI_API_KEY is empty in config',
        type: 'server_error',
      },
    });
    return res.status(500).json({
      error: {
        message: 'ALLOW_ENV_API_KEY is enabled but OPENAI_API_KEY is empty in config',
        type: 'server_error',
      },
    });
  }
  const requestApiKey = hasHeaderKey ? headerKey : envApiKey;

  // 准备发送到源 API 的请求体（强制非流式）
  const requestBody = {
    model,
    messages,
    temperature,
    ...otherParams,
    stream: false,
  };
  if (max_tokens !== undefined) requestBody.max_tokens = max_tokens;

  // 如果客户端需要流式响应，设置SSE响应头并开始心跳
  let heartbeatTimer = null;
  let clientAborted = false;
  let clientCompleted = false;
  let roleSent = false;
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    heartbeatTimer = startHeartbeat(res, heartbeatInterval);
    // 使用响应的 close 事件检测客户端断开
    res.on('close', () => {
      if (!clientCompleted) clientAborted = true;
      stopHeartbeat(heartbeatTimer);
      try { res.end(); } catch (_) { }
    });
    // 立即发送一个 role 块，确保响应体非空，避免 content-length: 0
    const preRoleChunk = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    };
    try {
      log(configValue, 'pre role chunk write');
      res.write(formatSSEData(preRoleChunk));
      roleSent = true;
      log(configValue, 'pre role chunk written');
      if (typeof res.flushHeaders === 'function') {
        try { res.flushHeaders(); log(configValue, 'headers flushed'); } catch (_) { }
      }
    } catch (e) { log(configValue, 'pre role chunk error', e?.message || e); }
  }

  let hasWrittenLog = false;
  const writeOnce = (payload) => {
    if (hasWrittenLog) return;
    hasWrittenLog = true;
    writeLog(payload);
  };

  try {
    log(configValue, 'Requesting source API', { stream, model });
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${requestApiKey}`,
    };

    Object.assign(headers, getUpstreamExtraHeaders(configValue));

    const response = await axios.post(`${sourceApiUrl}/v1/chat/completions`, requestBody, { headers });

    const usage = extractUsageFromUpstream(response.data);
    const fullContent = extractTextFromUpstream(response.data);
    const outputText = truncateOutputText(fullContent, configValue.LOG_MAX_OUTPUT_CHARS);
    const finishReason =
      response.data?.choices?.[0]?.finish_reason ||
      response.data?.candidates?.[0]?.finishReason?.toLowerCase?.() ||
      'stop';

    if (!stream) {
      writeOnce({
        model,
        stream: false,
        message_count: messageCount,
        temperature,
        max_tokens: max_tokens ?? null,
        status_code: 200,
        response_ms: Date.now() - startedAt,
        usage,
        output_chars: typeof fullContent === 'string' ? fullContent.length : 0,
        output_text: outputText,
        finish_reason: finishReason,
      });
      return res.status(200).json(response.data);
    }

    // 客户端需要流式响应：先停止心跳，再进行伪流式发送
    stopHeartbeat(heartbeatTimer);
    if (clientAborted) return; // 已断开

    const choice0 = response.data?.choices?.[0] || {};
    const contentLen = typeof fullContent === 'string' ? fullContent.length : 0;
    log(configValue, 'upstream content length:', contentLen);
    const currentFinishReason =
      choice0?.finish_reason || response.data?.candidates?.[0]?.finishReason?.toLowerCase?.() || 'stop';
    const sseBase = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: response.data?.model || model,
    };

    // 发送角色块（如果之前未发送）
    if (!roleSent) {
      log(configValue, 'late role chunk write');
      const roleChunk = { ...sseBase, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
      res.write(formatSSEData(roleChunk));
      if (typeof res.flushHeaders === 'function') {
        try { res.flushHeaders(); log(configValue, 'headers flushed (late)'); } catch (_) { }
      }
    }

    // 内容分块并发送（加入轻微延迟模拟流式）
    let parts = chunkText(fullContent, Number(configValue.CHUNK_TARGET_LENGTH ?? 30));
    if ((!parts || parts.length === 0) && contentLen > 0) {
      parts = [fullContent];
    }
    for (const part of parts) {
      if (clientAborted) break;
      const contentChunk = { ...sseBase, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] };
      res.write(formatSSEData(contentChunk));
      const jitter = Math.max(0, Math.min(120, Number(configValue.CHUNK_DELAY_MS ?? 35)));
      // 可选抖动
      await delay(jitter);
    }

    // 发送最后一个空块，包含 finish_reason
    if (!clientAborted) {
      const finalChunk = { ...sseBase, choices: [{ index: 0, delta: {}, finish_reason: currentFinishReason }] };
      res.write(formatSSEData(finalChunk));
      res.write(formatSSEData('[DONE]'));
      clientCompleted = true;
      res.end();
    }

    writeOnce({
      model,
      stream: true,
      message_count: messageCount,
      temperature,
      max_tokens: max_tokens ?? null,
      status_code: clientAborted ? 499 : 200,
      response_ms: Date.now() - startedAt,
      usage,
      output_chars: typeof fullContent === 'string' ? fullContent.length : 0,
      output_text: outputText,
      finish_reason: currentFinishReason,
      client_aborted: clientAborted,
    });
  } catch (error) {
    // 错误处理
    const upErr = error?.response?.data || null;
    const statusCode = error?.response?.status || 500;
    const usage = extractUsageFromUpstream(upErr || {});
    const fullContent = extractTextFromUpstream(upErr || {});
    const outputText = truncateOutputText(fullContent, configValue.LOG_MAX_OUTPUT_CHARS);

    log(configValue, 'Upstream error', statusCode);

    writeOnce({
      model,
      stream: !!stream,
      message_count: messageCount,
      temperature,
      max_tokens: max_tokens ?? null,
      status_code: statusCode,
      response_ms: Date.now() - startedAt,
      usage,
      output_chars: typeof fullContent === 'string' ? fullContent.length : 0,
      output_text: outputText,
      error: {
        message: upErr?.error?.message || error.message || 'An unexpected error occurred.',
        type: upErr?.error?.type || 'server_error',
      },
    });

    if (stream) {
      const errorPayload = {
        error: {
          message: upErr?.error?.message || error.message || 'An unexpected error occurred.',
          type: upErr?.error?.type || 'server_error',
        },
      };
      try { res.write(formatSSEData(errorPayload)); } catch (_) { }
      clientCompleted = true;
      try { res.end(); } catch (_) { }
    } else {
      res.status(statusCode).json(upErr || {
        error: { message: 'An unexpected error occurred.', type: 'server_error' },
      });
    }
  } finally {
    stopHeartbeat(heartbeatTimer);
    if (stream && clientAborted && !hasWrittenLog) {
      writeOnce({
        model,
        stream: true,
        message_count: messageCount,
        temperature,
        max_tokens: max_tokens ?? null,
        status_code: 499,
        response_ms: Date.now() - startedAt,
        error: {
          message: 'Client aborted connection',
          type: 'client_abort',
        },
        client_aborted: true,
      });
    }
  }
};
