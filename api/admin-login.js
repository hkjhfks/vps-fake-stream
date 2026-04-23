const { getAdminSettings, setAdminSessionCookie, isAdminPasswordMatch } = require('../lib/admin-auth');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Password');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const settings = getAdminSettings();
    if (!settings.enabled) {
        return res.status(503).json({
            error: {
                message: 'ADMIN_PASSWORD is empty in config/config.json',
                type: 'admin_not_configured',
            },
        });
    }

    const password = typeof req.body?.password === 'string' ? req.body.password.trim() : '';
    if (!password || !isAdminPasswordMatch(password, settings)) {
        return res.status(401).json({
            error: {
                message: 'Invalid admin password',
                type: 'admin_unauthorized',
            },
        });
    }

    setAdminSessionCookie(req, res, settings);

    return res.status(200).json({
        status: 'ok',
        message: 'Admin login success',
        authenticated: true,
        auth_enabled: true,
        session_ttl_hours: settings.ttlHours,
    });
};
