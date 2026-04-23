const { getConfig, updateConfig, getConfigPath } = require('../lib/config-store');

module.exports = async (req, res) => {
    const currentConfig = getConfig();
    const allowOrigin = currentConfig.CORS_ALLOW_ORIGIN || '*';

    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, PATCH, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method === 'GET') {
        return res.status(200).json({
            status: 'ok',
            config: currentConfig,
            config_path: getConfigPath(),
        });
    }

    if (!['PUT', 'PATCH', 'POST'].includes(req.method)) {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const next = updateConfig(req.body || {});
        return res.status(200).json({
            status: 'ok',
            message: 'Config updated',
            config: next,
            config_path: getConfigPath(),
        });
    } catch (error) {
        return res.status(400).json({
            error: {
                message: error.message || 'Invalid config payload',
                type: 'invalid_request_error',
            },
        });
    }
};
