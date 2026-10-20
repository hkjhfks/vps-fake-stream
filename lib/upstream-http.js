'use strict';

const http = require('http');
const https = require('https');

/**
 * Node >= 19 gives `http.globalAgent` `keepAlive: true` and `timeout: 5000`.
 * axios goes through follow-redirects, which registers
 * `socket.on('timeout', socket.destroy)` for every request that specifies a
 * timeout and never removes that listener afterwards (follow-redirects 1.x).
 *
 * When a short request with a timeout (for example the upstream model list)
 * finishes, the socket goes back into the global agent's free pool with a 5s
 * timeout. The next long-running request that reuses that socket inherits the
 * leaked `socket.destroy` listener, so at 5s the still-active request is
 * destroyed and axios reports `socket hang up`.
 *
 * Upstream calls therefore use dedicated agents that never keep sockets alive.
 * Each request gets a fresh socket, so a listener leaked by an earlier request
 * can never affect a later generation. The agents also opt out of Node's 5s
 * global timeout; timeouts are applied explicitly per request instead.
 */
const httpAgent = new http.Agent({ keepAlive: false, timeout: 0 });
const httpsAgent = new https.Agent({ keepAlive: false, timeout: 0 });

// Browser-driven upstreams can legitimately take several minutes. Keep this
// generous; the upstream has its own shorter generation timeout.
const UPSTREAM_CHAT_TIMEOUT_MS = 600000;
const UPSTREAM_MODEL_LIST_TIMEOUT_MS = 20000;

function upstreamAgentOptions(extra = {}) {
    return { httpAgent, httpsAgent, ...extra };
}

/**
 * Network failures that happen before any upstream response can be retried
 * safely. HTTP status errors carry `error.response` and must not be retried.
 */
function isRetryableNetworkError(error) {
    if (!error || error.response) return false;

    const code = String(error.code || '').toUpperCase();
    const message = String(error.message || '').toLowerCase();

    return [
        'ECONNRESET',
        'EPIPE',
        'ETIMEDOUT',
        'EAI_AGAIN',
        'ENOTFOUND',
        'EHOSTUNREACH',
        'ENETUNREACH',
    ].includes(code) || message.includes('socket hang up');
}

module.exports = {
    httpAgent,
    httpsAgent,
    upstreamAgentOptions,
    isRetryableNetworkError,
    UPSTREAM_CHAT_TIMEOUT_MS,
    UPSTREAM_MODEL_LIST_TIMEOUT_MS,
};
