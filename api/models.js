const axios = require('axios');
const { getConfig, getUpstreamExtraHeaders } = require('../lib/config-store');

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

module.exports = async (req, res) => {
  const configValue = getConfig();

  // CORS
  const allowOrigin = configValue.CORS_ALLOW_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const envApiKey = configValue.OPENAI_API_KEY;
  const sourceApiUrl = configValue.SOURCE_API_URL || 'https://api.openai.com';
  const allowEnvKeyFallback = !!configValue.ALLOW_ENV_API_KEY;

  const authHeader = req.headers.authorization || '';
  const headerKey = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : '';
  const hasHeaderKey = !!headerKey;

  if (!hasHeaderKey && !allowEnvKeyFallback) {
    return res.status(401).json({ error: { message: 'Missing Authorization header', type: 'unauthorized' } });
  }

  if (!hasHeaderKey && allowEnvKeyFallback && !envApiKey) {
    return res.status(500).json({
      error: {
        message: 'ALLOW_ENV_API_KEY is enabled but OPENAI_API_KEY is empty in config',
        type: 'server_error',
      },
    });
  }

  const requestApiKey = hasHeaderKey ? headerKey : envApiKey;
  const useSimpleResponse = parseBooleanFlag(req.query?.simple);

  const headers = { Authorization: `Bearer ${requestApiKey}` };
  Object.assign(headers, getUpstreamExtraHeaders(configValue));

  try {
    const response = await axios.get(`${sourceApiUrl}/v1/models`, { headers });

    if (!useSimpleResponse) {
      return res.status(200).json(response.data);
    }

    const models = normalizeModelList(response.data);
    return res.status(200).json({
      object: 'list',
      data: models,
      count: models.length,
      source_api_url: sourceApiUrl,
      fetched_at: new Date().toISOString(),
    });
  } catch (error) {
    const upErr = error?.response?.data || null;
    const statusCode = error?.response?.status || 500;
    return res.status(statusCode).json(upErr || { error: { message: 'Failed to fetch models', type: 'server_error' } });
  }
};

