'use strict';
// Persona transfer bundle (transfer-sync, 0.9.91-ver1): one or more personas moved with the manual transfer screen
// (file, NAS, GitHub, Wi-Fi, USB, Quick Share). It travels as a ".risuplay" file so every existing transport carries it
// unchanged, but it is NOT a play set. Its ZIP layout follows the native archive rules every transport checks (Android
// PlaySetArchive: only `manifest.json`, `records/<sha256>.json` and `blobs/<sha256>` members, a blob named by its own SHA-256),
// and its manifest says `type: "risubard-personas"`. The receiver applies it on the client (same name -> update in place
// keeping the id, otherwise add), never through the play-set import.
const { createHash } = require('node:crypto');
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');

const MANIFEST = 'manifest.json';
const TYPE = 'risubard-personas';
const VERSION = 1;
const MAX_PERSONAS = 200;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024; // compressed file
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024; // all entries after unzip
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_NAME = 200;
const ENTRY = /^blobs\/[a-f0-9]{64}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const text = (value, max) => typeof value === 'string' && value.length <= max;
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** Throws when a manifest object is not a persona bundle this version understands; returns the personas. */
function validateManifest(manifest, entries) {
    if (!isObject(manifest) || manifest.type !== TYPE) throw new Error('페르소나 전송 파일이 아니에요.');
    if (manifest.version !== VERSION) throw new Error('이 앱이 읽을 수 없는 페르소나 전송 파일 판본이에요. 앱을 업데이트해 주세요.');
    const personas = manifest.personas;
    if (!Array.isArray(personas) || !personas.length || personas.length > MAX_PERSONAS) throw new Error(`페르소나는 1~${MAX_PERSONAS}개까지 보낼 수 있어요.`);
    const referenced = new Set();
    const ref = path => {
        if (typeof path !== 'string' || !ENTRY.test(path) || !entries.has(path)) throw new Error('페르소나 전송 파일의 그림이 빠져 있어요.');
        referenced.add(path);
    };
    for (const p of personas) {
        if (!isObject(p) || !text(p.name, MAX_NAME) || !p.name.trim() || typeof p.personaPrompt !== 'string') throw new Error('이름이나 설명이 없는 페르소나가 있어요.');
        if (p.note !== undefined && typeof p.note !== 'string') throw new Error('페르소나 메모 형식이 달라요.');
        if (p.largePortrait !== undefined && typeof p.largePortrait !== 'boolean') throw new Error('페르소나 그림 설정 형식이 달라요.');
        if (p.portraitPrompt !== undefined && !isObject(p.portraitPrompt)) throw new Error('페르소나 그림 프롬프트 형식이 달라요.');
        if (p.image !== undefined && p.image !== null) ref(p.image);
        if (p.embeddedModule !== undefined) {
            const m = p.embeddedModule;
            if (!isObject(m) || typeof m.id !== 'string' || typeof m.name !== 'string') throw new Error('페르소나에 붙은 모듈 형식이 달라요.');
            if (m.assets !== undefined) {
                if (!Array.isArray(m.assets)) throw new Error('페르소나 모듈 에셋 형식이 달라요.');
                for (const a of m.assets) if (!Array.isArray(a) || a.length !== 3 || !a.every(v => typeof v === 'string')) throw new Error('페르소나 모듈 에셋 형식이 달라요.');
            }
            for (const path of p.moduleAssets ?? []) ref(path);
            if (p.moduleIcon !== undefined && p.moduleIcon !== null) ref(p.moduleIcon);
        } else if (p.moduleAssets !== undefined || p.moduleIcon !== undefined) throw new Error('페르소나 모듈 에셋 형식이 달라요.');
    }
    return personas;
}

/** Parses and validates a bundle held in memory. Returns { manifest, personas, files } (files: entry path -> bytes). */
function readPersonaBundle(buffer) {
    if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) throw new Error('페르소나 전송 파일이 아니에요.');
    if (buffer.length > MAX_BUNDLE_BYTES) throw new Error('페르소나 전송 파일이 너무 커요.');
    let expanded = 0;
    const files = unzipSync(buffer, { filter: file => {
        expanded += file.originalSize;
        if (expanded > MAX_EXPANDED_BYTES) throw new Error('페르소나 전송 파일이 너무 커요.');
        return file.name === MANIFEST || ENTRY.test(file.name);
    } });
    const raw = files[MANIFEST];
    if (!raw) throw new Error('페르소나 전송 파일이 아니에요.');
    if (raw.length > MAX_MANIFEST_BYTES) throw new Error('페르소나 전송 파일의 목록이 너무 커요.');
    const manifest = JSON.parse(strFromU8(raw));
    const entries = new Map(Object.entries(files).filter(([name]) => name !== MANIFEST));
    for (const [name, bytes] of entries) if (name !== `blobs/${sha256(bytes)}`) throw new Error('페르소나 전송 파일의 그림이 손상됐어요.');
    const personas = validateManifest(manifest, entries);
    return { manifest, personas, files: entries };
}

/** True when the file is a ZIP whose manifest says it is a persona bundle (a play set's never does). Never throws for other files. */
function isPersonaBundle(buffer) {
    if (!buffer || buffer.length < 4 || buffer.length > MAX_BUNDLE_BYTES || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false;
    try {
        const raw = unzipSync(buffer, { filter: file => file.name === MANIFEST && file.originalSize <= MAX_MANIFEST_BYTES })[MANIFEST];
        return !!raw && JSON.parse(strFromU8(raw))?.type === TYPE;
    } catch { return false; }
}

/**
 * Builds a bundle from database personas. `readAsset(key)` resolves an asset key to bytes or null (missing).
 * Returns { bytes, names, excluded } — excluded lists what could not be carried (missing pictures/module files).
 */
async function buildPersonaBundle(personas, readAsset) {
    if (!Array.isArray(personas) || !personas.length || personas.length > MAX_PERSONAS) throw new Error(`페르소나는 1~${MAX_PERSONAS}개까지 보낼 수 있어요.`);
    const files = {}, excluded = [], out = [];
    let expanded = 0;
    // The same picture used twice is stored once (an archive member name may appear only once).
    const add = bytes => {
        const path = `blobs/${sha256(bytes)}`;
        if (files[path]) return path;
        expanded += bytes.length;
        if (expanded > MAX_EXPANDED_BYTES) throw new Error('보낼 페르소나 그림이 너무 커요. 개수를 나눠서 보내 주세요.');
        files[path] = bytes;
        return path;
    };
    for (const persona of personas) {
        if (!persona?.name?.trim() || typeof persona.personaPrompt !== 'string') throw new Error('이름이나 설명이 없는 페르소나는 보낼 수 없어요.');
        const row = { name: persona.name, personaPrompt: persona.personaPrompt };
        if (typeof persona.note === 'string') row.note = persona.note;
        if (typeof persona.largePortrait === 'boolean') row.largePortrait = persona.largePortrait;
        if (isObject(persona.portraitPrompt)) row.portraitPrompt = JSON.parse(JSON.stringify(persona.portraitPrompt));
        row.image = null;
        if (persona.icon) {
            const bytes = await readAsset(persona.icon);
            if (bytes) row.image = add(bytes);
            else excluded.push({ path: `페르소나 「${persona.name}」 그림`, reason: '이 기기에서 그림 파일을 찾지 못해 그림 없이 보내요.' });
        }
        if (isObject(persona.embeddedModule)) {
            const module = JSON.parse(JSON.stringify(persona.embeddedModule));
            row.moduleAssets = [];
            if (Array.isArray(module.assets)) {
                const kept = [];
                for (const [j, asset] of module.assets.entries()) {
                    const bytes = Array.isArray(asset) && typeof asset[1] === 'string' && asset[1] ? await readAsset(asset[1]) : null;
                    if (!bytes) { excluded.push({ path: `페르소나 「${persona.name}」 모듈 에셋 ${asset?.[0] ?? j}`, reason: '이 기기에서 파일을 찾지 못해 빼고 보내요.' }); continue; }
                    row.moduleAssets.push(add(bytes));
                    kept.push([String(asset[0] ?? ''), '', String(asset[2] ?? '')]);
                }
                module.assets = kept;
            }
            if (typeof module.icon === 'string' && module.icon) {
                const bytes = await readAsset(module.icon);
                if (bytes) row.moduleIcon = add(bytes);
                else excluded.push({ path: `페르소나 「${persona.name}」 모듈 아이콘`, reason: '이 기기에서 파일을 찾지 못해 빼고 보내요.' });
                delete module.icon;
            }
            row.embeddedModule = module;
        }
        out.push(row);
    }
    const manifest = { type: TYPE, version: VERSION, exportedAt: new Date().toISOString(), personas: out };
    // Pictures are already compressed: store them; the manifest is deflated.
    const zip = { [MANIFEST]: [strToU8(JSON.stringify(manifest)), { level: 6 }] };
    for (const [path, bytes] of Object.entries(files)) zip[path] = [bytes, { level: 0 }];
    const bytes = Buffer.from(zipSync(zip));
    if (bytes.length > MAX_BUNDLE_BYTES) throw new Error('보낼 페르소나 그림이 너무 커요. 개수를 나눠서 보내 주세요.');
    readPersonaBundle(bytes); // the receiver's own check, so a bad bundle never leaves this device
    return { bytes, names: out.map(p => p.name), excluded };
}

/** File name shown on the receiving side (".risuplay" so every transport accepts it). */
function bundleName(names) {
    const clean = value => String(value).replace(/[\\/\x00-\x1f\x7f-\x9f<>:"|?*]/g, '').trim().slice(0, 60) || '페르소나';
    const head = clean(names[0]);
    return `페르소나 ${names.length > 1 ? `${head} 외 ${names.length - 1}개` : head}.risuplay`;
}

module.exports = { MANIFEST, TYPE, VERSION, MAX_PERSONAS, MAX_BUNDLE_BYTES, readPersonaBundle, isPersonaBundle, buildPersonaBundle, bundleName, validateManifest };
