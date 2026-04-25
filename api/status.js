const { getConfig, getConfigPath } = require('../lib/config-store');
const { applyCors } = require('../lib/cors');

module.exports = async (req, res) => {
  const configValue = getConfig();

  applyCors(req, res, {
    allowOrigin: configValue.CORS_ALLOW_ORIGIN,
    methods: 'GET, OPTIONS',
    headers: 'Content-Type',
  });

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 只允许 GET 请求
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const status = {
    status: 'ok',
    message: '假流式代理服务正常运行',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    features: {
      streaming: true,
      non_streaming: true,
      models: true,
      cors: true,
      config_hot_reload: true,
      request_logging: true,
      admin_auth: true,
    },
    endpoints: {
      chat: '/api/chat',
      status: '/api/status',
      models: '/api/models',
      config: '/api/config',
      logs: '/api/logs',
      test_page: '/'
    },
    environment: {
      has_api_key: !!configValue.OPENAI_API_KEY,
      source_api_url: configValue.SOURCE_API_URL || 'https://api.openai.com',
      allow_env_api_key: !!configValue.ALLOW_ENV_API_KEY,
      admin_auth_enabled: !!configValue.ADMIN_PASSWORD,
      admin_session_ttl_hours: Number(configValue.ADMIN_SESSION_TTL_HOURS || 24),
      heartbeat_interval_ms: Number(configValue.HEARTBEAT_INTERVAL_MS || 3000),
      config_path: getConfigPath(),
    },
  };

  res.json(status);
};
