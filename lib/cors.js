function appendVaryValue(currentValue, nextValue) {
    const parts = String(currentValue || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

    if (!parts.includes(nextValue)) {
        parts.push(nextValue);
    }

    return parts.join(', ');
}

function normalizeOriginValue(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!trimmed || trimmed === '*') return trimmed;
    return trimmed.replace(/\/+$/, '');
}

function parseAllowedOrigins(rawValue) {
    if (Array.isArray(rawValue)) {
        return rawValue
            .map((item) => normalizeOriginValue(item))
            .filter(Boolean);
    }

    const normalized = normalizeOriginValue(rawValue);
    if (!normalized) return [];
    if (normalized === '*') return ['*'];

    return normalized
        .split(/[\n,]+/)
        .map((item) => normalizeOriginValue(item))
        .filter(Boolean);
}

function resolveAllowedOrigin(originHeader, rawAllowOrigin) {
    const allowedOrigins = parseAllowedOrigins(rawAllowOrigin);
    if (!allowedOrigins.length) {
        return { allowOrigin: '*', varyOrigin: false };
    }

    if (allowedOrigins.includes('*')) {
        return { allowOrigin: '*', varyOrigin: false };
    }

    const normalizedOrigin = normalizeOriginValue(originHeader);
    if (!normalizedOrigin) {
        return {
            allowOrigin: allowedOrigins.length === 1 ? allowedOrigins[0] : '',
            varyOrigin: allowedOrigins.length > 1,
        };
    }

    if (allowedOrigins.includes(normalizedOrigin)) {
        return { allowOrigin: normalizedOrigin, varyOrigin: true };
    }

    return { allowOrigin: '', varyOrigin: true };
}

function applyCors(req, res, options = {}) {
    const {
        allowOrigin = '*',
        methods = 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        headers = 'Content-Type, Authorization',
    } = options;

    const { allowOrigin: headerValue, varyOrigin } = resolveAllowedOrigin(req.headers.origin, allowOrigin);

    if (headerValue) {
        res.setHeader('Access-Control-Allow-Origin', headerValue);
    }
    if (varyOrigin) {
        res.setHeader('Vary', appendVaryValue(res.getHeader('Vary'), 'Origin'));
    }

    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', headers);
}

module.exports = {
    applyCors,
    parseAllowedOrigins,
    resolveAllowedOrigin,
};
