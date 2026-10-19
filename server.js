const fs = require('fs');
const path = require('path');
const express = require('express');

const chatHandler = require('./api/chat');
const modelsHandler = require('./api/models');
const statusHandler = require('./api/status');
const configHandler = require('./api/config');
const logsHandler = require('./api/logs');
const adminSessionHandler = require('./api/admin-session');
const adminLoginHandler = require('./api/admin-login');
const adminLogoutHandler = require('./api/admin-logout');

const { ensureConfigFile } = require('./lib/config-store');
const { ensureLogFile } = require('./lib/request-logs');
const { requireAdminApi, requireAdminPage } = require('./lib/admin-auth');

const app = express();
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const DIST_DIR = path.join(__dirname, 'dist');
const DIST_INDEX = path.join(DIST_DIR, 'index.html');
const DIST_READY = fs.existsSync(DIST_INDEX);

app.set('trust proxy', 1);

ensureConfigFile();
ensureLogFile();

app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
});

app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
        return res.status(400).json({
            error: {
                message: 'Invalid JSON body',
                type: 'invalid_request_error',
            },
        });
    }
    return next(err);
});

function wrapHandler(handler) {
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (error) {
            console.error('[server] unhandled route error:', error);
            if (!res.headersSent) {
                res.status(500).json({
                    error: {
                        message: 'Internal server error',
                        type: 'server_error',
                    },
                });
            }
        }
    };
}

app.all('/api/chat', wrapHandler(chatHandler));
app.all('/v1/chat/completions', wrapHandler(chatHandler));

app.all('/api/models', wrapHandler(modelsHandler));
app.all('/v1/models', wrapHandler(modelsHandler));

app.all('/api/status', wrapHandler(statusHandler));
app.all('/api/admin/session', wrapHandler(adminSessionHandler));
app.all('/api/admin/login', wrapHandler(adminLoginHandler));
app.all('/api/admin/logout', wrapHandler(adminLogoutHandler));

app.all('/api/config', (req, res) => {
    if (!requireAdminApi(req, res)) return;
    return wrapHandler(configHandler)(req, res);
});
app.all('/api/logs', (req, res) => {
    if (!requireAdminApi(req, res)) return;
    return wrapHandler(logsHandler)(req, res);
});
app.all('/api/logs/:id', (req, res) => {
    if (!requireAdminApi(req, res)) return;
    return wrapHandler(logsHandler.detail)(req, res);
});

app.use(['/api', '/v1'], (req, res) => {
    res.status(404).json({
        error: {
            message: 'Not found',
            type: 'invalid_request_error',
        },
    });
});

const legacyRedirects = {
    '/admin.html': '/login',
    '/config.html': '/settings',
    '/logs.html': '/logs',
};

app.get(Object.keys(legacyRedirects), (req, res) => {
    res.redirect(302, legacyRedirects[req.path] || '/');
});

const PUBLIC_FILES = [
    '/favicon.svg',
    '/favicon.ico',
    '/apple-touch-icon.png',
    '/manifest.webmanifest',
    '/robots.txt',
];

// Vite emits hashed files under /assets; they are safe to cache aggressively.
app.use('/assets', express.static(path.join(DIST_DIR, 'assets'), {
    immutable: true,
    maxAge: '1y',
    fallthrough: true,
}));

app.get(PUBLIC_FILES, (req, res) => {
    const filename = path.basename(req.path);
    const filePath = path.join(DIST_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).type('text/plain').send('Not found');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(filePath);
});

// The whole console is private. /login and static assets stay public; the
// OpenAI-compatible proxy endpoints above keep their own Key semantics.
app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path === '/login') return next();
    if (req.path.startsWith('/assets/')) return next();
    if (PUBLIC_FILES.includes(req.path)) return next();
    return requireAdminPage(req, res, next);
});

app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!DIST_READY) {
        return res.status(503).type('text/plain').send(
            'Frontend is not built yet. Run `npm run build` before starting the server.',
        );
    }
    if (req.path.includes('.')) return res.status(404).type('text/plain').send('Not found');
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(DIST_INDEX);
});

app.use((req, res) => {
    res.status(404).type('text/plain').send('Not found');
});

app.listen(PORT, HOST, () => {
    console.log(`[server] running at http://${HOST}:${PORT}`);
});
