const { clearAdminSessionCookie, getAdminSettings } = require('../lib/admin-auth');

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

    clearAdminSessionCookie(req, res);

    return res.status(200).json({
        status: 'ok',
        message: 'Admin logout success',
        auth_enabled: getAdminSettings().enabled,
    });
};
