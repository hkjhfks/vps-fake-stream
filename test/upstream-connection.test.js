'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// config-store / request-logs use process.cwd(), so run in a temp directory.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-fake-stream-connection-test-'));
process.chdir(tempDir);
fs.mkdirSync(path.join(tempDir, 'config'), { recursive: true });
fs.mkdirSync(path.join(tempDir, 'data'), { recursive: true });

const express = require('express');
const { before, after, test } = require('node:test');

const configStore = require('../lib/config-store');
const chatHandler = require('../api/chat');
const modelsHandler = require('../api/models');

// Must stay above Node's 5s global-agent socket timeout, which used to kill
// requests that reused a socket poisoned by follow-redirects' leaked listener.
const UPSTREAM_DELAY_MS = 5500;

let upstreamServer;
let proxyServer;
let proxyBase = '';

function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function closeServer(server) {
    return new Promise((resolve) => {
        if (!server) return resolve();
        if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
        }
        server.close(() => resolve());
    });
}

before(async () => {
    upstreamServer = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url.startsWith('/v1beta/models')) {
            return sendJson(res, 200, {
                models: [{ name: 'models/gemini-3.8-flash' }],
            });
        }

        if (req.method === 'POST' && req.url.includes(':generateContent')) {
            req.on('data', () => {});
            req.on('end', () => {
                setTimeout(() => {
                    sendJson(res, 200, {
                        candidates: [{
                            content: { role: 'model', parts: [{ text: 'ok after delay' }] },
                            finishReason: 'STOP',
                        }],
                        usageMetadata: {
                            promptTokenCount: 1,
                            candidatesTokenCount: 2,
                            totalTokenCount: 3,
                        },
                    });
                }, UPSTREAM_DELAY_MS);
            });
            return;
        }

        return sendJson(res, 404, { error: { message: 'not found' } });
    });

    await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
    const upstreamPort = upstreamServer.address().port;

    configStore.updateConfig({
        UPSTREAM_FORMAT: 'gemini',
        GEMINI_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
        GEMINI_API_KEY: 'test-key',
        OPENAI_API_KEY: '',
        ALLOW_ENV_API_KEY: true,
        CORS_ALLOW_ORIGIN: '*',
        DEBUG: false,
    });

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.all('/api/chat', chatHandler);
    app.all('/v1/chat/completions', chatHandler);
    app.all('/api/models', modelsHandler);

    proxyServer = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => proxyServer.once('listening', resolve));
    proxyBase = `http://127.0.0.1:${proxyServer.address().port}`;
});

after(async () => {
    await closeServer(proxyServer);
    await closeServer(upstreamServer);
});

test('a model-list request cannot poison a later long chat request', { timeout: 20000 }, async () => {
    const modelsResponse = await fetch(`${proxyBase}/api/models?simple=1`);
    assert.equal(modelsResponse.status, 200);
    const modelsPayload = await modelsResponse.json();
    assert.equal(modelsPayload.data.length, 1);

    const startedAt = Date.now();
    const chatResponse = await fetch(`${proxyBase}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'gemini-3.8-flash',
            messages: [{ role: 'user', content: 'hello' }],
            stream: false,
        }),
    });
    const chatPayload = await chatResponse.json();

    assert.equal(chatResponse.status, 200, JSON.stringify(chatPayload));
    assert.ok(
        Date.now() - startedAt >= UPSTREAM_DELAY_MS,
        'the chat request must survive longer than the old 5s socket timeout',
    );
    assert.match(chatPayload.choices[0].message.content, /ok after delay/);
});
