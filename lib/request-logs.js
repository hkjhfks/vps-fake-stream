const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const LOG_DIR = path.join(process.cwd(), 'data');
const LOG_PATH = path.join(LOG_DIR, 'request-logs.jsonl');

let writeCount = 0;

function ensureLogFile() {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    if (!fs.existsSync(LOG_PATH)) {
        fs.writeFileSync(LOG_PATH, '', 'utf8');
    }
}

function safeParseLine(line) {
    try {
        return JSON.parse(line);
    } catch (error) {
        return null;
    }
}

function trimLogs(retention) {
    if (!Number.isFinite(retention) || retention <= 0) return;

    ensureLogFile();
    const text = fs.readFileSync(LOG_PATH, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    if (lines.length <= retention) return;

    const kept = lines.slice(-retention);
    fs.writeFileSync(LOG_PATH, `${kept.join('\n')}\n`, 'utf8');
}

function appendRequestLog(entry, retention = 2000) {
    ensureLogFile();

    const record = {
        id: entry.id || randomUUID(),
        created_at: entry.created_at || new Date().toISOString(),
        ...entry,
    };

    fs.appendFileSync(LOG_PATH, `${JSON.stringify(record)}\n`, 'utf8');

    writeCount += 1;
    if (writeCount % 50 === 0) {
        trimLogs(retention);
    }

    return record;
}

const PREVIEW_CHARS = 160;

function toolCallPreview(toolCalls) {
    if (!Array.isArray(toolCalls) || !toolCalls.length) return '';
    return toolCalls.map((call) => {
        const name = typeof call?.function?.name === 'string' ? call.function.name : 'function';
        const args = typeof call?.function?.arguments === 'string' ? call.function.arguments : '';
        return args ? `${name}(${args})` : name;
    }).join(' ');
}

/**
 * List rows never include the full output body: it is ~3/4 of the record size
 * and the table does not render it. The drawer fetches it on demand. Tool call
 * arguments are just as large, so they are stripped from list rows too.
 */
function toSummary(record) {
    if (!record || typeof record !== 'object') return record;
    const { output_text: outputText, tool_calls: toolCalls, ...rest } = record;
    const calls = Array.isArray(toolCalls) ? toolCalls : [];
    const preview = outputText ? String(outputText) : toolCallPreview(calls);
    return {
        ...rest,
        output_chars: Number(rest.output_chars) || (outputText ? String(outputText).length : 0),
        output_preview: preview.slice(0, PREVIEW_CHARS),
        has_output: Boolean(outputText) || calls.length > 0,
        tool_call_count: calls.length,
    };
}

function readLines() {
    ensureLogFile();
    return fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
}

function getRecentRequestLogs(limit = 100, options = {}) {
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    // Parse only the rows we are about to return.
    const records = readLines()
        .slice(-safeLimit)
        .reverse()
        .map(safeParseLine)
        .filter(Boolean);
    return options.full ? records : records.map(toSummary);
}

function getRequestLogById(id) {
    if (!id) return null;
    const lines = readLines();
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        // Cheap substring gate before paying for JSON.parse.
        if (!lines[i].includes(id)) continue;
        const record = safeParseLine(lines[i]);
        if (record && record.id === id) return record;
    }
    return null;
}

function clearRequestLogs() {
    ensureLogFile();
    fs.writeFileSync(LOG_PATH, '', 'utf8');
}

function getLogPath() {
    return LOG_PATH;
}

module.exports = {
    LOG_PATH,
    ensureLogFile,
    appendRequestLog,
    getRecentRequestLogs,
    getRequestLogById,
    clearRequestLogs,
    getLogPath,
    trimLogs,
};
