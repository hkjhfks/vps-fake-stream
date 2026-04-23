const axios = require('axios');
const { getConfig, getUpstreamExtraHeaders } = require('../lib/config-store');

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

  const headers = { Authorization: `Bearer ${requestApiKey}` };
  Object.assign(headers, getUpstreamExtraHeaders(configValue));

  try {
    const response = await axios.get(`${sourceApiUrl}/v1/models`, { headers });
    return res.status(200).json(response.data);
  } catch (error) {
    const upErr = error?.response?.data || null;
    const statusCode = error?.response?.status || 500;
    return res.status(statusCode).json(upErr || { error: { message: 'Failed to fetch models', type: 'server_error' } });
  }
};

