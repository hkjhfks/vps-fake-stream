'use strict';

/**
 * Gemini（Google Generative Language API）适配层。
 *
 * 对外仍然是 OpenAI 风格：调用方发送 /v1/chat/completions 请求，
 * 这里负责把 OpenAI 请求转换成 Gemini generateContent 请求，再把 Gemini
 * 的响应转换回 OpenAI Chat Completions 形状。上游固定使用非流式调用，
 * 伪流式由 api/chat.js 负责。
 */

const axios = require('axios');
const { randomUUID } = require('crypto');
const { upstreamAgentOptions } = require('./upstream-http');

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_API_VERSION = 'v1beta';

const MAX_SCHEMA_DEPTH = 12;
const MAX_TOOL_NAME_LENGTH = 64;
const MAX_STOP_SEQUENCES = 5;
const MAX_MODEL_PAGES = 10;
const MODEL_LIST_TIMEOUT_MS = 20000;

const FINISH_REASON_MAP = Object.freeze({
    STOP: 'stop',
    MAX_TOKENS: 'length',
    SAFETY: 'content_filter',
    RECITATION: 'content_filter',
    BLOCKLIST: 'content_filter',
    PROHIBITED_CONTENT: 'content_filter',
    SPII: 'content_filter',
    IMAGE_SAFETY: 'content_filter',
    IMAGE_PROHIBITED_CONTENT: 'content_filter',
    IMAGE_RECITATION: 'content_filter',
    LANGUAGE: 'content_filter',
    PUP_LIMITED_DISABLED: 'content_filter',
    ESCALATION: 'content_filter',
    MALFORMED_FUNCTION_CALL: 'stop',
    UNEXPECTED_TOOL_CALL: 'stop',
    TOO_MANY_TOOL_CALLS: 'stop',
    MISSING_THOUGHT_SIGNATURE: 'stop',
    MALFORMED_RESPONSE: 'stop',
    CONTINUATION: 'length',
    OTHER: 'stop',
    FINISH_REASON_UNSPECIFIED: 'stop',
});

const SCHEMA_TYPE_MAP = Object.freeze({
    string: 'STRING',
    number: 'NUMBER',
    integer: 'INTEGER',
    boolean: 'BOOLEAN',
    array: 'ARRAY',
    object: 'OBJECT',
});

const SCHEMA_FORMATS = new Set(['enum', 'date-time', 'int32', 'int64', 'float', 'double', 'byte']);

const AUDIO_MIME_TYPES = Object.freeze({
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    mpeg: 'audio/mpeg',
    mpga: 'audio/mpeg',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/opus',
    flac: 'audio/flac',
    webm: 'audio/webm',
    m4a: 'audio/mp4',
    mp4: 'audio/mp4',
    aac: 'audio/aac',
});

const MIME_BY_EXTENSION = Object.freeze({
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    xml: 'application/xml',
    html: 'text/html',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    opus: 'audio/opus',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mpeg: 'video/mpeg',
    mpg: 'video/mpeg',
    avi: 'video/x-msvideo',
});

const EFFORT_TO_THINKING_LEVEL = Object.freeze({
    none: 'MINIMAL',
    minimal: 'MINIMAL',
    low: 'LOW',
    medium: 'MEDIUM',
    high: 'HIGH',
    xhigh: 'HIGH',
    max: 'HIGH',
});

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toFiniteNumber(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function toNullableInt(value) {
    const parsed = toFiniteNumber(value);
    return parsed === null ? null : Math.max(0, Math.round(parsed));
}

function isGeminiModel(model) {
    const raw = typeof model === 'string' ? model.trim() : '';
    if (!raw) return false;
    if (/^(models|tunedModels)\//i.test(raw)) return true;
    return /^(gemini|gemma)/i.test(raw);
}

function isGemini3Model(model) {
    const raw = typeof model === 'string' ? model.trim().replace(/^models\//i, '') : '';
    return /^gemini-3(?:[.\-]|$)/i.test(raw);
}

function buildApiRoot(configValue = {}) {
    const rawBase = typeof configValue.GEMINI_BASE_URL === 'string' && configValue.GEMINI_BASE_URL.trim()
        ? configValue.GEMINI_BASE_URL.trim()
        : DEFAULT_BASE_URL;
    const base = rawBase.replace(/\/+$/, '');

    const rawVersion = typeof configValue.GEMINI_API_VERSION === 'string' && configValue.GEMINI_API_VERSION.trim()
        ? configValue.GEMINI_API_VERSION.trim().replace(/^\/+|\/+$/g, '')
        : DEFAULT_API_VERSION;
    const version = /^[A-Za-z0-9._-]+$/.test(rawVersion) ? rawVersion : DEFAULT_API_VERSION;

    const suffix = `/${version}`;
    return base.endsWith(suffix) ? base : `${base}${suffix}`;
}

function toModelPath(model) {
    const raw = typeof model === 'string' ? model.trim() : '';
    if (!raw) throw new Error('model is required');

    if (/^(models|tunedModels)\//i.test(raw)) {
        return raw.split('/').map((segment) => encodeURIComponent(segment)).join('/');
    }

    return `models/${encodeURIComponent(raw)}`;
}

function buildGenerateContentUrl(configValue, model) {
    return `${buildApiRoot(configValue)}/${toModelPath(model)}:generateContent`;
}

function buildListModelsUrl(configValue, query = '') {
    return `${buildApiRoot(configValue)}/models${query ? `?${query}` : ''}`;
}

function buildHeaders(apiKey, extraHeaders = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['x-goog-api-key'] = apiKey;
    if (isPlainObject(extraHeaders)) Object.assign(headers, extraHeaders);
    return headers;
}

function sniffMimeType(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) return '';

    if (buffer.length >= 8
        && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return 'image/png';
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'image/jpeg';
    }

    const head6 = buffer.subarray(0, Math.min(6, buffer.length)).toString('latin1');
    if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';

    if (buffer.length >= 12
        && buffer.subarray(0, 4).toString('latin1') === 'RIFF'
        && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
        return 'image/webp';
    }
    if (buffer.length >= 12
        && buffer.subarray(0, 4).toString('latin1') === 'RIFF'
        && buffer.subarray(8, 12).toString('latin1') === 'WAVE') {
        return 'audio/wav';
    }
    if (buffer.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
    if (buffer.subarray(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg';
    if (buffer.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
    if (buffer.subarray(0, 4).toString('latin1') === 'fLaC') return 'audio/flac';

    return '';
}

function decodeBase64Strict(value) {
    const compact = String(value || '').replace(/\s+/g, '');
    if (!compact) throw new Error('base64 内容为空');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
        throw new Error('base64 内容格式无效');
    }
    return Buffer.from(compact, 'base64');
}

function parseDataUrl(value) {
    if (typeof value !== 'string') return null;

    const match = /^data:([^;,]*)((?:;[^,]*)*),(.*)$/s.exec(value);
    if (!match) return null;

    const mimeTypeRaw = (match[1] || '').trim().toLowerCase();
    const params = match[2] || '';
    const payload = match[3] || '';
    const isBase64 = /(?:^|;)base64(?:;|$)/i.test(params);

    let buffer;
    if (isBase64) {
        buffer = decodeBase64Strict(payload);
    } else {
        let decoded;
        try {
            decoded = decodeURIComponent(payload);
        } catch (error) {
            throw new Error('data URL 编码无效');
        }
        buffer = Buffer.from(decoded, 'utf8');
    }

    if (!buffer.length) throw new Error('data URL 内容为空');

    return {
        mimeType: mimeTypeRaw || sniffMimeType(buffer) || 'application/octet-stream',
        data: buffer.toString('base64'),
    };
}

function guessMimeFromFilename(filename) {
    if (typeof filename !== 'string') return '';
    const match = /\.([A-Za-z0-9]+)$/.exec(filename.trim());
    if (!match) return '';
    return MIME_BY_EXTENSION[match[1].toLowerCase()] || '';
}

function buildImagePart(imageUrl) {
    const url = typeof imageUrl === 'string'
        ? imageUrl
        : (isPlainObject(imageUrl) && typeof imageUrl.url === 'string' ? imageUrl.url : '');

    if (!url) throw new Error('image_url.url is required');

    if (url.startsWith('data:')) {
        const parsed = parseDataUrl(url);
        if (!parsed) throw new Error('图片 data URL 格式无效');
        return { inlineData: parsed };
    }

    if (/^https?:\/\//i.test(url)) {
        let host = '';
        try { host = new URL(url).host; } catch (error) { /* ignore */ }
        throw new Error(
            `Gemini 上游不支持远程图片 URL${host ? `（${host}）` : ''}，`
            + '请改用 data: URL 内联图片，或先通过 Gemini File API 上传后使用 fileData',
        );
    }

    throw new Error('不支持的 image_url：仅支持 data: URL 内联图片');
}

function buildAudioPart(inputAudio) {
    if (!isPlainObject(inputAudio)) throw new Error('input_audio 必须是对象');

    const data = typeof inputAudio.data === 'string' ? inputAudio.data.trim() : '';
    if (!data) throw new Error('input_audio.data is required');

    if (data.startsWith('data:')) {
        const parsed = parseDataUrl(data);
        if (!parsed) throw new Error('音频 data URL 格式无效');
        return { inlineData: parsed };
    }

    const buffer = decodeBase64Strict(data);
    const format = typeof inputAudio.format === 'string' ? inputAudio.format.trim().toLowerCase() : '';
    const mimeType = AUDIO_MIME_TYPES[format] || sniffMimeType(buffer) || 'audio/wav';

    return { inlineData: { mimeType, data: buffer.toString('base64') } };
}

function buildFilePart(file) {
    if (!isPlainObject(file)) throw new Error('file 必须是对象');

    if (typeof file.file_data === 'string' && file.file_data.trim()) {
        const raw = file.file_data.trim();

        if (raw.startsWith('data:')) {
            const parsed = parseDataUrl(raw);
            if (!parsed) throw new Error('file_data data URL 格式无效');
            return { inlineData: parsed };
        }

        const buffer = decodeBase64Strict(raw);
        const mimeType = guessMimeFromFilename(file.filename) || sniffMimeType(buffer) || 'application/octet-stream';
        return { inlineData: { mimeType, data: buffer.toString('base64') } };
    }

    if (typeof file.file_id === 'string' && file.file_id.trim()) {
        throw new Error('Gemini 上游不支持 OpenAI 的 file_id，请改用内联 file_data（data: URL）');
    }

    throw new Error('file.file_data is required');
}

function buildBase64SourcePart(source) {
    if (!isPlainObject(source)) return null;
    if (source.type !== 'base64' || typeof source.data !== 'string' || !source.data.trim()) return null;

    const buffer = decodeBase64Strict(source.data);
    const mimeType = typeof source.media_type === 'string' && source.media_type.trim()
        ? source.media_type.trim().toLowerCase()
        : (sniffMimeType(buffer) || 'application/octet-stream');

    return { inlineData: { mimeType, data: buffer.toString('base64') } };
}

function buildPartsFromContent(content, warnings, label = 'message') {
    if (content === undefined || content === null) return [];

    if (typeof content === 'string') {
        return content.length ? [{ text: content }] : [];
    }

    if (!Array.isArray(content)) {
        if (isPlainObject(content) && typeof content.text === 'string') {
            return content.text.length ? [{ text: content.text }] : [];
        }
        throw new Error(`${label} 的 content 必须是字符串或内容数组`);
    }

    const parts = [];

    for (const rawPart of content) {
        if (typeof rawPart === 'string') {
            if (rawPart) parts.push({ text: rawPart });
            continue;
        }

        if (!isPlainObject(rawPart)) {
            warnings.push(`${label}: 忽略非对象内容片段`);
            continue;
        }

        const type = typeof rawPart.type === 'string' ? rawPart.type.toLowerCase() : '';

        if (type === 'text' || type === 'input_text' || (!type && typeof rawPart.text === 'string')) {
            if (typeof rawPart.text === 'string' && rawPart.text.length) {
                parts.push({ text: rawPart.text });
            }
            continue;
        }

        if (type === 'image_url' || type === 'input_image' || type === 'image') {
            const imageUrl = rawPart.image_url
                ?? rawPart.image
                ?? (typeof rawPart.url === 'string' ? rawPart.url : null);
            const imageSource = rawPart.source
                ?? (isPlainObject(imageUrl) ? imageUrl.source : null);

            const hasImageUrl = typeof imageUrl === 'string'
                ? !!imageUrl
                : (isPlainObject(imageUrl) && typeof imageUrl.url === 'string' && !!imageUrl.url);

            if (hasImageUrl) {
                parts.push(buildImagePart(imageUrl));
                continue;
            }

            const sourcePart = buildBase64SourcePart(imageSource);
            if (sourcePart) {
                parts.push(sourcePart);
                continue;
            }

            throw new Error(`${label}: image 片段缺少 image_url 或 base64 source`);
        }

        if (type === 'input_audio' || type === 'audio') {
            parts.push(buildAudioPart(rawPart.input_audio ?? rawPart.audio ?? rawPart));
            continue;
        }

        if (type === 'file') {
            parts.push(buildFilePart(rawPart.file ?? rawPart));
            continue;
        }

        if (type === 'document' || type === 'image_base64') {
            const sourcePart = buildBase64SourcePart(rawPart.source);
            if (sourcePart) {
                parts.push(sourcePart);
                continue;
            }
            throw new Error(`${label}: ${type} 片段只支持 base64 source`);
        }

        warnings.push(`${label}: 忽略不支持的内容片段类型 ${type || 'unknown'}`);
    }

    return parts;
}

function normalizeRole(role) {
    const raw = typeof role === 'string' ? role.trim().toLowerCase() : '';
    if (!raw) return 'user';
    if (raw === 'system' || raw === 'developer') return 'system';
    if (raw === 'assistant' || raw === 'model' || raw === 'ai' || raw === 'bot') return 'assistant';
    if (raw === 'tool' || raw === 'function') return 'tool';
    if (raw === 'user' || raw === 'human') return 'user';
    throw new Error(`不支持的 messages.role：${role}`);
}

function pushContent(contents, role, parts) {
    if (!parts.length) return;

    const last = contents[contents.length - 1];
    if (last && last.role === role) {
        last.parts.push(...parts);
        return;
    }

    contents.push({ role, parts: [...parts] });
}

function extractSystemText(content, warnings) {
    if (typeof content === 'string') return content;

    if (Array.isArray(content)) {
        const texts = [];
        for (const part of content) {
            if (typeof part === 'string') {
                texts.push(part);
            } else if (isPlainObject(part) && typeof part.text === 'string') {
                texts.push(part.text);
            } else {
                warnings.push('system message: 忽略非文本内容');
            }
        }
        return texts.join('\n');
    }

    if (isPlainObject(content) && typeof content.text === 'string') return content.text;
    return '';
}

function normalizeArguments(args) {
    if (args === undefined || args === null || args === '') return {};

    if (isPlainObject(args)) return args;

    if (typeof args === 'string') {
        try {
            const parsed = JSON.parse(args);
            return isPlainObject(parsed) ? parsed : { value: parsed };
        } catch (error) {
            return { _raw: args };
        }
    }

    if (Array.isArray(args)) return { items: args };
    return { value: args };
}

function normalizeToolResponse(content) {
    if (content === undefined || content === null) return {};

    if (typeof content === 'string') {
        const trimmed = content.trim();
        if (!trimmed) return {};
        try {
            const parsed = JSON.parse(trimmed);
            return isPlainObject(parsed) ? parsed : { result: parsed };
        } catch (error) {
            return { result: content };
        }
    }

    if (Array.isArray(content)) {
        const text = content.map((part) => {
            if (typeof part === 'string') return part;
            if (isPlainObject(part) && typeof part.text === 'string') return part.text;
            return '';
        }).join('');
        return normalizeToolResponse(text);
    }

    if (isPlainObject(content)) return content;
    return { result: content };
}

function collectToolNames(message, toolNamesById) {
    if (!Array.isArray(message.tool_calls)) return;

    for (const call of message.tool_calls) {
        if (!isPlainObject(call)) continue;
        const id = typeof call.id === 'string' ? call.id : '';
        const name = isPlainObject(call.function) && typeof call.function.name === 'string'
            ? call.function.name
            : '';
        if (id && name) toolNamesById.set(id, name);
    }
}

function extractThoughtSignature(toolCall) {
    if (!isPlainObject(toolCall)) return '';

    const candidates = [
        toolCall?.extra_content?.google?.thought_signature,
        toolCall?.extraContent?.google?.thoughtSignature,
        toolCall?.gemini_thought_signature,
        toolCall?.thought_signature,
        toolCall?.thoughtSignature,
        toolCall?.function?.thought_signature,
        toolCall?.function?.thoughtSignature,
    ];

    for (const value of candidates) {
        if (typeof value === 'string' && value) return value;
    }

    return '';
}

function buildAssistantToolParts(message) {
    const parts = [];

    if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
            if (!isPlainObject(call) || !isPlainObject(call.function)) continue;

            const name = typeof call.function.name === 'string' ? call.function.name.trim() : '';
            if (!name) continue;

            const functionCall = {
                name,
                args: normalizeArguments(call.function.arguments),
            };
            if (typeof call.id === 'string' && call.id) functionCall.id = call.id;

            const part = { functionCall };
            const thoughtSignature = extractThoughtSignature(call);
            if (thoughtSignature) part.thoughtSignature = thoughtSignature;

            parts.push(part);
        }
    }

    if (isPlainObject(message.function_call) && typeof message.function_call.name === 'string') {
        const name = message.function_call.name.trim();
        if (name) {
            const functionCall = {
                name,
                args: normalizeArguments(message.function_call.arguments),
            };

            const part = { functionCall };
            const thoughtSignature = extractThoughtSignature(message.function_call);
            if (thoughtSignature) part.thoughtSignature = thoughtSignature;

            parts.push(part);
        }
    }

    return parts;
}

function buildToolResponsePart(message, toolNamesById) {
    const isLegacyFunction = normalizeRole(message.role) === 'function';
    const id = typeof message.tool_call_id === 'string' ? message.tool_call_id.trim() : '';
    const explicitName = typeof message.name === 'string' ? message.name.trim() : '';
    const name = explicitName || (isLegacyFunction ? '' : toolNamesById.get(id) || '');

    if (!name) {
        if (isLegacyFunction) {
            throw new Error('role=function 的消息必须提供 name');
        }
        throw new Error(
            `无法为 tool 消息解析函数名${id ? `（tool_call_id: ${id}）` : ''}，`
            + '请在历史中保留对应的 assistant.tool_calls，或显式传入 name',
        );
    }

    const functionResponse = {
        name,
        response: normalizeToolResponse(message.content),
    };
    if (id) functionResponse.id = id;

    return { functionResponse };
}

function resolveJsonPointer(ref, root) {
    if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;

    const segments = ref.slice(2).split('/').map((segment) => (
        segment.replace(/~1/g, '/').replace(/~0/g, '~')
    ));

    let current = root;
    for (const segment of segments) {
        if (!current || typeof current !== 'object') return null;
        current = current[segment];
    }

    return current;
}

function mergeSchemas(base, extra) {
    if (!extra) return base;
    if (!base) return extra;

    const merged = { ...base };

    for (const [key, value] of Object.entries(extra)) {
        if (key === 'properties' && isPlainObject(value) && isPlainObject(merged.properties)) {
            merged.properties = { ...merged.properties, ...value };
        } else if (key === 'required' && Array.isArray(value)) {
            merged.required = [...new Set([...(merged.required || []), ...value])];
        } else if (merged[key] === undefined) {
            merged[key] = value;
        }
    }

    return merged;
}

function convertSchemaNode(node, root, refStack, depth) {
    if (!isPlainObject(node)) return null;
    if (depth > MAX_SCHEMA_DEPTH) return {};

    if (typeof node.$ref === 'string') {
        if (refStack.includes(node.$ref)) return {};

        const target = resolveJsonPointer(node.$ref, root);
        if (!target) return {};

        const resolved = convertSchemaNode(target, root, [...refStack, node.$ref], depth + 1);

        const siblings = { ...node };
        delete siblings.$ref;
        const siblingSchema = Object.keys(siblings).length
            ? convertSchemaNode(siblings, root, refStack, depth + 1)
            : null;

        return mergeSchemas(resolved || {}, siblingSchema);
    }

    const out = {};
    let nullable = node.nullable === true;

    let declaredType = node.type;
    if (Array.isArray(declaredType)) {
        const nonNullTypes = declaredType.filter((item) => String(item).toLowerCase() !== 'null');
        if (nonNullTypes.length !== declaredType.length) nullable = true;
        declaredType = nonNullTypes[0];
    }

    let enumValues = Array.isArray(node.enum) ? node.enum.slice() : null;
    if (node.const !== undefined) enumValues = [node.const];

    let type = typeof declaredType === 'string' ? declaredType.toLowerCase() : '';
    if (!type) {
        if (isPlainObject(node.properties) || node.additionalProperties !== undefined) {
            type = 'object';
        } else if (node.items !== undefined) {
            type = 'array';
        } else if (enumValues && enumValues.every((value) => typeof value === 'string')) {
            type = 'string';
        }
    }

    if (type === 'null') {
        nullable = true;
    } else if (SCHEMA_TYPE_MAP[type]) {
        out.type = SCHEMA_TYPE_MAP[type];
    }

    for (const key of ['title', 'description', 'pattern']) {
        if (typeof node[key] === 'string' && node[key]) out[key] = node[key];
    }

    if (typeof node.format === 'string' && SCHEMA_FORMATS.has(node.format)) {
        out.format = node.format;
    }

    for (const key of ['minimum', 'maximum']) {
        const value = toFiniteNumber(node[key]);
        if (value !== null) out[key] = value;
    }

    for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) {
        const value = toFiniteNumber(node[key]);
        if (value !== null && value >= 0) out[key] = String(Math.round(value));
    }

    if (enumValues && enumValues.length) {
        const stringValues = enumValues.filter((value) => typeof value === 'string');
        if (stringValues.length === enumValues.length) {
            out.enum = stringValues;
        } else if (enumValues.some((value) => value === null)) {
            nullable = true;
        }
    }

    if (node.default !== undefined) out.default = node.default;
    if (node.example !== undefined) out.example = node.example;

    if (Array.isArray(node.propertyOrdering)) {
        const ordering = node.propertyOrdering.filter((value) => typeof value === 'string');
        if (ordering.length) out.propertyOrdering = ordering;
    }

    const properties = {};
    if (isPlainObject(node.properties)) {
        for (const [name, subSchema] of Object.entries(node.properties)) {
            const converted = convertSchemaNode(subSchema, root, refStack, depth + 1);
            if (converted) properties[name] = converted;
        }
        if (Object.keys(properties).length) out.properties = properties;
    }

    if (Array.isArray(node.required)) {
        const required = node.required.filter((name) => (
            typeof name === 'string' && Object.prototype.hasOwnProperty.call(properties, name)
        ));
        if (required.length) out.required = required;
    }

    if (node.items !== undefined) {
        const itemSchema = Array.isArray(node.items) ? node.items[0] : node.items;
        const converted = convertSchemaNode(itemSchema, root, refStack, depth + 1);
        if (converted) out.items = converted;
    }

    const alternatives = [];
    for (const key of ['anyOf', 'oneOf']) {
        if (Array.isArray(node[key])) alternatives.push(...node[key]);
    }

    if (alternatives.length) {
        const convertedAlternatives = [];

        for (const alternative of alternatives) {
            if (isPlainObject(alternative) && String(alternative.type).toLowerCase() === 'null') {
                nullable = true;
                continue;
            }

            const converted = convertSchemaNode(alternative, root, refStack, depth + 1);
            if (converted && Object.keys(converted).length) convertedAlternatives.push(converted);
        }

        if (convertedAlternatives.length === 1) {
            for (const [key, value] of Object.entries(convertedAlternatives[0])) {
                if (out[key] === undefined) out[key] = value;
            }
        } else if (convertedAlternatives.length > 1) {
            out.anyOf = convertedAlternatives;
        }
    }

    if (Array.isArray(node.allOf)) {
        for (const subSchema of node.allOf) {
            const converted = convertSchemaNode(subSchema, root, refStack, depth + 1);
            if (!converted) continue;

            if (isPlainObject(converted.properties)) {
                out.properties = { ...(out.properties || {}), ...converted.properties };
            }
            if (Array.isArray(converted.required)) {
                out.required = [...new Set([...(out.required || []), ...converted.required])];
            }

            for (const [key, value] of Object.entries(converted)) {
                if (key === 'properties' || key === 'required') continue;
                if (out[key] === undefined) out[key] = value;
            }
        }
    }

    if (nullable) out.nullable = true;

    if (!out.type && !out.anyOf) return null;

    return out;
}

function convertJsonSchema(schema) {
    if (!isPlainObject(schema)) return null;

    const converted = convertSchemaNode(schema, schema, [], 0);
    return converted && Object.keys(converted).length ? converted : null;
}

function buildToolDeclarations(tools, functions, warnings) {
    const declarations = [];
    const seenNames = new Set();

    const addDeclaration = (rawFunction, sourceLabel) => {
        if (!isPlainObject(rawFunction)) return;

        const name = typeof rawFunction.name === 'string' ? rawFunction.name.trim() : '';
        if (!name) {
            warnings.push(`${sourceLabel}: 忽略缺少 name 的函数`);
            return;
        }

        if (name.length > MAX_TOOL_NAME_LENGTH || !/^[A-Za-z0-9_.:-]+$/.test(name)) {
            throw new Error(
                `函数名 ${name} 不符合 Gemini 命名要求`
                + `（仅允许字母、数字、下划线、点、冒号、连字符，最长 ${MAX_TOOL_NAME_LENGTH} 字符）`,
            );
        }

        if (seenNames.has(name)) {
            warnings.push(`重复的函数声明 ${name} 已跳过`);
            return;
        }
        seenNames.add(name);

        const declaration = { name };
        const description = typeof rawFunction.description === 'string' && rawFunction.description.trim()
            ? rawFunction.description.trim()
            : '';
        declaration.description = description || name;

        const parameters = rawFunction.parameters
            ?? rawFunction.parametersJsonSchema
            ?? rawFunction.parameters_json_schema;
        const convertedParameters = convertJsonSchema(parameters);
        if (convertedParameters) declaration.parameters = convertedParameters;

        declarations.push(declaration);
    };

    if (Array.isArray(tools)) {
        for (const tool of tools) {
            if (!isPlainObject(tool)) {
                warnings.push('忽略非对象 tool');
                continue;
            }

            if (tool.type && tool.type !== 'function') {
                warnings.push(`忽略不支持的 tool.type：${tool.type}`);
                continue;
            }

            addDeclaration(tool.function || tool, 'tools');
        }
    }

    if (Array.isArray(functions)) {
        for (const fn of functions) addDeclaration(fn, 'functions');
    }

    return declarations.length ? [{ functionDeclarations: declarations }] : null;
}

function buildToolConfig(toolChoice, legacyFunctionCall) {
    const choice = toolChoice !== undefined ? toolChoice : legacyFunctionCall;
    if (choice === undefined || choice === null) return null;

    if (typeof choice === 'string') {
        const mode = choice.trim().toLowerCase();
        if (mode === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
        if (mode === 'none') return { functionCallingConfig: { mode: 'NONE' } };
        if (mode === 'required' || mode === 'any') return { functionCallingConfig: { mode: 'ANY' } };
        return null;
    }

    if (isPlainObject(choice)) {
        const name = isPlainObject(choice.function) && typeof choice.function.name === 'string'
            ? choice.function.name.trim()
            : (typeof choice.name === 'string' ? choice.name.trim() : '');
        if (name) {
            return {
                functionCallingConfig: {
                    mode: 'ANY',
                    allowedFunctionNames: [name],
                },
            };
        }
    }

    return null;
}

function buildSafetySettings(body) {
    const raw = body.safety_settings !== undefined ? body.safety_settings : body.safetySettings;
    if (!Array.isArray(raw)) return null;

    const settings = [];
    for (const item of raw) {
        if (!isPlainObject(item)) continue;
        const category = typeof item.category === 'string' ? item.category.trim() : '';
        const threshold = typeof item.threshold === 'string' ? item.threshold.trim() : '';
        if (category && threshold) settings.push({ category, threshold });
    }

    return settings.length ? settings : null;
}

function buildGenerationConfig(body, { model, warnings }) {
    const config = {};
    const numberFields = [
        ['temperature', 'temperature'],
        ['top_p', 'topP'],
        ['topP', 'topP'],
        ['top_k', 'topK'],
        ['topK', 'topK'],
        ['presence_penalty', 'presencePenalty'],
        ['presencePenalty', 'presencePenalty'],
        ['frequency_penalty', 'frequencyPenalty'],
        ['frequencyPenalty', 'frequencyPenalty'],
        ['seed', 'seed'],
    ];

    for (const [sourceKey, targetKey] of numberFields) {
        const value = toFiniteNumber(body[sourceKey]);
        if (value !== null) config[targetKey] = value;
    }

    if (config.topK !== undefined) {
        config.topK = Math.round(config.topK);
        if (config.topK <= 0) delete config.topK;
    }
    if (config.seed !== undefined) {
        config.seed = Math.round(config.seed);
    }

    const maxTokens = toFiniteNumber(
        body.max_tokens ?? body.max_completion_tokens ?? body.maxOutputTokens,
    );
    if (maxTokens !== null && maxTokens > 0) {
        config.maxOutputTokens = Math.round(maxTokens);
    }

    const candidateCount = toFiniteNumber(body.n ?? body.candidateCount);
    if (candidateCount !== null && candidateCount > 1) {
        config.candidateCount = Math.min(8, Math.max(1, Math.round(candidateCount)));
    }

    if (body.stop !== undefined && body.stop !== null) {
        const stops = (Array.isArray(body.stop) ? body.stop : [body.stop])
            .filter((value) => typeof value === 'string' && value.length);

        if (stops.length > MAX_STOP_SEQUENCES) {
            warnings.push(`Gemini 最多支持 ${MAX_STOP_SEQUENCES} 个 stop 序列，多余的已截断`);
        }
        if (stops.length) config.stopSequences = stops.slice(0, MAX_STOP_SEQUENCES);
    }

    const responseFormat = body.response_format !== undefined ? body.response_format : body.responseFormat;
    if (isPlainObject(responseFormat)) {
        const type = typeof responseFormat.type === 'string' ? responseFormat.type.toLowerCase() : '';

        if (type === 'json_object') {
            config.responseMimeType = 'application/json';
        } else if (type === 'json_schema') {
            config.responseMimeType = 'application/json';

            const jsonSchema = responseFormat.json_schema ?? responseFormat.jsonSchema;
            const schema = isPlainObject(jsonSchema)
                ? (jsonSchema.schema ?? jsonSchema)
                : responseFormat.schema;
            const convertedSchema = convertJsonSchema(schema);

            if (convertedSchema) {
                config.responseSchema = convertedSchema;
            } else {
                warnings.push('response_format=json_schema 缺少可用的 schema，仅设置 responseMimeType');
            }
        } else if (type && type !== 'text') {
            warnings.push(`忽略不支持的 response_format.type：${type}`);
        }
    }

    const explicitThinking = body.thinkingConfig !== undefined
        ? body.thinkingConfig
        : body.thinking_config;

    if (isPlainObject(explicitThinking)) {
        const thinkingConfig = {};

        if (typeof explicitThinking.includeThoughts === 'boolean') {
            thinkingConfig.includeThoughts = explicitThinking.includeThoughts;
        } else if (typeof explicitThinking.include_thoughts === 'boolean') {
            thinkingConfig.includeThoughts = explicitThinking.include_thoughts;
        }

        const budget = toFiniteNumber(explicitThinking.thinkingBudget ?? explicitThinking.thinking_budget);
        if (budget !== null && budget >= 0) {
            thinkingConfig.thinkingBudget = Math.round(budget);
        }

        const level = String(
            explicitThinking.thinkingLevel ?? explicitThinking.thinking_level ?? '',
        ).trim().toUpperCase();
        if (['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].includes(level)) {
            thinkingConfig.thinkingLevel = level;
        }

        if (Object.keys(thinkingConfig).length) config.thinkingConfig = thinkingConfig;
    }

    const effort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort.trim().toLowerCase() : '';
    if (effort) {
        if (!isGemini3Model(model)) {
            warnings.push('reasoning_effort 仅在 Gemini 3 模型上映射为 thinkingLevel，当前模型已忽略');
        } else if (config.thinkingConfig && (config.thinkingConfig.thinkingLevel || config.thinkingConfig.thinkingBudget !== undefined)) {
            warnings.push('已显式提供 thinkingConfig，忽略 reasoning_effort');
        } else {
            const level = EFFORT_TO_THINKING_LEVEL[effort];
            if (level) {
                config.thinkingConfig = { ...(config.thinkingConfig || {}), thinkingLevel: level };
            } else {
                warnings.push(`忽略未知 reasoning_effort：${body.reasoning_effort}`);
            }
        }
    }

    return Object.keys(config).length ? config : null;
}

function buildGenerateContentRequest(body, { model } = {}) {
    if (!isPlainObject(body)) {
        throw new Error('Request body must be a JSON object');
    }

    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('messages is required and must be a non-empty array');
    }

    const warnings = [];
    const contents = [];
    const systemTexts = [];
    const toolNamesById = new Map();

    for (const message of messages) {
        if (!isPlainObject(message)) {
            warnings.push('忽略非对象 message');
            continue;
        }

        const role = normalizeRole(message.role);

        if (role === 'system') {
            const text = extractSystemText(message.content, warnings);
            if (text.trim()) systemTexts.push(text);
            else warnings.push('忽略空的 system message');
            continue;
        }

        if (role === 'tool') {
            pushContent(contents, 'user', [buildToolResponsePart(message, toolNamesById)]);
            continue;
        }

        if (role === 'assistant') {
            collectToolNames(message, toolNamesById);
        }

        const contentParts = buildPartsFromContent(
            message.content,
            warnings,
            `${role} message`,
        );
        const parts = role === 'assistant'
            ? [...contentParts, ...buildAssistantToolParts(message)]
            : contentParts;

        if (!parts.length) {
            warnings.push(`忽略空的 ${role} message`);
            continue;
        }

        pushContent(contents, role === 'assistant' ? 'model' : 'user', parts);
    }

    if (!contents.length) {
        throw new Error('messages 中至少需要一条 user 或 assistant 消息');
    }

    const request = { contents };

    if (systemTexts.length) {
        request.systemInstruction = {
            parts: systemTexts.map((text) => ({ text })),
        };
    }

    const generationConfig = buildGenerationConfig(body, { model, warnings });
    if (generationConfig) request.generationConfig = generationConfig;

    const tools = buildToolDeclarations(body.tools, body.functions, warnings);
    if (tools) {
        request.tools = tools;

        const toolConfig = buildToolConfig(body.tool_choice, body.function_call);
        if (toolConfig) request.toolConfig = toolConfig;
    }

    const safetySettings = buildSafetySettings(body);
    if (safetySettings) request.safetySettings = safetySettings;

    return { request, warnings };
}

function mapFinishReason(finishReason) {
    const key = typeof finishReason === 'string' ? finishReason.trim().toUpperCase() : '';
    return FINISH_REASON_MAP[key] || 'stop';
}

function stringifyFunctionArguments(args) {
    if (args === undefined || args === null) return '{}';
    if (typeof args === 'string') return args;

    try {
        return JSON.stringify(args);
    } catch (error) {
        return '{}';
    }
}

function parseCandidate(candidate, { includeThoughts = false } = {}) {
    const normalizedCandidate = isPlainObject(candidate) ? candidate : {};
    const parts = Array.isArray(normalizedCandidate.content?.parts)
        ? normalizedCandidate.content.parts
        : [];

    let text = '';
    const toolCalls = [];

    for (const part of parts) {
        if (!isPlainObject(part)) continue;
        if (part.thought === true && !includeThoughts) continue;

        if (typeof part.text === 'string' && part.text) {
            text += part.text;
        }

        const functionCall = isPlainObject(part.functionCall)
            ? part.functionCall
            : (isPlainObject(part.function_call) ? part.function_call : null);

        if (functionCall && typeof functionCall.name === 'string' && functionCall.name) {
            const toolCall = {
                id: typeof functionCall.id === 'string' && functionCall.id
                    ? functionCall.id
                    : `call_${randomUUID()}`,
                type: 'function',
                function: {
                    name: functionCall.name,
                    arguments: stringifyFunctionArguments(functionCall.args),
                },
            };

            // Gemini 3 要求多轮工具调用时回传 thoughtSignature，否则会 400。
            // 用 OpenRouter 约定的 extra_content.google.thought_signature 承载，
            // 客户端原样回传 tool_calls 即可。
            const thoughtSignature = [
                part.thoughtSignature,
                part.thought_signature,
                functionCall.thoughtSignature,
                functionCall.thought_signature,
            ].find((value) => typeof value === 'string' && value) || '';

            if (thoughtSignature) {
                toolCall.extra_content = {
                    google: { thought_signature: thoughtSignature },
                };
            }

            toolCalls.push(toolCall);
        }
    }

    const nativeFinishReason = typeof normalizedCandidate.finishReason === 'string'
        ? normalizedCandidate.finishReason
        : '';

    return {
        text,
        toolCalls,
        finishReason: toolCalls.length ? 'tool_calls' : mapFinishReason(nativeFinishReason),
        nativeFinishReason,
    };
}

function convertUsage(usageMetadata) {
    const metadata = isPlainObject(usageMetadata) ? usageMetadata : {};

    const promptTokens = toNullableInt(metadata.promptTokenCount);
    const candidateTokens = toNullableInt(metadata.candidatesTokenCount);
    const thoughtTokens = toNullableInt(metadata.thoughtsTokenCount);
    const cachedTokens = toNullableInt(metadata.cachedContentTokenCount);

    let totalTokens = toNullableInt(metadata.totalTokenCount);
    let completionTokens = null;

    if (promptTokens !== null && totalTokens !== null) {
        completionTokens = Math.max(0, totalTokens - promptTokens);
    } else if (candidateTokens !== null) {
        completionTokens = candidateTokens + (thoughtTokens || 0);
    }

    if (totalTokens === null && promptTokens !== null && completionTokens !== null) {
        totalTokens = promptTokens + completionTokens;
    }

    const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
    };

    if (thoughtTokens !== null && thoughtTokens > 0) {
        usage.completion_tokens_details = { reasoning_tokens: thoughtTokens };
    }
    if (cachedTokens !== null && cachedTokens > 0) {
        usage.prompt_tokens_details = { cached_tokens: cachedTokens };
    }

    return usage;
}

function convertResponse(data, { requestedModel, includeThoughts = false } = {}) {
    if (!isPlainObject(data)) {
        throw new Error('Gemini 上游返回了无效的响应体');
    }

    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    const choices = [];

    let firstText = '';
    let firstToolCalls = [];
    let firstFinishReason = 'stop';

    candidates.forEach((candidate, index) => {
        const parsed = parseCandidate(candidate, { includeThoughts });

        if (index === 0) {
            firstText = parsed.text;
            firstToolCalls = parsed.toolCalls;
            firstFinishReason = parsed.finishReason;
        }

        const message = {
            role: 'assistant',
            content: parsed.text || (parsed.toolCalls.length ? null : ''),
        };
        if (parsed.toolCalls.length) message.tool_calls = parsed.toolCalls;

        choices.push({
            index,
            message,
            finish_reason: parsed.finishReason,
        });
    });

    if (!choices.length) {
        const blockReason = typeof data.promptFeedback?.blockReason === 'string'
            ? data.promptFeedback.blockReason
            : '';

        firstText = '';
        firstToolCalls = [];
        firstFinishReason = blockReason ? 'content_filter' : 'stop';

        choices.push({
            index: 0,
            message: { role: 'assistant', content: '' },
            finish_reason: firstFinishReason,
        });
    }

    const model = typeof data.modelVersion === 'string' && data.modelVersion
        ? data.modelVersion
        : (requestedModel || 'gemini');

    const response = {
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices,
        usage: convertUsage(data.usageMetadata),
    };

    return {
        response,
        text: firstText,
        toolCalls: firstToolCalls,
        finishReason: firstFinishReason,
        usage: response.usage,
        model,
        blockReason: data.promptFeedback?.blockReason || null,
    };
}

function convertModelsResponse(data) {
    const list = isPlainObject(data) && Array.isArray(data.models) ? data.models : [];
    const models = [];
    const seen = new Set();

    for (const rawModel of list) {
        if (!isPlainObject(rawModel)) continue;

        const name = typeof rawModel.name === 'string' ? rawModel.name.trim() : '';
        if (!name) continue;

        let id = name;
        if (id.startsWith('models/')) id = id.slice('models/'.length);
        if (!id) continue;

        const methods = Array.isArray(rawModel.supportedGenerationMethods)
            ? rawModel.supportedGenerationMethods
            : null;
        if (methods && methods.length && !methods.includes('generateContent')) continue;

        if (seen.has(id)) continue;
        seen.add(id);

        const model = {
            id,
            object: 'model',
            owned_by: 'google',
        };

        if (typeof rawModel.displayName === 'string' && rawModel.displayName) {
            model.display_name = rawModel.displayName;
        }
        if (typeof rawModel.description === 'string' && rawModel.description) {
            model.description = rawModel.description;
        }

        const inputTokenLimit = toNullableInt(rawModel.inputTokenLimit);
        const outputTokenLimit = toNullableInt(rawModel.outputTokenLimit);
        if (inputTokenLimit !== null) model.input_token_limit = inputTokenLimit;
        if (outputTokenLimit !== null) model.output_token_limit = outputTokenLimit;

        models.push(model);
    }

    return models;
}

function mapErrorType(status, httpStatus) {
    const normalizedStatus = typeof status === 'string' ? status.trim().toUpperCase() : '';
    const byStatus = {
        INVALID_ARGUMENT: 'invalid_request_error',
        FAILED_PRECONDITION: 'invalid_request_error',
        OUT_OF_RANGE: 'invalid_request_error',
        UNAUTHENTICATED: 'authentication_error',
        PERMISSION_DENIED: 'permission_error',
        NOT_FOUND: 'not_found_error',
        RESOURCE_EXHAUSTED: 'rate_limit_error',
        DEADLINE_EXCEEDED: 'timeout_error',
        INTERNAL: 'server_error',
        UNAVAILABLE: 'server_error',
        CANCELLED: 'server_error',
        UNKNOWN: 'server_error',
    };

    if (byStatus[normalizedStatus]) return byStatus[normalizedStatus];

    const statusCode = toFiniteNumber(httpStatus);
    if (statusCode === 400 || statusCode === 422) return 'invalid_request_error';
    if (statusCode === 401) return 'authentication_error';
    if (statusCode === 403) return 'permission_error';
    if (statusCode === 404) return 'not_found_error';
    if (statusCode === 429) return 'rate_limit_error';
    if (statusCode === 408 || statusCode === 504) return 'timeout_error';

    return 'server_error';
}

function normalizeError(upstreamError, statusCode, fallbackMessage) {
    const raw = isPlainObject(upstreamError) ? upstreamError : {};
    const errorObject = isPlainObject(raw.error) ? raw.error : null;

    const message = (errorObject && typeof errorObject.message === 'string' && errorObject.message)
        || (typeof raw.error === 'string' && raw.error)
        || (typeof raw.message === 'string' && raw.message)
        || fallbackMessage
        || 'Gemini 上游请求失败';

    const type = mapErrorType(errorObject?.status, statusCode);
    const code = errorObject?.code !== undefined && errorObject?.code !== null
        ? errorObject.code
        : statusCode;

    const payload = {
        error: {
            message,
            type,
            code,
        },
    };

    if (errorObject && typeof errorObject.status === 'string' && errorObject.status) {
        payload.error.status = errorObject.status;
    }

    if (errorObject && Array.isArray(errorObject.details)) {
        payload.error.details = errorObject.details;
    }

    return payload;
}

async function listModels(configValue, apiKey, extraHeaders = {}) {
    const models = [];
    const seen = new Set();
    let pageToken = '';

    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
        const params = new URLSearchParams();
        params.set('pageSize', '1000');
        if (pageToken) params.set('pageToken', pageToken);

        const response = await axios.get(
            buildListModelsUrl(configValue, params.toString()),
            upstreamAgentOptions({
                headers: buildHeaders(apiKey, extraHeaders),
                timeout: MODEL_LIST_TIMEOUT_MS,
            }),
        );

        for (const model of convertModelsResponse(response.data)) {
            if (seen.has(model.id)) continue;
            seen.add(model.id);
            models.push(model);
        }

        pageToken = typeof response.data?.nextPageToken === 'string'
            ? response.data.nextPageToken
            : '';

        if (!pageToken) break;
    }

    return models;
}

module.exports = {
    DEFAULT_BASE_URL,
    DEFAULT_API_VERSION,
    isGeminiModel,
    isGemini3Model,
    buildApiRoot,
    buildGenerateContentUrl,
    buildListModelsUrl,
    buildHeaders,
    buildGenerateContentRequest,
    buildGenerationConfig,
    convertJsonSchema,
    convertResponse,
    convertModelsResponse,
    convertUsage,
    mapFinishReason,
    normalizeError,
    listModels,
    parseDataUrl,
    sniffMimeType,
};
