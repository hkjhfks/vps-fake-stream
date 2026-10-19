const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const MAX_ENTRIES = 5000;

const attempts = new Map();

function getKey(req) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

function prune(now) {
    for (const [key, state] of attempts.entries()) {
        if (!state.resetAt || state.resetAt <= now) attempts.delete(key);
    }
    if (attempts.size > MAX_ENTRIES) {
        const overflow = attempts.size - MAX_ENTRIES;
        let removed = 0;
        for (const key of attempts.keys()) {
            attempts.delete(key);
            removed += 1;
            if (removed >= overflow) break;
        }
    }
}

function check(req) {
    const now = Date.now();
    prune(now);
    const key = getKey(req);
    const state = attempts.get(key);
    if (!state) return { blocked: false, remaining: MAX_FAILURES };
    if (state.resetAt <= now) {
        attempts.delete(key);
        return { blocked: false, remaining: MAX_FAILURES };
    }
    if (state.failures >= MAX_FAILURES) {
        return {
            blocked: true,
            retryAfter: Math.max(1, Math.ceil((state.resetAt - now) / 1000)),
        };
    }
    return { blocked: false, remaining: Math.max(0, MAX_FAILURES - state.failures) };
}

function recordFailure(req) {
    const now = Date.now();
    prune(now);
    const key = getKey(req);
    const current = attempts.get(key);
    if (!current || current.resetAt <= now) {
        attempts.set(key, { failures: 1, resetAt: now + WINDOW_MS });
        return;
    }
    current.failures += 1;
}

function clear(req) {
    attempts.delete(getKey(req));
}

const cleanupTimer = setInterval(() => prune(Date.now()), 5 * 60 * 1000);
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

module.exports = {
    check,
    recordFailure,
    clear,
    MAX_FAILURES,
    WINDOW_MS,
};
