'use strict';

const assert = require('node:assert/strict');const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// config-store / request-logs 用 process.cwd() 定位文件，测试必须切到临时目录
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-fake-stream-gemini-test-'));
process.chdir(tempDir);
fs.mkdirSync(path.join(tempDir, 'config'), { recursive: true });
fs.mkdirSync(path.join(tempDir, 'data'), { recursive: true });

const express = require('express');
const { before, after, beforeEach, test: testCase } = require('node:test');

const configStore = require('../lib/config-store');
const gemini = require('../lib/gemini');
const chatHandler = require('../api/chat');
const modelsHandler = require('../api/models');
const statusHandler = require('../api/status');

let proxyServer;
let geminiServer;
let openaiServer;
let proxyBase = '';

let geminiResponder = () => ({ status: 200, body: { candidates: [] } });
let openaiResponder = () => ({ status: 200, body: {} });

const geminiRequests = [];
const openaiRequests = [];

function startMockServer(requests, getResponder) {
    const server = http.createServer((req, res) => {
        const chunks = [];

        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', async () => {
            const rawBody = Buffer.concat(chunks).toString('utf8');
            let body = null;

            if (rawBody) {
                try {
                    body = JSON.parse(rawBody);
                } catch (error) {
                    body = rawBody;
                }
            }

            const request = {
                method: req.method,
                url: req.url,
                headers: req.headers,
                body,
                rawBody,
            };
            requests.push(request);

            try {
                const result = await getResponder()(request);
                const status = result?.status || 200;
                const payload = result?.body !== undefined ? result.body : {};

                res.writeHead(status, {
                    'Content-Type': 'application/json',
                    ...(result?.headers || {}),
                });
                res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: error.message } }));
            }
        });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function wrapHandler(handler) {
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (error) {
            if (!res.headersSent) {
                res.status(500).json({ error: { message: error.message } });
            }
        }
    };
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

function setConfig(patch) {
    configStore.updateConfig(patch);
}

function resetMocks() {
    geminiRequests.length = 0;
    openaiRequests.length = 0;

    geminiResponder = () => ({
        status: 200,
        body: {
            candidates: [{
                content: { role: 'model', parts: [{ text: 'gemini ok' }] },
                finishReason: 'STOP',
            }],
            modelVersion: 'gemini-2.5-flash',
            usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 },
        },
    });

    openaiResponder = () => ({
        status: 200,
        body: {
            id: 'chatcmpl-openai',
            object: 'chat.completion',
            created: 1700000000,
            model: 'gpt-4o-mini',
            choices: [{
                index: 0,
                message: { role: 'assistant', content: 'openai ok' },
                finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
    });
}

async function postChat(body, headers = {}) {
    return fetch(`${proxyBase}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...headers,
        },
        body: JSON.stringify(body),
    });
}

function parseSSEEvents(rawText) {
    return rawText
        .split('\n\n')
        .map((block) => block
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .join('\n'))
        .filter(Boolean);
}

before(async () => {
    geminiServer = await startMockServer(geminiRequests, () => geminiResponder);
    openaiServer = await startMockServer(openaiRequests, () => openaiResponder);

    const geminiPort = geminiServer.address().port;
    const openaiPort = openaiServer.address().port;

    setConfig({
        UPSTREAM_FORMAT: 'gemini',
        OPENAI_API_KEY: 'openai-env-key',
        GEMINI_API_KEY: 'gemini-env-key',
        SOURCE_API_URL: `http://127.0.0.1:${openaiPort}`,
        GEMINI_BASE_URL: `http://127.0.0.1:${geminiPort}`,
        GEMINI_API_VERSION: 'v1beta',
        ALLOW_ENV_API_KEY: true,
        CORS_ALLOW_ORIGIN: '*',
        ADMIN_PASSWORD: 'test-admin-password',
        HEARTBEAT_INTERVAL_MS: 60000,
        CHUNK_TARGET_LENGTH: 8,
        CHUNK_DELAY_MS: 0,
        DEBUG: false,
        LOG_MAX_OUTPUT_CHARS: 12000,
        LOG_RETENTION: 100,
    });

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.all('/api/chat', wrapHandler(chatHandler));
    app.all('/v1/chat/completions', wrapHandler(chatHandler));
    app.all('/api/models', wrapHandler(modelsHandler));
    app.all('/api/status', wrapHandler(statusHandler));

    proxyServer = await new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });

    proxyBase = `http://127.0.0.1:${proxyServer.address().port}`;
});

after(async () => {
    await closeServer(proxyServer);
    await closeServer(geminiServer);
    await closeServer(openaiServer);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
    resetMocks();
    setConfig({ UPSTREAM_FORMAT: 'gemini' });
});

testCase('Gemini 非流式：OpenAI 请求转换为 generateContent，响应再转回 OpenAI', async () => {
    geminiResponder = () => ({
        status: 200,
        body: {
            candidates: [{
                index: 0,
                content: { role: 'model', parts: [{ text: '你好' }, { text: '，世界' }] },
                finishReason: 'STOP',
            }],
            modelVersion: 'gemini-2.5-flash',
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
        },
    });

    const response = await postChat({
        model: 'gemini-2.5-flash',
        messages: [
            { role: 'system', content: 'You are terse.' },
            { role: 'user', content: 'hi' },
        ],
        temperature: 0.3,
        max_tokens: 64,
        top_p: 0.9,
        stop: ['END'],
        response_format: { type: 'json_object' },
    });

    assert.equal(response.status, 200);

    const payload = await response.json();
    assert.equal(payload.object, 'chat.completion');
    assert.equal(payload.model, 'gemini-2.5-flash');
    assert.equal(payload.choices[0].message.role, 'assistant');
    assert.equal(payload.choices[0].message.content, '你好，世界');
    assert.equal(payload.choices[0].finish_reason, 'stop');
    assert.deepEqual(payload.usage, {
        prompt_tokens: 5,
        completion_tokens: 3,
        total_tokens: 8,
    });

    assert.equal(geminiRequests.length, 1);
    const request = geminiRequests[0];
    assert.equal(request.url, '/v1beta/models/gemini-2.5-flash:generateContent');
    assert.equal(request.headers['x-goog-api-key'], 'gemini-env-key');
    assert.deepEqual(request.body.systemInstruction, {
        parts: [{ text: 'You are terse.' }],
    });
    assert.deepEqual(request.body.contents, [
        { role: 'user', parts: [{ text: 'hi' }] },
    ]);
    assert.equal(request.body.generationConfig.temperature, 0.3);
    assert.equal(request.body.generationConfig.maxOutputTokens, 64);
    assert.equal(request.body.generationConfig.topP, 0.9);
    assert.deepEqual(request.body.generationConfig.stopSequences, ['END']);
    assert.equal(request.body.generationConfig.responseMimeType, 'application/json');
});

testCase('Gemini 伪流式：SSE chunk 可拼接出完整文本，finish_reason 正确映射', async () => {
    geminiResponder = () => ({
        status: 200,
        body: {
            candidates: [{
                index: 0,
                content: { role: 'model', parts: [{ text: '第一句话。第二句话。' }] },
                finishReason: 'MAX_TOKENS',
            }],
            modelVersion: 'gemini-2.5-flash',
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 4, totalTokenCount: 8 },
        },
    });

    const response = await postChat({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: '继续' }],
        stream: true,
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /^text\/event-stream/);

    const events = parseSSEEvents(await response.text());
    assert.equal(events.at(-1), '[DONE]');

    const chunks = events.slice(0, -1).map((event) => JSON.parse(event));
    const text = chunks
        .map((chunk) => chunk.choices?.[0]?.delta?.content || '')
        .join('');

    assert.equal(text, '第一句话。第二句话。');
    assert.equal(chunks[0].choices[0].delta.role, 'assistant');
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'length');
});

testCase('Gemini tools：函数声明、工具历史与 tool_calls 响应', async () => {
    geminiResponder = () => ({
        status: 200,
        body: {
            candidates: [{
                index: 0,
                content: {
                    role: 'model',
                    parts: [
                        { text: 'Let me check' },
                        {
                            functionCall: { name: 'get_weather', args: { city: 'SH' }, id: 'call_1' },
                            thoughtSignature: 'sig-1',
                        },
                    ],
                },
                finishReason: 'STOP',
            }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
        },
    });

    const response = await postChat({
        model: 'gemini-2.5-flash',
        messages: [
            { role: 'user', content: 'weather?' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{"city":"SH"}' },
                    extra_content: { google: { thought_signature: 'sig-1' } },
                }],
            },
            { role: 'tool', tool_call_id: 'call_1', content: '{"temp":20}' },
            { role: 'user', content: 'thanks' },
        ],
        tools: [{
            type: 'function',
            function: {
                name: 'get_weather',
                description: 'Get weather',
                parameters: {
                    type: 'object',
                    properties: {
                        city: { type: 'string', description: 'City name' },
                        unit: { type: 'string', enum: ['c', 'f'] },
                    },
                    required: ['city'],
                    additionalProperties: false,
                },
            },
        }],
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
    });

    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.equal(payload.choices[0].message.content, 'Let me check');
    assert.equal(payload.choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(payload.choices[0].message.tool_calls, [{
        id: 'call_1',
        type: 'function',
        function: {
            name: 'get_weather',
            arguments: '{"city":"SH"}',
        },
        extra_content: {
            google: { thought_signature: 'sig-1' },
        },
    }]);

    const request = geminiRequests[0];

    assert.deepEqual(request.body.contents, [
        { role: 'user', parts: [{ text: 'weather?' }] },
        {
            role: 'model',
            parts: [{
                functionCall: {
                    name: 'get_weather',
                    args: { city: 'SH' },
                    id: 'call_1',
                },
                thoughtSignature: 'sig-1',
            }],
        },
        {
            role: 'user',
            parts: [
                {
                    functionResponse: {
                        name: 'get_weather',
                        response: { temp: 20 },
                        id: 'call_1',
                    },
                },
                { text: 'thanks' },
            ],
        },
    ]);

    assert.deepEqual(request.body.tools, [{
        functionDeclarations: [{
            name: 'get_weather',
            description: 'Get weather',
            parameters: {
                type: 'OBJECT',
                properties: {
                    city: { type: 'STRING', description: 'City name' },
                    unit: { type: 'STRING', enum: ['c', 'f'] },
                },
                required: ['city'],
            },
        }],
    }]);

    assert.deepEqual(request.body.toolConfig, {
        functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: ['get_weather'],
        },
    });
});

testCase('auto 模式：按模型名分流到 Gemini 与 OpenAI，且 OpenAI 响应保持原样', async () => {
    setConfig({ UPSTREAM_FORMAT: 'auto' });

    const geminiResponse = await postChat({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
    });

    assert.equal(geminiResponse.status, 200);
    const geminiPayload = await geminiResponse.json();
    assert.equal(geminiPayload.choices[0].message.content, 'gemini ok');
    assert.equal(geminiRequests.length, 1);
    assert.equal(openaiRequests.length, 0);

    const openaiResponse = await postChat({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
    });

    assert.equal(openaiResponse.status, 200);
    const openaiPayload = await openaiResponse.json();
    assert.equal(openaiPayload.id, 'chatcmpl-openai');
    assert.equal(openaiPayload.choices[0].message.content, 'openai ok');
    assert.equal(openaiRequests.length, 1);
    assert.equal(geminiRequests.length, 1);
});

testCase('Gemini 模型列表：过滤非 generateContent 模型，auto 模式合并两个上游', async () => {
    const geminiModels = {
        models: [
            {
                name: 'models/gemini-2.5-flash',
                displayName: 'Gemini 2.5 Flash',
                description: 'Fast model',
                supportedGenerationMethods: ['generateContent'],
                inputTokenLimit: 1048576,
                outputTokenLimit: 8192,
            },
            {
                name: 'models/text-embedding-004',
                supportedGenerationMethods: ['embedContent'],
            },
            {
                name: 'models/gemini-2.5-pro',
                supportedGenerationMethods: ['generateContent'],
            },
        ],
    };

    geminiResponder = () => ({ status: 200, body: geminiModels });
    openaiResponder = () => ({
        status: 200,
        body: {
            object: 'list',
            data: [{ id: 'gpt-4o-mini', object: 'model', owned_by: 'openai' }],
        },
    });

    const simpleResponse = await fetch(`${proxyBase}/api/models?simple=1`);
    assert.equal(simpleResponse.status, 200);

    const simplePayload = await simpleResponse.json();
    assert.equal(simplePayload.upstream_format, 'gemini');
    assert.deepEqual(simplePayload.data.map((model) => model.id), [
        'gemini-2.5-flash',
        'gemini-2.5-pro',
    ]);
    assert.equal(simplePayload.count, 2);

    const fullResponse = await fetch(`${proxyBase}/api/models`);
    const fullPayload = await fullResponse.json();
    assert.equal(fullPayload.data[0].display_name, 'Gemini 2.5 Flash');
    assert.equal(fullPayload.data[0].input_token_limit, 1048576);
    assert.equal(fullPayload.data[0].owned_by, 'google');

    setConfig({ UPSTREAM_FORMAT: 'auto' });

    const autoResponse = await fetch(`${proxyBase}/api/models?simple=1`);
    assert.equal(autoResponse.status, 200);

    const autoPayload = await autoResponse.json();
    assert.equal(autoPayload.upstream_format, 'auto');
    assert.deepEqual(autoPayload.data.map((model) => model.id).sort(), [
        'gemini-2.5-flash',
        'gemini-2.5-pro',
        'gpt-4o-mini',
    ]);
    assert.equal(autoPayload.sources.length, 2);
    assert.ok(autoPayload.sources.every((source) => source.ok));
});

testCase('Gemini 错误：429 响应归一化为 OpenAI 风格错误', async () => {
    geminiResponder = () => ({
        status: 429,
        body: {
            error: {
                code: 429,
                message: 'Quota exceeded',
                status: 'RESOURCE_EXHAUSTED',
            },
        },
    });

    const response = await postChat({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
    });

    assert.equal(response.status, 429);

    const payload = await response.json();
    assert.equal(payload.error.message, 'Quota exceeded');
    assert.equal(payload.error.type, 'rate_limit_error');
    assert.equal(payload.error.code, 429);
    assert.equal(payload.error.status, 'RESOURCE_EXHAUSTED');
});

testCase('Gemini 图片：拒绝远程 URL，data URL 转成 inlineData', async () => {
    const remoteResponse = await postChat({
        model: 'gemini-2.5-flash',
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: 'describe' },
                { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
            ],
        }],
    });

    assert.equal(remoteResponse.status, 400);
    const remotePayload = await remoteResponse.json();
    assert.match(remotePayload.error.message, /远程图片 URL/);
    assert.equal(geminiRequests.length, 0);

    const imageData = Buffer.from('fake-image-bytes').toString('base64');
    geminiResponder = () => ({
        status: 200,
        body: {
            candidates: [{
                content: { role: 'model', parts: [{ text: 'seen' }] },
                finishReason: 'STOP',
            }],
        },
    });

    const dataUrlResponse = await postChat({
        model: 'gemini-2.5-flash',
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: 'describe' },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${imageData}` } },
            ],
        }],
    });

    assert.equal(dataUrlResponse.status, 200);
    assert.equal(geminiRequests.length, 1);
    assert.deepEqual(geminiRequests[0].body.contents[0].parts[1], {
        inlineData: {
            mimeType: 'image/png',
            data: imageData,
        },
    });
});

testCase('Gemini 响应解析：忽略 thought part、统计 reasoning tokens、处理 prompt block', () => {
    const converted = gemini.convertResponse({
        candidates: [{
            content: {
                role: 'model',
                parts: [
                    { text: 'thinking...', thought: true },
                    { text: 'answer' },
                ],
            },
            finishReason: 'STOP',
        }],
        usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 2,
            thoughtsTokenCount: 5,
            totalTokenCount: 17,
        },
    }, { requestedModel: 'gemini-3-pro' });

    assert.equal(converted.text, 'answer');
    assert.equal(converted.finishReason, 'stop');
    assert.deepEqual(converted.usage, {
        prompt_tokens: 10,
        completion_tokens: 7,
        total_tokens: 17,
        completion_tokens_details: { reasoning_tokens: 5 },
    });

    const blocked = gemini.convertResponse({
        promptFeedback: { blockReason: 'SAFETY' },
    });

    assert.equal(blocked.finishReason, 'content_filter');
    assert.equal(blocked.response.choices[0].message.content, '');
});

testCase('JSON Schema 转换：$ref/$defs、nullable、const 和不支持字段', () => {
    const converted = gemini.convertJsonSchema({
        type: 'object',
        properties: {
            status: { type: ['string', 'null'] },
            item: { $ref: '#/$defs/Item' },
            kind: { type: 'string', const: 'fixed' },
            note: { type: 'string', additionalProperties: false },
        },
        required: ['status', 'item', 'missing'],
        additionalProperties: false,
        $defs: {
            Item: {
                type: 'object',
                properties: { id: { type: 'integer' } },
                required: ['id'],
                additionalProperties: false,
            },
        },
    });

    assert.deepEqual(converted, {
        type: 'OBJECT',
        properties: {
            status: { type: 'STRING', nullable: true },
            item: {
                type: 'OBJECT',
                properties: { id: { type: 'INTEGER' } },
                required: ['id'],
            },
            kind: { type: 'STRING', enum: ['fixed'] },
            note: { type: 'STRING' },
        },
        required: ['status', 'item'],
    });

    assert.equal(gemini.convertJsonSchema({}), null);
});

testCase('Gemini 伪流式 tools：输出 delta.tool_calls 与 finish_reason=tool_calls', async () => {
    geminiResponder = () => ({
        status: 200,
        body: {
            candidates: [{
                content: {
                    role: 'model',
                    parts: [
                        { text: 'checking' },
                        {
                            functionCall: { name: 'lookup', args: { q: 'x' }, id: 'call_x' },
                            thoughtSignature: 'sig-stream',
                        },
                    ],
                },
                finishReason: 'STOP',
            }],
        },
    });

    const response = await postChat({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'find' }],
        stream: true,
    });

    assert.equal(response.status, 200);

    const events = parseSSEEvents(await response.text());
    assert.equal(events.at(-1), '[DONE]');

    const chunks = events.slice(0, -1).map((event) => JSON.parse(event));
    const toolChunk = chunks.find((chunk) => chunk.choices?.[0]?.delta?.tool_calls);

    assert.ok(toolChunk);
    assert.deepEqual(toolChunk.choices[0].delta.tool_calls, [{
        index: 0,
        id: 'call_x',
        type: 'function',
        function: {
            name: 'lookup',
            arguments: '{"q":"x"}',
        },
        extra_content: {
            google: { thought_signature: 'sig-stream' },
        },
    }]);
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
});

testCase('Gemini 鉴权：x-goog-api-key 与 Authorization 都会被接受', async () => {
    geminiResponder = () => ({
        status: 200,
        body: {
            candidates: [{
                content: { role: 'model', parts: [{ text: 'ok' }] },
                finishReason: 'STOP',
            }],
        },
    });

    const body = {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
    };

    const googleHeaderResponse = await postChat(body, {
        'x-goog-api-key': 'client-google-key',
    });
    assert.equal(googleHeaderResponse.status, 200);
    assert.equal(geminiRequests[0].headers['x-goog-api-key'], 'client-google-key');

    geminiRequests.length = 0;

    const bearerResponse = await postChat(body, {
        Authorization: 'Bearer client-bearer-key',
    });
    assert.equal(bearerResponse.status, 200);
    assert.equal(geminiRequests[0].headers['x-goog-api-key'], 'client-bearer-key');
});

testCase('Gemini 请求转换：reasoning_effort、音频与文件片段', () => {
    const audioBase64 = Buffer.from('audio-bytes').toString('base64');
    const pdfBase64 = Buffer.from('%PDF-1.4').toString('base64');

    const converted = gemini.buildGenerateContentRequest({
        model: 'gemini-3-pro',
        reasoning_effort: 'high',
        messages: [{
            role: 'user',
            content: [
                {
                    type: 'input_audio',
                    input_audio: { data: audioBase64, format: 'mp3' },
                },
                {
                    type: 'file',
                    file: {
                        filename: 'doc.pdf',
                        file_data: `data:application/pdf;base64,${pdfBase64}`,
                    },
                },
            ],
        }],
    }, { model: 'gemini-3-pro' });

    assert.deepEqual(converted.request.generationConfig.thinkingConfig, {
        thinkingLevel: 'HIGH',
    });

    assert.deepEqual(converted.request.contents[0].parts, [
        { inlineData: { mimeType: 'audio/mpeg', data: audioBase64 } },
        { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } },
    ]);

    const legacy = gemini.buildGenerateContentRequest({
        model: 'gemini-2.5-flash',
        reasoning_effort: 'high',
        messages: [{ role: 'user', content: 'hi' }],
    }, { model: 'gemini-2.5-flash' });

    assert.equal(legacy.request.generationConfig, undefined);
    assert.ok(legacy.warnings.some((warning) => warning.includes('reasoning_effort')));
});

testCase('/api/status 暴露上游格式与 Gemini 配置状态', async () => {
    const response = await fetch(`${proxyBase}/api/status`);
    assert.equal(response.status, 200);

    const payload = await response.json();
    assert.equal(payload.environment.upstream_format, 'gemini');
    assert.equal(payload.environment.has_gemini_api_key, true);
    assert.equal(payload.environment.gemini_api_version, 'v1beta');
    assert.equal(payload.features.gemini_format, true);
    assert.equal(payload.features.auto_upstream_format, true);
});

testCase('模型名判断与 URL 构造', () => {
    assert.equal(gemini.isGeminiModel('gemini-2.5-flash'), true);
    assert.equal(gemini.isGeminiModel('models/gemini-2.5-pro'), true);
    assert.equal(gemini.isGeminiModel('gemma-3-27b-it'), true);
    assert.equal(gemini.isGeminiModel('gpt-4o-mini'), false);
    assert.equal(gemini.isGeminiModel('claude-3-5-sonnet'), false);

    const config = {
        GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com/',
        GEMINI_API_VERSION: 'v1beta',
    };

    assert.equal(
        gemini.buildGenerateContentUrl(config, 'gemini-2.5-flash'),
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
    assert.equal(
        gemini.buildGenerateContentUrl(config, 'models/gemini-2.5-pro'),
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
    );
    assert.equal(
        gemini.buildGenerateContentUrl({
            GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta',
            GEMINI_API_VERSION: 'v1beta',
        }, 'gemini-2.5-flash'),
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
});
