const axios = require('axios');
const { randomUUID } = require('crypto');
const { getConfig, getUpstreamExtraHeaders } = require('../lib/config-store');
const { appendRequestLog } = require('../lib/request-logs');
const { applyCors } = require('../lib/cors');
const gemini = require('../lib/gemini');

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

function stringifyToolCallArguments(args) {
  if (typeof args === 'string') return args;
  if (args === undefined || args === null) return '{}';
  try {
    return JSON.stringify(args);
  } catch (_) {
    return '{}';
  }
}

/**
 * OpenAI 协议里 tool_calls 是模型输出的一部分。不同上游（OpenAI 兼容网关、
 * Gemini 转换层）形状略有差异，这里统一成 OpenAI 的 tool_calls 结构，供
 * 伪流式转发与请求日志共用。
 */
function normalizeToolCalls(rawToolCalls) {
  if (!Array.isArray(rawToolCalls)) return [];

  const toolCalls = [];
  for (const raw of rawToolCalls) {
    if (!raw || typeof raw !== 'object') continue;

    const fn = raw.function && typeof raw.function === 'object' ? raw.function : null;
    const name = typeof fn?.name === 'string' ? fn.name.trim() : '';
    if (!name) continue;

    const call = {
      id: typeof raw.id === 'string' && raw.id ? raw.id : `call_${randomUUID()}`,
      type: typeof raw.type === 'string' && raw.type ? raw.type : 'function',
      function: {
        name,
        arguments: stringifyToolCallArguments(fn.arguments),
      },
    };

    if (raw.extra_content && typeof raw.extra_content === 'object') {
      call.extra_content = raw.extra_content;
    }

    toolCalls.push(call);
  }
  return toolCalls;
}

function extractToolCallsFromUpstream(data) {
  const message = data?.choices?.[0]?.message;
  if (!message || typeof message !== 'object') return [];

  if (Array.isArray(message.tool_calls)) {
    return normalizeToolCalls(message.tool_calls);
  }

  // 旧版 function_call 字段，统一当作单个 tool_call 处理。
  if (message.function_call && typeof message.function_call === 'object') {
    return normalizeToolCalls([{ type: 'function', function: message.function_call }]);
  }

  return [];
}

/**
 * 工具调用的参数同样属于模型输出，但可能非常大。日志里按
 * LOG_MAX_OUTPUT_CHARS 给每个调用分配额度，避免一条日志把文件撑爆。
 */
function truncateToolCallsForLog(toolCalls, maxLength) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];

  const limit = Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : Infinity;
  let remaining = limit;

  return toolCalls.map((call, index) => {
    const callsLeft = toolCalls.length - index;
    let args = typeof call?.function?.arguments === 'string' ? call.function.arguments : '{}';

    if (Number.isFinite(remaining)) {
      const allowance = Math.max(1, Math.floor(remaining / callsLeft));
      if (args.length > allowance) {
        args = `${args.slice(0, allowance)}...[truncated]`;
      }
      remaining = Math.max(0, remaining - args.length);
    }

    return {
      id: call?.id || '',
      type: call?.type || 'function',
      function: {
        name: call?.function?.name || '',
        arguments: args,
      },
    };
  });
}

/**
 * Builds the output-related log fields. finish_reason=tool_calls 时
 * message.content 为 null，真正的模型输出在 tool_calls 里；只记录
 * output_text 会得到一条空记录。
 */
function buildOutputLog(fullContent, toolCalls, maxLength) {
  const text = typeof fullContent === 'string' ? fullContent : '';
  const loggedToolCalls = truncateToolCallsForLog(toolCalls, maxLength);
  const toolCallChars = Array.isArray(toolCalls)
    ? toolCalls.reduce((sum, call) => {
      const args = typeof call?.function?.arguments === 'string' ? call.function.arguments : '';
      return sum + args.length;
    }, 0)
    : 0;

  const fields = {
    output_chars: text.length + toolCallChars,
    output_text: truncateOutputText(text, maxLength),
  };

  if (loggedToolCalls.length) {
    fields.tool_calls = loggedToolCalls;
    fields.tool_call_count = loggedToolCalls.length;
  }

  return fields;
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

// 解析本次请求应使用的上游格式
function resolveUpstreamFormat(configValue, model) {
  const raw = String(configValue.UPSTREAM_FORMAT || 'openai').trim().toLowerCase();
  if (raw === 'gemini') return 'gemini';
  if (raw === 'auto') return gemini.isGeminiModel(model) ? 'gemini' : 'openai';
  return 'openai';
}

function getIncomingApiKeys(req) {
  const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : '';
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
  const bearer = bearerMatch ? bearerMatch[1].trim() : '';

  const googHeader = req.headers['x-goog-api-key'];
  const goog = typeof googHeader === 'string' ? googHeader.trim() : '';

  return { bearer, goog };
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
    headers: 'Content-Type, Authorization, x-goog-api-key',
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

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};

  const {
    messages,
    temperature = 0.7,
    max_tokens,
    stream = false,
    ...otherParams
  } = body;

  const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
  if (body.model !== undefined && body.model !== null && typeof body.model !== 'string') {
    writeLog({
      stream: !!stream,
      message_count: Array.isArray(messages) ? messages.length : 0,
      temperature,
      max_tokens: max_tokens ?? null,
      status_code: 400,
      response_ms: Date.now() - startedAt,
      error: {
        message: 'model must be a string',
        type: 'invalid_request_error',
      },
    });
    return res.status(400).json({
      error: { message: 'model must be a string', type: 'invalid_request_error' },
    });
  }

  const upstreamFormat = resolveUpstreamFormat(configValue, requestedModel);
  const model = requestedModel || (upstreamFormat === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4o-mini');
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
      upstream_format: upstreamFormat,
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
  const openaiEnvKey = configValue.OPENAI_API_KEY || '';
  const geminiEnvKey = configValue.GEMINI_API_KEY || '';
  const envApiKey = upstreamFormat === 'gemini'
    ? (geminiEnvKey || openaiEnvKey)
    : openaiEnvKey;
  const sourceApiUrl = configValue.SOURCE_API_URL || 'https://api.openai.com';
  const allowEnvKeyFallback = !!configValue.ALLOW_ENV_API_KEY;
  const heartbeatInterval = Number(configValue.HEARTBEAT_INTERVAL_MS ?? 3000);

  // 从请求头获取 API 密钥；Gemini 格式优先使用 x-goog-api-key
  const incomingKeys = getIncomingApiKeys(req);
  const headerKey = upstreamFormat === 'gemini'
    ? (incomingKeys.goog || incomingKeys.bearer)
    : (incomingKeys.bearer || incomingKeys.goog);
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
      upstream_format: upstreamFormat,
      error: {
        message: 'Missing API key: use Authorization: Bearer <key> or x-goog-api-key: <key>',
        type: 'unauthorized',
      },
    });
    return res.status(401).json({
      error: {
        message: 'Missing API key: use Authorization: Bearer <key> or x-goog-api-key: <key>',
        type: 'unauthorized',
      },
    });
  }

  if (!hasHeaderKey && allowEnvKeyFallback && !envApiKey) {
    const configError = upstreamFormat === 'gemini'
      ? 'ALLOW_ENV_API_KEY is enabled but GEMINI_API_KEY (or OPENAI_API_KEY) is empty in config'
      : 'ALLOW_ENV_API_KEY is enabled but OPENAI_API_KEY is empty in config';

    writeLog({
      model,
      stream: !!stream,
      message_count: messageCount,
      temperature,
      max_tokens: max_tokens ?? null,
      status_code: 500,
      response_ms: Date.now() - startedAt,
      upstream_format: upstreamFormat,
      error: {
        message: configError,
        type: 'server_error',
      },
    });
    return res.status(500).json({
      error: {
        message: configError,
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

  // Gemini 格式需要提前转换请求，转换失败直接返回 400，避免已建立 SSE 连接
  let geminiRequestBody = null;
  let geminiIncludeThoughts = false;
  if (upstreamFormat === 'gemini') {
    try {
      const converted = gemini.buildGenerateContentRequest(
        { ...body, temperature: body.temperature !== undefined ? body.temperature : temperature },
        { model },
      );
      geminiRequestBody = converted.request;
      geminiIncludeThoughts = geminiRequestBody?.generationConfig?.thinkingConfig?.includeThoughts === true;

      if (converted.warnings.length) {
        log(configValue, 'Gemini request conversion warnings:', converted.warnings.join('; '));
      }
    } catch (error) {
      writeLog({
        model,
        stream: !!stream,
        message_count: messageCount,
        temperature,
        max_tokens: max_tokens ?? null,
        status_code: 400,
        response_ms: Date.now() - startedAt,
        upstream_format: upstreamFormat,
        error: {
          message: error.message || 'Invalid request for Gemini upstream',
          type: 'invalid_request_error',
        },
      });
      return res.status(400).json({
        error: {
          message: error.message || 'Invalid request for Gemini upstream',
          type: 'invalid_request_error',
        },
      });
    }
  }

  // 如果客户端需要流式响应，设置SSE响应头并开始心跳
  let heartbeatTimer = null;
  let clientAborted = false;
  let clientCompleted = false;
  let roleSent = false;
  const sseId = `chatcmpl-${randomUUID()}`;
  const sseCreated = Math.floor(Date.now() / 1000);
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
      id: sseId,
      object: 'chat.completion.chunk',
      created: sseCreated,
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
    log(configValue, 'Requesting source API', { stream, model, upstreamFormat });

    let fullContent = '';
    let usage = { prompt_tokens: null, completion_tokens: null, total_tokens: null };
    let finishReason = 'stop';
    let toolCalls = [];
    let responsePayload = null;
    let sseModel = model;

    if (upstreamFormat === 'gemini') {
      const url = gemini.buildGenerateContentUrl(configValue, model);
      const headers = gemini.buildHeaders(requestApiKey, getUpstreamExtraHeaders(configValue));

      const response = await axios.post(url, geminiRequestBody, { headers });
      const converted = gemini.convertResponse(response.data, {
        requestedModel: model,
        includeThoughts: geminiIncludeThoughts,
      });

      fullContent = converted.text;
      usage = converted.usage;
      finishReason = converted.finishReason;
      toolCalls = normalizeToolCalls(converted.toolCalls);
      responsePayload = converted.response;
      sseModel = converted.model;

      if (converted.blockReason) {
        log(configValue, 'Gemini prompt blocked:', converted.blockReason);
      }
    } else {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${requestApiKey}`,
      };

      Object.assign(headers, getUpstreamExtraHeaders(configValue));

      const response = await axios.post(`${sourceApiUrl}/v1/chat/completions`, requestBody, { headers });

      fullContent = extractTextFromUpstream(response.data);
      usage = extractUsageFromUpstream(response.data);
      finishReason =
        response.data?.choices?.[0]?.finish_reason ||
        response.data?.candidates?.[0]?.finishReason?.toLowerCase?.() ||
        'stop';
      toolCalls = extractToolCallsFromUpstream(response.data);
      responsePayload = response.data;
      sseModel = response.data?.model || model;
    }

    const outputFields = buildOutputLog(
      fullContent,
      toolCalls,
      configValue.LOG_MAX_OUTPUT_CHARS,
    );

    if (!stream) {
      writeOnce({
        model,
        stream: false,
        message_count: messageCount,
        temperature,
        max_tokens: max_tokens ?? null,
        status_code: 200,
        response_ms: Date.now() - startedAt,
        upstream_format: upstreamFormat,
        usage,
        ...outputFields,
        finish_reason: finishReason,
      });
      return res.status(200).json(responsePayload);
    }

    // 客户端需要流式响应：先停止心跳，再进行伪流式发送
    stopHeartbeat(heartbeatTimer);
    if (clientAborted) return; // 已断开

    const contentLen = typeof fullContent === 'string' ? fullContent.length : 0;
    log(configValue, 'upstream content length:', contentLen);

    const sseBase = {
      id: sseId,
      object: 'chat.completion.chunk',
      created: sseCreated,
      model: sseModel,
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

    // Gemini 的 tool_calls 在 OpenAI 流式协议里放在 delta.tool_calls
    if (!clientAborted && Array.isArray(toolCalls) && toolCalls.length) {
      const deltaToolCalls = toolCalls.map((call, index) => ({
        index,
        id: call.id,
        type: call.type || 'function',
        function: call.function,
        ...(call.extra_content ? { extra_content: call.extra_content } : {}),
      }));
      const toolChunk = {
        ...sseBase,
        choices: [{ index: 0, delta: { tool_calls: deltaToolCalls }, finish_reason: null }],
      };
      res.write(formatSSEData(toolChunk));
    }

    // 发送最后一个空块，包含 finish_reason
    if (!clientAborted) {
      const finalChunk = { ...sseBase, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
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
      upstream_format: upstreamFormat,
      usage,
      ...outputFields,
      finish_reason: finishReason,
      client_aborted: clientAborted,
    });
  } catch (error) {
    // 错误处理
    const upErr = error?.response?.data || null;
    const statusCode = error?.response?.status || 500;

    log(configValue, 'Upstream error', statusCode, upstreamFormat);

    let errorPayload;
    let errorMessage;
    let errorType;

    if (upstreamFormat === 'gemini') {
      errorPayload = gemini.normalizeError(upErr, statusCode, error.message);
      errorMessage = errorPayload.error.message;
      errorType = errorPayload.error.type;
    } else {
      errorMessage = upErr?.error?.message || error.message || 'An unexpected error occurred.';
      errorType = upErr?.error?.type || 'server_error';
      errorPayload = upErr || {
        error: { message: 'An unexpected error occurred.', type: 'server_error' },
      };
    }

    const usage = extractUsageFromUpstream(upErr || {});
    const fullContent = extractTextFromUpstream(upErr || {});
    const outputText = truncateOutputText(fullContent, configValue.LOG_MAX_OUTPUT_CHARS);

    writeOnce({
      model,
      stream: !!stream,
      message_count: messageCount,
      temperature,
      max_tokens: max_tokens ?? null,
      status_code: statusCode,
      response_ms: Date.now() - startedAt,
      upstream_format: upstreamFormat,
      usage,
      output_chars: typeof fullContent === 'string' ? fullContent.length : 0,
      output_text: outputText,
      error: {
        message: errorMessage,
        type: errorType,
      },
    });

    if (stream) {
      const streamErrorPayload = upstreamFormat === 'gemini'
        ? errorPayload
        : { error: { message: errorMessage, type: errorType } };
      try { res.write(formatSSEData(streamErrorPayload)); } catch (_) { }
      clientCompleted = true;
      try { res.end(); } catch (_) { }
    } else {
      res.status(statusCode).json(errorPayload);
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
        upstream_format: upstreamFormat,
        error: {
          message: 'Client aborted connection',
          type: 'client_abort',
        },
        client_aborted: true,
      });
    }
  }
};
