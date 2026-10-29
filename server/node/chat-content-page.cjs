'use strict';

const fs = require('node:fs');

const DEFAULT_CHAT_CONTENT_PAGE_SIZE = 200;
const MIN_CHAT_CONTENT_PAGE_SIZE = 10;
const MAX_CHAT_CONTENT_PAGE_SIZE = 500;

function normalizeInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function normalizeLimit(value) {
    return Math.min(
        MAX_CHAT_CONTENT_PAGE_SIZE,
        Math.max(MIN_CHAT_CONTENT_PAGE_SIZE, normalizeInteger(value, DEFAULT_CHAT_CONTENT_PAGE_SIZE)),
    );
}

function createChatContentPage(chat, requestedOffset, requestedLimit) {
    if (!chat || typeof chat !== 'object') throw new TypeError('Chat content is required');
    const messages = Array.isArray(chat.message) ? chat.message : [];
    const total = messages.length;
    const offset = Math.min(total, Math.max(0, normalizeInteger(requestedOffset, 0)));
    const limit = normalizeLimit(requestedLimit);
    const { message: _message, ...metadata } = chat;
    return {
        chat: metadata,
        messages: messages.slice(offset, offset + limit),
        offset,
        limit,
        total,
    };
}

const CHAT_PREVIEW_TEXT_LIMIT = 2000;
const JSONL_TAIL_WINDOW = 64 * 1024;

// Reads only the end of a JSONL file, growing the window until it holds the
// whole last record, so a preview never parses a long chat.
function readLastJsonlRecord(filePath) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    try {
        const size = fs.fstatSync(fd).size;
        let length = Math.min(size, JSONL_TAIL_WINDOW);
        while (length > 0) {
            const buffer = Buffer.alloc(length);
            fs.readSync(fd, buffer, 0, length, size - length);
            let end = buffer.length;
            while (end > 0 && (buffer[end - 1] === 10 || buffer[end - 1] === 13)) end--;
            if (end === 0 && length === size) return null;
            const start = end > 0 ? buffer.lastIndexOf(10, end - 1) + 1 : 0;
            if (end > 0 && (start > 0 || length === size)) {
                return JSON.parse(buffer.toString('utf8', start, end));
            }
            if (length === size) return null;
            length = Math.min(size, length * 4);
        }
        return null;
    } finally {
        fs.closeSync(fd);
    }
}

// The few fields the chat list hover card shows. Message text is capped so a
// huge HTML reply cannot bloat the response.
function createChatPreview(chat, lastMessage) {
    const message = lastMessage && typeof lastMessage === 'object' ? lastMessage : null;
    const data = typeof message?.data === 'string' ? message.data : '';
    return {
        id: typeof chat?.id === 'string' ? chat.id : null,
        bindedPersona: typeof chat?.bindedPersona === 'string' ? chat.bindedPersona : '',
        lastMessage: message ? {
            role: message.role === 'user' ? 'user' : 'char',
            data: data.length > CHAT_PREVIEW_TEXT_LIMIT ? data.slice(0, CHAT_PREVIEW_TEXT_LIMIT) : data,
            ...(typeof message.saying === 'string' ? { saying: message.saying } : {}),
            ...(typeof message.name === 'string' ? { name: message.name } : {}),
            ...(Number.isFinite(message.time) ? { time: message.time } : {}),
        } : null,
    };
}

module.exports = {
    CHAT_PREVIEW_TEXT_LIMIT,
    createChatPreview,
    readLastJsonlRecord,
    DEFAULT_CHAT_CONTENT_PAGE_SIZE,
    MIN_CHAT_CONTENT_PAGE_SIZE,
    MAX_CHAT_CONTENT_PAGE_SIZE,
    createChatContentPage,
};
