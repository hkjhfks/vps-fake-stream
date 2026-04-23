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
const PORT = Number(process.env.PORT || 3000);

ensureConfigFile();
ensureLogFile();

app.use(express.json({ limit: '2mb' }));

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

app.use(['/config.html', '/logs.html'], requireAdminPage);

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`[server] running at http://0.0.0.0:${PORT}`);
});
