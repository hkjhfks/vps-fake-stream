const { getConfig } = require('../lib/config-store');
const { getRecentRequestLogs, clearRequestLogs, getLogPath } = require('../lib/request-logs');

module.exports = async (req, res) => {
    const currentConfig = getConfig();
    const allowOrigin = currentConfig.CORS_ALLOW_ORIGIN || '*';

    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method === 'GET') {
        const limit = Number(req.query?.limit || 100);
        const logs = getRecentRequestLogs(limit);
        return res.status(200).json({
            status: 'ok',
            count: logs.length,
            logs,
            log_path: getLogPath(),
        });
    }

    if (req.method === 'DELETE') {
        clearRequestLogs();
        return res.status(200).json({
            status: 'ok',
            message: 'Logs cleared',
        });
    }

    return res.status(405).json({ error: 'Method not allowed' });
};
