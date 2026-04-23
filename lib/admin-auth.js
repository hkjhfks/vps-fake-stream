const crypto = require('crypto');
const { getConfig } = require('./config-store');

const ADMIN_COOKIE_NAME = 'admin_session';
const DEFAULT_NEXT_PATH = '/config.html';

function getAdminSettings() {
    const configValue = getConfig();
    const password = typeof configValue.ADMIN_PASSWORD === 'string' ? configValue.ADMIN_PASSWORD : '';
    const ttlHours = Number(configValue.ADMIN_SESSION_TTL_HOURS) || 24;

    return {
        enabled: !!password,
        password,
        ttlHours: Math.max(1, Math.min(720, Math.round(ttlHours))),
    };
}

function parseCookies(req) {
    const header = req.headers.cookie || '';
    if (!header) return {};

    return header.split(';').reduce((acc, part) => {
        const index = part.indexOf('=');
        if (index === -1) return acc;

        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (key) acc[key] = decodeURIComponent(value);
        return acc;
    }, {});
}

function createSignature(value, password) {
    return crypto.createHmac('sha256', password).update(value).digest('base64url');
}

function safeEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getSessionToken(req) {
    const cookies = parseCookies(req);
    return cookies[ADMIN_COOKIE_NAME] || '';
}

function createSessionToken(settings = getAdminSettings()) {
    const now = Date.now();
    const payload = Buffer.from(JSON.stringify({
        iat: now,
        exp: now + settings.ttlHours * 60 * 60 * 1000,
    })).toString('base64url');

    const signature = createSignature(payload, settings.password);
    return `${payload}.${signature}`;
}

function verifySessionToken(token, settings = getAdminSettings()) {
    if (!settings.enabled || typeof token !== 'string' || !token) return false;

    const [payload, signature] = token.split('.');
    if (!payload || !signature) return false;

    const expected = createSignature(payload, settings.password);
    if (!safeEqual(signature, expected)) return false;

    try {
        const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return Number.isFinite(parsed?.exp) && parsed.exp > Date.now();
    } catch (error) {
        return false;
    }
}

function isSecureRequest(req) {
    if (req.secure) return true;
    const proto = req.headers['x-forwarded-proto'];
    return typeof proto === 'string' && proto.split(',')[0].trim() === 'https';
}

function setAdminSessionCookie(req, res, settings = getAdminSettings()) {
    const token = createSessionToken(settings);
    const cookieParts = [
        `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${settings.ttlHours * 60 * 60}`,
    ];

    if (isSecureRequest(req)) {
        cookieParts.push('Secure');
    }

    res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function clearAdminSessionCookie(req, res) {
    const cookieParts = [
        `${ADMIN_COOKIE_NAME}=`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=0',
    ];

    if (isSecureRequest(req)) {
        cookieParts.push('Secure');
    }

    res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function isAuthorizedByHeader(req, settings) {
    const headerPassword = req.headers['x-admin-password'];
    return typeof headerPassword === 'string' && safeEqual(headerPassword, settings.password);
}

function isAdminPasswordMatch(password, settings = getAdminSettings()) {
    return settings.enabled && typeof password === 'string' && safeEqual(password, settings.password);
}

function getAdminAuthState(req, settings = getAdminSettings()) {
    if (!settings.enabled) {
        return {
            ok: false,
            code: 503,
            type: 'admin_not_configured',
            message: 'ADMIN_PASSWORD is empty in config/config.json',
        };
    }

    if (isAuthorizedByHeader(req, settings)) {
        return { ok: true, method: 'header' };
    }

    if (verifySessionToken(getSessionToken(req), settings)) {
        return { ok: true, method: 'cookie' };
    }

    return {
        ok: false,
        code: 401,
        type: 'admin_unauthorized',
        message: 'Admin authentication required',
    };
}

function redirectToLogin(req, res, reason) {
    const nextPath = encodeURIComponent(req.originalUrl || req.url || DEFAULT_NEXT_PATH);
    const target = `/admin.html?next=${nextPath}${reason ? `&reason=${encodeURIComponent(reason)}` : ''}`;
    res.redirect(302, target);
}

function requireAdminPage(req, res, next) {
    const state = getAdminAuthState(req);
    if (state.ok) {
        return next();
    }

    redirectToLogin(req, res, state.type);
}

function requireAdminApi(req, res) {
    const state = getAdminAuthState(req);
    if (state.ok) {
        return true;
    }

    res.status(state.code).json({
        error: {
            message: state.message,
            type: state.type,
        },
    });
    return false;
}

function getAdminSessionInfo(req) {
    const settings = getAdminSettings();
    const state = getAdminAuthState(req, settings);

    return {
        authenticated: state.ok,
        auth_enabled: settings.enabled,
        session_ttl_hours: settings.ttlHours,
        cookie_name: ADMIN_COOKIE_NAME,
    };
}

module.exports = {
    ADMIN_COOKIE_NAME,
    getAdminSettings,
    getAdminAuthState,
    getAdminSessionInfo,
    requireAdminApi,
    requireAdminPage,
    setAdminSessionCookie,
    clearAdminSessionCookie,
    isAdminPasswordMatch,
};
