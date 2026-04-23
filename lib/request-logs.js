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

function getRecentRequestLogs(limit = 100) {
    ensureLogFile();

    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    const text = fs.readFileSync(LOG_PATH, 'utf8');
    const lines = text.split('\n').filter(Boolean);

    return lines
        .slice(-safeLimit)
        .reverse()
        .map(safeParseLine)
        .filter(Boolean);
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
    clearRequestLogs,
    getLogPath,
    trimLogs,
};
