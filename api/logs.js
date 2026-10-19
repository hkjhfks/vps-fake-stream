const fs = require('fs');
const { getConfig } = require('../lib/config-store');
const {
    getRecentRequestLogs,
    getRequestLogById,
    clearRequestLogs,
    getLogPath,
} = require('../lib/request-logs');
const { applyCors } = require('../lib/cors');

function handleCors(req, res, currentConfig, methods) {
    applyCors(req, res, {
        allowOrigin: currentConfig.CORS_ALLOW_ORIGIN,
        methods,
        headers: 'Content-Type, Authorization',
    });
}

/**
 * The log file is append-only, so size + mtime identify its contents. This lets
 * the 30s poll answer 304 Not Modified while nothing is happening.
 */
function setValidatorHeaders(res, mode, limit) {
    try {
        const stat = fs.statSync(getLogPath());
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('ETag', `W/"${mode}-${limit}-${stat.size}-${Math.round(stat.mtimeMs)}"`);
    } catch (_) {
        res.setHeader('Cache-Control', 'no-cache');
    }
}

async function listLogs(req, res) {
    const currentConfig = getConfig();
    handleCors(req, res, currentConfig, 'GET, DELETE, OPTIONS');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method === 'GET') {
        const limit = Number(req.query?.limit || 100);
        const full = req.query?.full === '1' || req.query?.full === 'true';
        const logs = getRecentRequestLogs(limit, { full });
        setValidatorHeaders(res, full ? 'full' : 'summary', limit);
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
}

async function logDetail(req, res) {
    const currentConfig = getConfig();
    handleCors(req, res, currentConfig, 'GET, OPTIONS');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const log = getRequestLogById(String(req.params?.id || ''));
    if (!log) {
        return res.status(404).json({
            error: { message: 'Log not found', type: 'not_found' },
        });
    }

    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(200).json({ status: 'ok', log });
}

module.exports = listLogs;
module.exports.detail = logDetail;
