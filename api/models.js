const axios = require('axios');
const { getConfig, getUpstreamExtraHeaders } = require('../lib/config-store');
const { applyCors } = require('../lib/cors');
const gemini = require('../lib/gemini');
const {
  upstreamAgentOptions,
  UPSTREAM_MODEL_LIST_TIMEOUT_MS,
} = require('../lib/upstream-http');

function parseBooleanFlag(value) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function normalizeModelId(rawModel) {
  if (typeof rawModel === 'string') return rawModel.trim();
  if (!rawModel || typeof rawModel !== 'object') return '';

  if (typeof rawModel.id === 'string' && rawModel.id.trim()) {
    return rawModel.id.trim();
  }

  const rawName =
    (typeof rawModel.name === 'string' && rawModel.name.trim()) ||
    (typeof rawModel.model === 'string' && rawModel.model.trim()) ||
    '';

  if (!rawName) return '';
  return rawName.startsWith('models/') ? rawName.slice(7) : rawName;
}

function normalizeModelList(rawPayload) {
  let sourceList = [];

  if (Array.isArray(rawPayload)) {
    sourceList = rawPayload;
  } else if (Array.isArray(rawPayload?.data)) {
    sourceList = rawPayload.data;
  } else if (Array.isArray(rawPayload?.models)) {
    sourceList = rawPayload.models;
  } else if (Array.isArray(rawPayload?.result?.models)) {
    sourceList = rawPayload.result.models;
  } else if (Array.isArray(rawPayload?.items)) {
    sourceList = rawPayload.items;
  }

  const seen = new Set();
  const normalized = [];

  for (const item of sourceList) {
    const id = normalizeModelId(item);
    if (!id || seen.has(id)) continue;

    seen.add(id);

    const model = {
      id,
      object: 'model',
    };

    if (item && typeof item === 'object') {
      if (Number.isFinite(item.created)) {
        model.created = item.created;
      }

      if (typeof item.owned_by === 'string' && item.owned_by.trim()) {
        model.owned_by = item.owned_by.trim();
      }
    }

    normalized.push(model);
  }

  return normalized;
}

function getIncomingApiKeys(req) {
  const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : '';
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
  const bearer = bearerMatch ? bearerMatch[1].trim() : '';

  const googHeader = req.headers['x-goog-api-key'];
  const goog = typeof googHeader === 'string' ? googHeader.trim() : '';

  return { bearer, goog };
}

function resolveFormat(configValue) {
  const raw = String(configValue.UPSTREAM_FORMAT || 'openai').trim().toLowerCase();
  if (raw === 'gemini') return 'gemini';
  if (raw === 'auto') return 'auto';
  return 'openai';
}

function buildListPayload(models, { simple, format, sourceApiUrl, sources }) {
  const payload = {
    object: 'list',
    data: simple
      ? models.map((model) => ({ id: model.id, object: 'model' }))
      : models,
    count: models.length,
    upstream_format: format,
    source_api_url: sourceApiUrl,
    fetched_at: new Date().toISOString(),
  };

  if (sources) payload.sources = sources;

  return payload;
}

function sendJsonError(res, statusCode, message, type) {
  return res.status(statusCode).json({
    error: {
      message,
      type: type || (statusCode === 401 ? 'unauthorized' : 'server_error'),
    },
  });
}

function sendUpstreamError(res, error, format, fallbackMessage) {
  const upErr = error?.response?.data || null;
  const statusCode = error?.response?.status || 500;

  if (format === 'gemini') {
    return res.status(statusCode).json(gemini.normalizeError(upErr, statusCode, error?.message));
  }

  return res.status(statusCode).json(upErr || {
    error: {
      message: fallbackMessage || 'Failed to fetch models',
      type: 'server_error',
    },
  });
}

async function fetchOpenAIModels(configValue, apiKey) {
  const sourceApiUrl = configValue.SOURCE_API_URL || 'https://api.openai.com';
  const headers = { Authorization: `Bearer ${apiKey}` };
  Object.assign(headers, getUpstreamExtraHeaders(configValue));

  const response = await axios.get(
    `${sourceApiUrl}/v1/models`,
    upstreamAgentOptions({
      headers,
      timeout: UPSTREAM_MODEL_LIST_TIMEOUT_MS,
    }),
  );
  return response.data;
}

async function fetchGeminiModels(configValue, apiKey) {
  return gemini.listModels(
    configValue,
    apiKey,
    getUpstreamExtraHeaders(configValue),
  );
}

module.exports = async (req, res) => {
  const configValue = getConfig();

  applyCors(req, res, {
    allowOrigin: configValue.CORS_ALLOW_ORIGIN,
    methods: 'GET, OPTIONS',
    headers: 'Content-Type, Authorization, x-goog-api-key',
  });

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const format = resolveFormat(configValue);
  const allowEnvKeyFallback = !!configValue.ALLOW_ENV_API_KEY;
  const useSimpleResponse = parseBooleanFlag(req.query?.simple);
  const incomingKeys = getIncomingApiKeys(req);
  const sourceApiUrl = configValue.SOURCE_API_URL || 'https://api.openai.com';

  if (!incomingKeys.bearer && !incomingKeys.goog && !allowEnvKeyFallback) {
    return sendJsonError(
      res,
      401,
      'Missing API key: use Authorization: Bearer <key> or x-goog-api-key: <key>',
      'unauthorized',
    );
  }

  if (format === 'openai') {
    const envApiKey = configValue.OPENAI_API_KEY || '';
    const headerKey = incomingKeys.bearer || incomingKeys.goog;

    if (!headerKey && allowEnvKeyFallback && !envApiKey) {
      return sendJsonError(
        res,
        500,
        'ALLOW_ENV_API_KEY is enabled but OPENAI_API_KEY is empty in config',
        'server_error',
      );
    }

    const apiKey = headerKey || envApiKey;

    try {
      const rawPayload = await fetchOpenAIModels(configValue, apiKey);

      if (!useSimpleResponse) {
        return res.status(200).json(rawPayload);
      }

      const models = normalizeModelList(rawPayload);
      return res.status(200).json(buildListPayload(models, {
        simple: true,
        format: 'openai',
        sourceApiUrl,
      }));
    } catch (error) {
      return sendUpstreamError(res, error, 'openai', 'Failed to fetch models');
    }
  }

  if (format === 'gemini') {
    const envApiKey = configValue.GEMINI_API_KEY || configValue.OPENAI_API_KEY || '';
    const headerKey = incomingKeys.goog || incomingKeys.bearer;

    if (!headerKey && allowEnvKeyFallback && !envApiKey) {
      return sendJsonError(
        res,
        500,
        'ALLOW_ENV_API_KEY is enabled but GEMINI_API_KEY (or OPENAI_API_KEY) is empty in config',
        'server_error',
      );
    }

    const apiKey = headerKey || envApiKey;

    try {
      const models = await fetchGeminiModels(configValue, apiKey);
      return res.status(200).json(buildListPayload(models, {
        simple: useSimpleResponse,
        format: 'gemini',
        sourceApiUrl: configValue.GEMINI_BASE_URL || gemini.DEFAULT_BASE_URL,
      }));
    } catch (error) {
      return sendUpstreamError(res, error, 'gemini', 'Failed to fetch Gemini models');
    }
  }

  // auto：同时尝试两个上游并合并模型列表，任一成功即返回
  const openaiEnvKey = configValue.OPENAI_API_KEY || '';
  const geminiEnvKey = configValue.GEMINI_API_KEY || configValue.OPENAI_API_KEY || '';

  const openaiKey = incomingKeys.bearer || openaiEnvKey;
  const geminiKey = incomingKeys.goog || geminiEnvKey || incomingKeys.bearer;

  const attempts = [];

  if (openaiKey) {
    attempts.push({
      format: 'openai',
      baseUrl: sourceApiUrl,
      promise: fetchOpenAIModels(configValue, openaiKey).then((rawPayload) => ({
        models: normalizeModelList(rawPayload),
      })),
    });
  }

  if (geminiKey) {
    attempts.push({
      format: 'gemini',
      baseUrl: configValue.GEMINI_BASE_URL || gemini.DEFAULT_BASE_URL,
      promise: fetchGeminiModels(configValue, geminiKey).then((models) => ({ models })),
    });
  }

  if (!attempts.length) {
    return sendJsonError(
      res,
      500,
      'ALLOW_ENV_API_KEY is enabled but no upstream API key is configured',
      'server_error',
    );
  }

  const results = await Promise.allSettled(attempts.map((attempt) => attempt.promise));
  const mergedModels = [];
  const seenIds = new Set();
  const sources = [];
  let successCount = 0;
  let firstFailure = null;

  results.forEach((result, index) => {
    const attempt = attempts[index];

    if (result.status === 'fulfilled') {
      successCount += 1;

      for (const model of result.value.models) {
        if (seenIds.has(model.id)) continue;
        seenIds.add(model.id);
        mergedModels.push(model);
      }

      sources.push({
        format: attempt.format,
        base_url: attempt.baseUrl,
        ok: true,
        count: result.value.models.length,
      });
      return;
    }

    const upstreamError = result.reason;
    const upstreamPayload = upstreamError?.response?.data;

    sources.push({
      format: attempt.format,
      base_url: attempt.baseUrl,
      ok: false,
      error: upstreamPayload?.error?.message
        || upstreamError?.message
        || 'request failed',
    });

    if (!firstFailure) firstFailure = { attempt, error: upstreamError };
  });

  if (successCount === 0 && firstFailure) {
    return sendUpstreamError(
      res,
      firstFailure.error,
      firstFailure.attempt.format,
      'Failed to fetch models',
    );
  }

  const firstSuccessfulSource = sources.find((source) => source.ok);

  return res.status(200).json(buildListPayload(mergedModels, {
    simple: useSimpleResponse,
    format: 'auto',
    sourceApiUrl: firstSuccessfulSource ? firstSuccessfulSource.base_url : sourceApiUrl,
    sources,
  }));
};
