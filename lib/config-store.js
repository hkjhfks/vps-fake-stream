const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(process.cwd(), 'config');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = Object.freeze({
    OPENAI_API_KEY: '',
    SOURCE_API_URL: 'https://api.openai.com',
    CORS_ALLOW_ORIGIN: '*',
    ALLOW_ENV_API_KEY: false,
    ADMIN_PASSWORD: '',
    ADMIN_SESSION_TTL_HOURS: 24,
    HEARTBEAT_INTERVAL_MS: 3000,
    CHUNK_TARGET_LENGTH: 30,
    CHUNK_DELAY_MS: 35,
    DEBUG: false,
    UPSTREAM_EXTRA_HEADERS_JSON: '',
    LOG_MAX_OUTPUT_CHARS: 12000,
    LOG_RETENTION: 2000,
});

let cachedConfig = null;
let cachedMtimeMs = -1;

function toBoolean(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
        if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    }
    return fallback;
}

function toInteger(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    const rounded = Math.round(parsed);
    if (typeof min === 'number' && rounded < min) return min;
    if (typeof max === 'number' && rounded > max) return max;
    return rounded;
}

function normalizeSourceUrl(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    const url = raw || DEFAULT_CONFIG.SOURCE_API_URL;
    return url.replace(/\/+$/, '');
}

function normalizeHeadersJson(rawValue, strict = false) {
    if (rawValue === undefined || rawValue === null || rawValue === '') return '';

    if (typeof rawValue === 'object') {
        if (Array.isArray(rawValue)) {
            if (strict) throw new Error('UPSTREAM_EXTRA_HEADERS_JSON must be a JSON object');
            return '';
        }
        return JSON.stringify(rawValue);
    }

    if (typeof rawValue === 'string') {
        const trimmed = rawValue.trim();
        if (!trimmed) return '';
        try {
            const parsed = JSON.parse(trimmed);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                if (strict) throw new Error('UPSTREAM_EXTRA_HEADERS_JSON must be a JSON object');
                return '';
            }
            return JSON.stringify(parsed);
        } catch (error) {
            if (strict) throw new Error('UPSTREAM_EXTRA_HEADERS_JSON must be valid JSON object text');
            return '';
        }
    }

    if (strict) throw new Error('UPSTREAM_EXTRA_HEADERS_JSON must be a JSON object string');
    return '';
}

function normalizeCorsAllowOrigin(rawValue) {
    if (Array.isArray(rawValue)) {
        return rawValue
            .map((item) => (typeof item === 'string' ? item.trim() : ''))
            .filter(Boolean)
            .join('\n') || DEFAULT_CONFIG.CORS_ALLOW_ORIGIN;
    }

    return typeof rawValue === 'string' && rawValue.trim()
        ? rawValue.trim()
        : DEFAULT_CONFIG.CORS_ALLOW_ORIGIN;
}

function normalizeConfig(rawConfig = {}, strict = false) {
    return {
        OPENAI_API_KEY: typeof rawConfig.OPENAI_API_KEY === 'string' ? rawConfig.OPENAI_API_KEY.trim() : DEFAULT_CONFIG.OPENAI_API_KEY,
        SOURCE_API_URL: normalizeSourceUrl(rawConfig.SOURCE_API_URL),
        CORS_ALLOW_ORIGIN: normalizeCorsAllowOrigin(rawConfig.CORS_ALLOW_ORIGIN),
        ALLOW_ENV_API_KEY: toBoolean(rawConfig.ALLOW_ENV_API_KEY, DEFAULT_CONFIG.ALLOW_ENV_API_KEY),
        ADMIN_PASSWORD: typeof rawConfig.ADMIN_PASSWORD === 'string' ? rawConfig.ADMIN_PASSWORD.trim() : DEFAULT_CONFIG.ADMIN_PASSWORD,
        ADMIN_SESSION_TTL_HOURS: toInteger(rawConfig.ADMIN_SESSION_TTL_HOURS, DEFAULT_CONFIG.ADMIN_SESSION_TTL_HOURS, 1, 720),
        HEARTBEAT_INTERVAL_MS: toInteger(rawConfig.HEARTBEAT_INTERVAL_MS, DEFAULT_CONFIG.HEARTBEAT_INTERVAL_MS, 500, 60000),
        CHUNK_TARGET_LENGTH: toInteger(rawConfig.CHUNK_TARGET_LENGTH, DEFAULT_CONFIG.CHUNK_TARGET_LENGTH, 1, 500),
        CHUNK_DELAY_MS: toInteger(rawConfig.CHUNK_DELAY_MS, DEFAULT_CONFIG.CHUNK_DELAY_MS, 0, 10000),
        DEBUG: toBoolean(rawConfig.DEBUG, DEFAULT_CONFIG.DEBUG),
        UPSTREAM_EXTRA_HEADERS_JSON: normalizeHeadersJson(rawConfig.UPSTREAM_EXTRA_HEADERS_JSON, strict),
        LOG_MAX_OUTPUT_CHARS: toInteger(rawConfig.LOG_MAX_OUTPUT_CHARS, DEFAULT_CONFIG.LOG_MAX_OUTPUT_CHARS, 200, 200000),
        LOG_RETENTION: toInteger(rawConfig.LOG_RETENTION, DEFAULT_CONFIG.LOG_RETENTION, 100, 200000),
    };
}

function buildInitialConfigFromEnv() {
    return normalizeConfig({
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        SOURCE_API_URL: process.env.SOURCE_API_URL,
        CORS_ALLOW_ORIGIN: process.env.CORS_ALLOW_ORIGIN,
        ALLOW_ENV_API_KEY: process.env.ALLOW_ENV_API_KEY,
        HEARTBEAT_INTERVAL_MS: process.env.HEARTBEAT_INTERVAL_MS,
        CHUNK_TARGET_LENGTH: process.env.CHUNK_TARGET_LENGTH,
        CHUNK_DELAY_MS: process.env.CHUNK_DELAY_MS,
        DEBUG: process.env.DEBUG,
        UPSTREAM_EXTRA_HEADERS_JSON: process.env.UPSTREAM_EXTRA_HEADERS_JSON,
        LOG_MAX_OUTPUT_CHARS: process.env.LOG_MAX_OUTPUT_CHARS,
        LOG_RETENTION: process.env.LOG_RETENTION,
    });
}

function writeConfigFile(configValue) {
    const tempPath = `${CONFIG_PATH}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(configValue, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, CONFIG_PATH);
}

function ensureConfigFile() {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    if (!fs.existsSync(CONFIG_PATH)) {
        const initial = buildInitialConfigFromEnv();
        writeConfigFile(initial);
    }
}

function readConfigFromDisk() {
    ensureConfigFile();
    try {
        const content = fs.readFileSync(CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(content);
        return normalizeConfig(parsed);
    } catch (error) {
        const fallback = buildInitialConfigFromEnv();
        writeConfigFile(fallback);
        return fallback;
    }
}

function getConfig() {
    ensureConfigFile();
    try {
        const stat = fs.statSync(CONFIG_PATH);
        if (!cachedConfig || stat.mtimeMs !== cachedMtimeMs) {
            cachedConfig = readConfigFromDisk();
            cachedMtimeMs = stat.mtimeMs;
        }
    } catch (error) {
        cachedConfig = readConfigFromDisk();
        const stat = fs.statSync(CONFIG_PATH);
        cachedMtimeMs = stat.mtimeMs;
    }

    return { ...cachedConfig };
}

function updateConfig(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('Request body must be a JSON object');
    }

    const current = getConfig();
    const next = normalizeConfig({ ...current, ...patch }, true);
    writeConfigFile(next);

    cachedConfig = next;
    cachedMtimeMs = fs.statSync(CONFIG_PATH).mtimeMs;

    return { ...next };
}

function getUpstreamExtraHeaders(configValue = getConfig()) {
    const raw = configValue.UPSTREAM_EXTRA_HEADERS_JSON;
    if (!raw) return {};

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return parsed;
    } catch (error) {
        return {};
    }
}

function getConfigPath() {
    return CONFIG_PATH;
}

module.exports = {
    DEFAULT_CONFIG,
    CONFIG_PATH,
    ensureConfigFile,
    getConfig,
    updateConfig,
    getUpstreamExtraHeaders,
    getConfigPath,
};
