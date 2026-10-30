'use strict';
/**
 * Credential-only vault for NAS sync. Explicit field inventory → public record + opaque AES-GCM envelopes.
 * Ordinary gameplay data is never scanned; only the declared paths below are touched.
 */
require('sucrase/register/ts');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomUUID } = require('node:crypto');
const { canonical } = require('../../../shared/play-set/protocol.ts');
const { atomicWriteJson } = require('../file-store.cjs');
const { resolveEndpointUrl } = require('../../../src/ts/preset/adapter/buildRequest.ts');

const AUTH_HEADER = /^(authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key|x-auth-token|anthropic-auth-token|openai-api-key)$/i;
/** Credential-named keys by whole word (snake, kebab or camel case): `api_key`, `apiKey`, `access_token`, `client_secret`, `auth`;
 *  not `max_tokens`, `thinkingTokens` or `stoptokens`, which are ordinary generation parameters. */
const CREDENTIAL_WORDS = new Set(['key', 'apikey', 'token', 'secret', 'password', 'passwd', 'credential', 'credentials', 'auth']);
const CREDENTIAL_ARG = key => key.replace(/(?<=[a-z0-9])(?=[A-Z])/g, ' ').toLowerCase().split(/[^a-z0-9]+/).some(word => CREDENTIAL_WORDS.has(word));
const AUTH_QUERY = new Set(['key', 'api_key', 'apikey', 'api-key', 'token', 'access_token', 'apiKey', 'secret', 'auth']);
// Parameter lines follow applyAdditionalParamsText / customModels params: `key=value`, `header::Name=value`, `{{none}}` deletes.
const PARAM_LINE = /^(\s*)([^=]+?)(\s*)=(.*)$/;
const paramSecret = key => key.startsWith('header::') ? AUTH_HEADER.test(key.slice(8).trim()) : CREDENTIAL_ARG(key);
const paramSlot = key => key.startsWith('header::') ? 'header:' + key.slice(8).trim() : 'body:' + key;
/** Schema-driven: a model preset's own profile snapshot says which values are credentials (src/ts/preset/types.ts,
 *  applied by src/ts/preset/adapter/buildRequest.ts: auth fields, header/query mappings onto credential names). */
function presetSchema(preset) {
    const schema = preset?.profileSnapshot?.schema;
    if (!Array.isArray(schema)) throw Object.assign(new Error('Model preset without profile schema; credential inventory unresolved: ' + preset?.id), { code: 'VAULT_INVENTORY' });
    return schema.filter(Boolean);
}
const secretSchemaKey = preset => key => presetSchema(preset).some(f => f.key === key && (f.secret === true || f.mapsTo?.target === 'auth'
    || f.mapsTo?.target === 'header' && AUTH_HEADER.test(f.mapsTo.path ?? '') || f.mapsTo?.target === 'query' && AUTH_QUERY.has(f.mapsTo.path)))
    || (preset.profileSnapshot.auth?.fields ?? []).includes(key);
const presetUserValue = (key, _record, ancestors) => secretSchemaKey(ancestors.at(-1))(key);
const presetDefault = (key, _record, ancestors) => secretSchemaKey(ancestors.at(-2))(key) || CREDENTIAL_ARG(key);
const presetEndpointOverride = (key, _record, ancestors) => presetSchema(ancestors.at(-1)).some(f => f.key === key && f.mapsTo?.target === 'custom' && f.mapsTo.path === 'endpointUrl');
const bodyCredential = key => CREDENTIAL_ARG(key);
/** The origin requests really go to: schema endpoint override > static url > assembled Vertex host (project is path-only,
 *  so a placeholder resolves the host without the service-account secret). Unresolvable endpoints bind to the slot. */
function presetOrigin(preset) {
    try { return origin(resolveEndpointUrl(preset.profileSnapshot, preset.userValues ?? {}, '{"project_id":"origin-only"}')); }
    catch { return null; }
}
const PRESET_SELF = container => presetOrigin(container), PRESET_PARENT = (_, ancestors) => presetOrigin(ancestors.at(-1)), PRESET_SNAPSHOT = (_, ancestors) => presetOrigin(ancestors.at(-2));
// Path step: object key, {id} = array element identified by that field, {each} = every key/element (match = name filter).
// endpoint: sibling field (dotted path) or resolver function whose URL origin is bound into the envelope AAD; else the slot itself.
// kind: 'field' (non-empty string), 'json' (string or object), 'params' (header::Name=value lines).
const field = (path, endpoint, kind = 'field') => ({ path, endpoint, kind });
const preset = (...rest) => ['modelPresets', { id: 'id' }, ...rest];
const SECRET_FIELDS = [
    ...'openAIKey NAIApiKey elevenLabKey voyageApiKey supaMemoryKey claudeAPIKey openrouterKey nanogptKey huggingfaceKey fishSpeechKey mistralKey cohereAPIKey stabilityKey falToken vertexPrivateKey vertexAccessToken'
        .split(' ').map(key => field([key])),
    field(['proxyKey'], 'forceReplaceUrl'),
    field(['hordeConfig', 'apiKey']), field(['novelai', 'token']), field(['deeplOptions', 'key']), field(['deeplXOptions', 'token'], 'url'),
    field(['google', 'accessToken']), field(['hypaCustomSettings', 'key'], 'url'), field(['openaiCompatImage', 'key'], 'url'), field(['wavespeedImage', 'key']),
    field(['account', 'token']), field(['account', 'data', 'refresh_token']), field(['account', 'data', 'access_token']),
    field(['OaiCompAPIKeys', { each: true }]),
    field(['customModels', { id: 'id' }, 'key'], 'url'), field(['customModels', { id: 'id' }, 'params'], 'url', 'params'),
    field(['apiKeyPool', { each: true }, 'key']),
    field(['authRefreshes', { id: 'url' }, 'refreshToken'], 'url'), field(['authRefreshes', { id: 'url' }, 'clientSecret'], 'url'),
    field(['botPresets', { id: 'id' }, 'openAIKey']), field(['botPresets', { id: 'id' }, 'proxyKey'], 'forceReplaceUrl'),
    field(['characters', { id: 'chaId' }, 'oaiTTSConfig', 'apiKey'], 'baseURL'),
    field(preset('inlineCredential'), PRESET_SELF, 'json'),
    field(preset('userValues', { each: true, match: presetUserValue }), PRESET_PARENT),
    // Orphaned values lost their schema (dbDefaults.ts heal); keep them opaque rather than guess which were credentials.
    field(preset('orphanValues', { each: true }), PRESET_PARENT, 'json'),
    field(preset('customHeaders', { each: true, match: AUTH_HEADER }), PRESET_PARENT),
    field(preset('customBody', { each: true, match: bodyCredential }), PRESET_PARENT, 'json'),
    field(preset('additionalParamsText'), PRESET_SELF, 'params'),
    field(preset('profileSnapshot', 'defaults', { each: true, match: presetDefault }), PRESET_SNAPSHOT, 'json'),
    field(preset('profileSnapshot', 'bodyTemplate', { each: true, match: bodyCredential }), PRESET_SNAPSHOT, 'json'),
    field(preset('profileSnapshot', 'headerTemplate', { each: true, match: AUTH_HEADER }), PRESET_SNAPSHOT),
    field(['plugins', { id: 'name' }, 'realArg', { each: true, match: CREDENTIAL_ARG }]),
    // Plugin-owned persistent storage has no schema (risuai.d.ts: {[plugin]: any}); keep each plugin's entry opaque rather than guess.
    field(['pluginCustomStorage', { each: true }], undefined, 'json'),
];
// Endpoint strings whose userinfo / credential query parameters are extracted; the URL itself stays public.
const URL_FIELDS = [
    ...'forceReplaceUrl textgenWebUIStreamURL textgenWebUIBlockingURL koboldURL ollamaURL webUiUrl comfyUiUrl voicevoxUrl NAIImgUrl'.split(' ').map(key => [key]),
    ['customModels', { id: 'id' }, 'url'], ['openaiCompatImage', 'url'], ['hypaCustomSettings', 'url'], ['deeplXOptions', 'url'],
    ...'forceReplaceUrl koboldURL textgenWebUIStreamURL textgenWebUIBlockingURL'.split(' ').map(key => ['botPresets', { id: 'id' }, key]),
    ['characters', { id: 'chaId' }, 'oaiTTSConfig', 'baseURL'], preset('profileSnapshot', 'endpoint', 'url'), preset('userValues', { each: true, match: presetEndpointOverride }),
];
const ID_FIELDS = { customModels: 'id', botPresets: 'id', characters: 'chaId', modelPresets: 'id', plugins: 'name', authRefreshes: 'url' };
const REFS = '$syncSecrets';
const escape = part => String(part).replace(/~/g, '~0').replace(/\//g, '~1');
const unescape = part => part.replace(/~1/g, '/').replace(/~0/g, '~');
const isObject = v => v && typeof v === 'object' && !Array.isArray(v);
const identityOf = (element, id) => id && isObject(element) && typeof element[id] === 'string' && element[id] ? element[id] : null;

/** Visits every addressable location of a path spec: cb(container, key, pointer, ancestors). Duplicate identities are rejected. */
function visit(record, path, cb, pointer = '', ancestors = []) {
    if (!record) return;
    const [step, ...rest] = path;
    const descend = (container, key, identity) => {
        const at = pointer + '/' + escape(identity);
        if (!rest.length) return cb(container, key, at, ancestors);
        visit(container[key], rest, cb, at, [...ancestors, container]);
    };
    if (typeof step === 'string') { if (Object.hasOwn(record, step)) descend(record, step, step); return; }
    if (Array.isArray(record)) {
        const seen = new Set();
        record.forEach((element, index) => {
            const identity = identityOf(element, step.id) ?? String(index);
            if (seen.has(identity)) throw Object.assign(new Error('Ambiguous sync identity at ' + pointer + '/' + escape(identity)), { code: 'VAULT_IDENTITY' });
            seen.add(identity); descend(record, index, identity);
        });
    } else if (isObject(record)) {
        for (const key of Object.keys(record)) {
            const ok = !step.match || (typeof step.match === 'function' ? step.match(key, record, ancestors) : step.match.test(key));
            if (ok) descend(record, key, key);
        }
    }
}
const origin = url => { try { return new URL(url).origin; } catch { return null; } };
function endpointOrigin(spec, container, ancestors) {
    if (!spec) return null;
    if (typeof spec === 'function') return spec(container, ancestors);
    let node = container;
    for (const part of spec.split('.')) node = isObject(node) ? node[part] : undefined;
    return typeof node === 'string' ? origin(node) : null;
}
function splitUrl(value) {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (!/^https?:$/.test(url.protocol)) return null;
    const secrets = [];
    if (url.username || url.password) { secrets.push({ kind: 'userinfo', value: `${url.username}:${url.password}` }); url.username = ''; url.password = ''; }
    for (const [key, v] of [...url.searchParams]) if (AUTH_QUERY.has(key) && v) { secrets.push({ kind: 'query', param: key, value: v }); url.searchParams.set(key, ''); }
    return secrets.length ? { public: url.href, secrets } : null;
}
function joinUrl(value, refs, values) {
    const url = new URL(value);
    for (const ref of refs) {
        const v = values.get(ref.slot);
        if (ref.kind === 'userinfo') { const at = v.indexOf(':'); url.username = v.slice(0, at); url.password = v.slice(at + 1); }
        else url.searchParams.set(ref.param, v);
    }
    return url.href;
}
function splitParams(text) {
    const secrets = [], lines = text.split(/\r?\n/).map(line => {
        const m = PARAM_LINE.exec(line), key = m?.[2].trim();
        if (!m || !key || !paramSecret(key) || !m[4] || m[4] === '{{none}}') return line;
        secrets.push({ param: paramSlot(key), value: m[4] }); return `${m[1]}${m[2]}${m[3]}=`;
    });
    return secrets.length ? { public: lines.join('\n'), secrets } : null;
}
function joinParams(text, refs, values) {
    const pending = new Map(refs.map(ref => [ref.param, values.get(ref.slot)]));
    return text.split(/\r?\n/).map(line => {
        const m = PARAM_LINE.exec(line), key = m?.[2].trim();
        return m && m[4] === '' && key && pending.has(paramSlot(key)) ? `${line}${pending.get(paramSlot(key))}` : line;
    }).join('\n');
}
/** Every credential location of a record, with its schema-defined endpoint origin, whether or not a value is present. */
function inventory(record) {
    const found = [], seen = new Set();
    const push = entry => { if (seen.has(entry.slot)) throw Object.assign(new Error('Duplicate secret slot ' + entry.slot), { code: 'VAULT_IDENTITY' }); seen.add(entry.slot); found.push(entry); };
    for (const { path, endpoint, kind } of SECRET_FIELDS) visit(record, path, (container, key, pointer, ancestors) => {
        const value = container[key], at = endpointOrigin(endpoint, container, ancestors) ?? pointer;
        if (kind === 'params') {
            if (typeof value !== 'string') return;
            const split = splitParams(value);
            found.push({ slot: null, kind: 'params', path: pointer, origin: at, container, key });
            for (const s of split?.secrets ?? []) push({ slot: `${pointer}#${s.param}`, kind: 'header', path: pointer, param: s.param, origin: at, value: s.value, container, key, public: split.public });
            return;
        }
        // Opaque config slots seal every non-string JSON shape (object, array, number, boolean, null); strings follow field rules.
        if (kind === 'json' && typeof value !== 'string' && value !== undefined) return push({ slot: pointer, kind: 'json', path: pointer, origin: at, value: canonical(value), container, key });
        push({ slot: pointer, kind: 'field', path: pointer, origin: at, value: typeof value === 'string' ? value : '', container, key, present: typeof value === 'string' && value !== '' });
    });
    for (const path of URL_FIELDS) visit(record, path, (container, key, pointer) => {
        if (typeof container[key] !== 'string') return;
        const split = splitUrl(container[key]);
        found.push({ slot: null, kind: 'url', path: pointer, origin: origin(split?.public ?? container[key]), container, key });
        for (const s of split?.secrets ?? []) push({ slot: `${pointer}#${s.kind}${s.param ? ':' + s.param : ''}`, kind: s.kind, path: pointer, ...(s.param ? { param: s.param } : {}), origin: origin(split.public), value: s.value, container, key, public: split.public });
    });
    return found;
}

function createVault(master) {
    if (!Buffer.isBuffer(master) || master.length !== 32) throw new Error('Vault master must be 32 bytes');
    const derive = info => Buffer.from(hkdfSync('sha256', master, 'risubard-sync-vault', info, 32));
    const encryption = derive('encryption'), identity = derive('identity');
    const mac = text => createHmac('sha256', identity).update(text).digest('hex');
    const epoch = mac('epoch').slice(0, 32);
    /** Deterministic per (slot, origin, value): equal secrets at the same endpoint on two devices yield equal public
     *  references, while the same value sealed for another endpoint is a distinct, coexisting secret version. */
    const version = (slot, origin, value) => mac(canonical([slot, origin, value]));
    const aad = env => Buffer.from(canonical({ v: 1, epoch: env.epoch, slot: env.slot, version: env.version, origin: env.origin }));
    function seal(slot, value, originValue) {
        const origin = originValue ?? slot, env = { v: 1, epoch, slot, version: version(slot, origin, value), origin };
        const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryption, nonce);
        cipher.setAAD(aad(env));
        const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
        return { ...env, nonce: nonce.toString('base64'), data: data.toString('base64') };
    }
    function open(env) {
        if (!env || env.v !== 1) throw Object.assign(new Error('Unknown vault envelope'), { code: 'VAULT_SCHEMA' });
        if (env.epoch !== epoch) throw Object.assign(new Error('Envelope belongs to another vault key'), { code: 'VAULT_EPOCH' });
        const data = Buffer.from(env.data, 'base64'), nonce = Buffer.from(env.nonce, 'base64');
        if (data.length < 16 || nonce.length !== 12) throw Object.assign(new Error('Damaged vault envelope'), { code: 'VAULT_TAMPER' });
        const cipher = createDecipheriv('aes-256-gcm', encryption, nonce);
        cipher.setAAD(aad(env)); cipher.setAuthTag(data.subarray(data.length - 16));
        let value;
        try { value = Buffer.concat([cipher.update(data.subarray(0, data.length - 16)), cipher.final()]).toString('utf8'); }
        catch { throw Object.assign(new Error('Vault envelope failed authentication'), { code: 'VAULT_TAMPER' }); }
        if (version(env.slot, env.origin, value) !== env.version) throw Object.assign(new Error('Vault envelope version mismatch'), { code: 'VAULT_TAMPER' });
        return value;
    }
    /** Public copy with declared credentials removed and `$syncSecrets` references; envelopes keyed slot:version. */
    function project(record) {
        if (Object.hasOwn(record, REFS)) throw new Error('Record already carries sync secret references');
        const pub = JSON.parse(JSON.stringify(record)), refs = [], envelopes = new Map();
        for (const entry of inventory(pub)) {
            if (!entry.slot || (entry.kind === 'field' && !entry.present)) continue;
            const env = seal(entry.slot, entry.value, entry.origin); envelopes.set(`${entry.slot}:${env.version}`, env);
            refs.push({ slot: entry.slot, kind: entry.kind, path: entry.path, ...(entry.param ? { param: entry.param } : {}), version: env.version, origin: env.origin });
            entry.container[entry.key] = entry.public ?? '';
        }
        if (refs.length) pub[REFS] = refs.sort((a, b) => a.slot < b.slot ? -1 : 1);
        return { public: pub, envelopes: [...envelopes.values()] };
    }
    /** All-or-nothing: the whole record (a coupled provider group) applies only when every referenced version opens
     *  AND its envelope origin equals the origin the public record's own endpoint field defines now. Otherwise `current`
     *  stays in force and the record is pending; a secret is never paired with an endpoint it was not sealed for. */
    function apply(pub, envelopes, current) {
        const refs = Array.isArray(pub?.[REFS]) ? pub[REFS] : [];
        const value = JSON.parse(JSON.stringify(pub ?? null)); if (isObject(value)) delete value[REFS];
        const byKey = new Map(envelopes.map(env => [`${env.slot}:${env.version}`, env])), values = new Map(), pending = [];
        let locations;
        try { locations = new Map(inventory(value).map(entry => [entry.slot ?? `${entry.kind}:${entry.path}`, entry])); }
        catch (error) { return { applied: false, pending: [{ slot: '*', reason: error.code ?? 'inventory' }], value: current }; }
        const groups = new Map();
        for (const ref of refs) {
            const env = byKey.get(`${ref.slot}:${ref.version}`);
            const location = ['userinfo', 'query'].includes(ref.kind) ? locations.get('url:' + ref.path) : ref.kind === 'header' ? locations.get('params:' + ref.path) : locations.get(ref.slot);
            const expected = location ? location.origin ?? location.slot : undefined;
            const compatible = location && (['userinfo', 'query', 'header'].includes(ref.kind) || ['field', 'json'].includes(ref.kind) && ['field', 'json'].includes(location.kind));
            if (!compatible) { pending.push({ slot: ref.slot, reason: 'inventory' }); continue; }
            if (location.slot && (location.present || location.kind === 'json')) { pending.push({ slot: ref.slot, reason: 'occupied' }); continue; }
            if (!env) { pending.push({ slot: ref.slot, reason: 'missing' }); continue; }
            if (expected === undefined || env.origin !== expected || ref.origin !== expected) { pending.push({ slot: ref.slot, reason: 'origin' }); continue; }
            try { values.set(ref.slot, open(env)); } catch (error) { pending.push({ slot: ref.slot, reason: error.code ?? 'error' }); continue; }
            if (!groups.has(location)) groups.set(location, []); groups.get(location).push(ref);
        }
        if (pending.length) return { applied: false, pending, value: current };
        for (const [location, group] of groups) {
            const { container, key } = location;
            if (group[0].kind === 'field') container[key] = values.get(group[0].slot);
            else if (group[0].kind === 'json') container[key] = JSON.parse(values.get(group[0].slot));
            else if (group[0].kind === 'header') container[key] = joinParams(container[key], group, values);
            else container[key] = joinUrl(container[key], group, values);
        }
        return { applied: true, pending: [], value };
    }
    return { epoch, version, seal, open, project, apply };
}
const sameSecret = (a, b) => a.slot === b.slot && a.version === b.version;

/** Device-protected 32-byte master, stored apart from transfer-secrets.dat; no reset path shares its fate. */
function vaultMasterStore(dataRoot, protect) {
    const file = 'sync-vault-master.dat';
    let lane = Promise.resolve();
    const exclusive = operation => { const next = lane.then(operation); lane = next.catch(() => {}); return next; };
    async function read() {
        try { const saved = JSON.parse(await fs.readFile(join(dataRoot, file), 'utf8')); return protect(Buffer.from(saved.data, 'base64'), true); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
    async function write(master) { atomicWriteJson(dataRoot, file, { version: 1, data: (await protect(master, false)).toString('base64') }); }
    return {
        /** The installed master or null; never creates one (sharing decides replacement explicitly). */
        peek: () => exclusive(read),
        load: () => exclusive(async () => {
            const master = await read();
            if (master) { if (master.length !== 32) throw new Error('Damaged vault master'); return master; }
            const fresh = randomBytes(32); await write(fresh); return fresh;
        }),
        /** One-time sharing over an already trusted channel. A different installed key is kept as a recovery copy only on explicit replace. */
        importMaster: (master, { replace = false } = {}) => exclusive(async () => {
            if (!Buffer.isBuffer(master) || master.length !== 32) throw new Error('Vault master must be 32 bytes');
            const existing = await read();
            if (existing && !existing.equals(master)) {
                if (!replace) throw new Error('A different vault key is already installed');
                await fs.copyFile(join(dataRoot, file), join(dataRoot, `sync-vault-master.recovery-${randomUUID()}.dat`), fs.constants.COPYFILE_EXCL);
            }
            await write(master);
        }),
    };
}
module.exports = { createVault, vaultMasterStore, inventory, sameSecret, splitUrl, splitParams, SECRET_FIELDS, URL_FIELDS, REFS };
