'use strict';
/**
 * NAS sync application service: canonical snapshot → sync commits, and received commits → an apply plan the client saves
 * through its normal canonical save flow (plan → arm → client save → finish), mirroring play-set-service.cjs.
 *
 * Durability: plan journals and recovery copies under nas-sync/apply|recovery are SEALED (public records + envelope
 * ciphertext ids only; secrets are materialized in memory for the authenticated client response and never written).
 * Finish records per-step progress and is idempotent, so a crash at any boundary resumes on reopen. Originals are moved
 * aside, never deleted. Network only in publish/pull. Nothing here replaces the live database behind the client.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { join, dirname, relative, isAbsolute, sep } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { atomicWriteJson, resolveInside } = require('../file-store.cjs');
const { canonical } = require('../../../shared/play-set/protocol.ts');
const { createSyncStore } = require('./nas-sync-store.cjs');
const { createVault, vaultMasterStore, REFS } = require('./nas-sync-vault.cjs');
const { createSyncRemote, createSyncTransport } = require('./nas-sync-remote.cjs');
const { createManifest } = require('./nas-sync-manifest.cjs');
const { projectDatabase, diffProjection, envelopeIdentity, GROUP_KEYS, localPins, collectReferences } = require('./nas-sync-projection.cjs');
const { makeRevision, hashJson } = require('./nas-sync-core.cjs');
const { PERSONA_MIRRORS, personaSelection, personaMirrorsMatch, personaMirrorIssue, mergePersonaHeads } = require('./nas-sync-reconcile.cjs');
const { deviceKeyStore, writeRequestArchive, writeGrantArchive, openGrant, readShareArchive, REQUEST, GRANT } = require('./nas-sync-share.cjs');
const { playSetMemoryMaterials } = require('./play-set-memory.cjs');
const { relinkWorkspace, sourceIdentityMap } = require('./play-set-relink.cjs');
const { remapBardChat } = require('../../../shared/play-set/bardIdentity.ts');
const { sanitizeTransferMessages } = require('../../../shared/play-set/snapshot.ts');
const { resolveMemoryWorkspace } = require('../risubard-memory-workspace.ts');
const { saveStoreDirectory } = require('../risubard-memory-save-store.ts');
const { memorySaveWorkspaceId } = require('../risubard-memory-save.ts');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = v => JSON.parse(JSON.stringify(v));
const localHash = value => sha256(canonical(value, true));
const messageBody = revision => (revision.content?.message ?? []).map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
    const { risubardCanonicalReceipt: _receipt, ...body } = message;
    return body;
});
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const b64 = text => Buffer.from(text).toString('base64url');
async function safeParents(root, path) {
    const rel = relative(root, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('Sync path escapes storage');
    let current = root;
    for (const part of rel.split(sep).filter(Boolean)) {
        current = join(current, part); await fsp.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
        const stat = await fsp.lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe sync directory');
    }
}
async function syncDir(path) { let fd; try { fd = await fsp.open(path, 'r'); await fd.sync(); } catch (error) { if (process.platform !== 'win32') throw error; } finally { await fd?.close(); } }
async function hashFile(path) { const digest = createHash('sha256'); for await (const chunk of fs.createReadStream(path)) digest.update(chunk); return digest.digest('hex'); }

function createNasSyncService({ dataRoot, readDatabase, memory, storage, readColdChat = async () => null, readInlay = async () => null, installInlay = async () => {}, removeInlay = async () => {}, inlayMeta = async () => null, secrets, fetch, protect, nasRoute = null, identityDir = null, secretsDir = null, transfers = null, now = Date.now, hooks = {} }) {
    const root = join(dataRoot, 'nas-sync');
    fs.mkdirSync(join(root, 'apply'), { recursive: true, mode: 0o700 });
    const file = name => resolveInside(root, name);
    const manifest = createManifest({ root, name: 'service.json', initial: { version: 1, enabled: false, lineage: {}, branches: {}, plan: null, retained: [], pendingLineage: null, applied: [], incarnation: null, bootstraps: [], pendingBootstrap: null, pendingRestore: null, lineageHistory: [], role: null, vaultOrigin: null, shares: [], consumed: {}, pendingGrant: null, localApply: [] } });
    const service = () => manifest.get();
    let lane = Promise.resolve(), operating = false;
    const exclusive = op => { const next = lane.then(async () => { operating = true; try { return await op(); } finally { operating = false; } }); lane = next.catch(() => {}); return next; };
    let store, vault, transport;
    const openStore = () => store ??= createSyncStore({ dataRoot, identityDir, now });
    // The vault master and this device's sync key pair live in the platform's no-backup secrets directory when the host provides
    // one (Android noBackupFilesDir / Windows local app data); `secretsDir` null keeps them beside the data (reported boundary).
    const masterStore = vaultMasterStore(secretsDir ?? dataRoot, protect), keyStore = deviceKeyStore(secretsDir ?? dataRoot, protect);
    const masterFile = () => join(secretsDir ?? dataRoot, 'sync-vault-master.dat');
    /** A fresh master is generated only for a device with no sync history and no shared origin. Otherwise a missing master means the
     *  protected secrets were lost (wiped no-backup dir, cloned data root with a shared manifest): fail closed with VAULT_MISSING so no
     *  revision is ever sealed under an incompatible key; the user re-shares the key over a trusted channel (or the authority re-enables). */
    async function loadMaster() {
        if (!await masterStore.peek()) {
            const s = openStore(), history = s.state().commits.length > 0 || Object.keys(service().lineage).length > 0;
            if (service().vaultOrigin === 'shared' || history) throw Object.assign(new Error('동기화 키가 이 기기에 없어요. 권한 기기에서 키를 다시 공유해 주세요.'), { code: 'VAULT_MISSING' });
            manifest.transact(x => { x.vaultOrigin ??= 'generated'; });
        }
        return masterStore.load();
    }
    async function openVault() { return vault ??= createVault(await loadMaster()); }
    const openTransport = () => transport ??= createSyncTransport({ store: openStore(), remote: createSyncRemote({ secrets, fetch, route: nasRoute }), now });
    const requireEnabled = () => { if (!service().enabled) throw new Error('NAS 동기화가 꺼져 있어요.'); return openStore(); };
    const planPath = txn => `apply/${txn}.json`;
    const LINEAGE_FILE = 'risubard/nas-sync/lineage.json'; // declared before the open-time recovery below uses recordLineage()
    const readPlan = txn => JSON.parse(fs.readFileSync(file(planPath(txn)), 'utf8'));
    const writePlan = plan => atomicWriteJson(root, planPath(plan.transaction), plan);
    // The journal is always written before the pointer, so on open the journal's phase is authoritative for the write gate.
    // Orphan journals (crash between journal and pointer writes) are adopted unless they belong to a finished or held plan.
    const completed = new Set([...service().applied, ...(service().rolledBack ?? [])].map(a => a.transaction)), held = new Set(service().retained.map(r => r.transaction));
    for (const name of fs.readdirSync(join(root, 'apply'))) {
        const m = /^([0-9a-f-]{36})\.json$/.exec(name); if (!m) continue;
        if (completed.has(m[1])) { fs.rmSync(file(planPath(m[1])), { force: true }); fs.rmSync(join(root, 'apply', m[1]), { recursive: true, force: true }); continue; } // leftover of a finished plan
        if (held.has(m[1])) continue; // user held this recovery: journal, staging and recovery copies stay untouched and are never re-adopted
        if (service().plan && service().plan.transaction !== m[1]) continue;
        try { const plan = readPlan(m[1]); manifest.transact(s => { s.plan = { transaction: plan.transaction, phase: plan.phase, workspaceId: plan.workspaceId }; }); } catch { /* unreadable journal stays on disk for manual inspection */ }
    }
    // A snapshot that committed to the store but crashed before recording lineage is completed from its durable intent. A crash
    // BEFORE the store commit (intent written, nothing committed) only drops the intent: lineage, vanished keys and a pending
    // restore mark stay exactly as they were, and the next snapshot does the whole thing again.
    if (service().pendingLineage) {
        const s = openStore(), intent = service().pendingLineage;
        const committed = (intent.revisions ?? []).length > 0 && intent.revisions.every(id => s.graph.get(id));
        manifest.transact(x => {
            if (committed) { for (const [k, id] of Object.entries(intent.lineage)) x.lineage[k] = id; for (const k of intent.vanished ?? []) delete x.lineage[k]; if (intent.restore && x.pendingRestore?.id === intent.restore.id) x.pendingRestore = null; }
            x.pendingLineage = null;
        });
        if (committed) recordLineage();
    }
    // A bootstrap that committed to the store but crashed before its record was written is completed from its durable intent;
    // one that never reached the store is dropped together with its archive (nothing was resolved).
    if (service().pendingBootstrap) {
        const s = openStore(), intent = service().pendingBootstrap;
        const committed = intent.revisions.every(id => s.graph.get(id)), commit = committed ? s.state().commits.find(c => (c.revisions ?? []).includes(intent.revisions[0])) : null;
        manifest.transact(x => { if (committed) x.bootstraps.push({ id: intent.id, authorityDevice: intent.authorityDevice, at: intent.at, roots: intent.roots, commit: commit?.commitId ?? null }); x.pendingBootstrap = null; });
        if (!committed) fs.rmSync(join(root, 'recovery', 'bootstrap-' + intent.id), { recursive: true, force: true });
    }

    /** Ordinary writes are refused (423 NAS_SYNC_BUSY) while a plan is being saved — the saving client carries the plan's transaction id —
     *  and for the duration of any exclusive step (snapshot, bootstrap, plan, resolve…), which must not interleave with writes.
     *  Clients treat that answer as "wait and resend" (nodeStorage.saveRequest), so a write landing in such a window is delayed, not lost. */
    function assertWrite(req) {
        if (req.path?.startsWith('/api/nas-sync')) return;
        const plan = service().plan, active = plan && ['saving', 'committed'].includes(plan.phase) ? plan.transaction : undefined;
        const token = req.headers['x-nas-sync-id'];
        if (token ? token !== active : active || operating) { const error = new Error('NAS sync apply must finish before saving'); error.status = 423; error.code = 'NAS_SYNC_BUSY'; if (active) error.transaction = active; throw error; } // `transaction`: an armed plan (recovery settles it), not a transient step
    }
    const differenceCache = new Map();
    const branchesPreserved = (s, key, c) => key.startsWith('play\nchat\n') && c.state === 'diverged' && !chatDifference(c.liveHeads.map(id => s.graph.get(id))).sameMessages && c.variants.every(ids => ids.some(id => Object.values(service().lineage).includes(id)));
    const conflictCount = s => s.graph.rootKeys().filter(k => { if (k === 'settings\ngroup\nuserNote') return false; const c = s.graph.classify(k); return !branchesPreserved(s, k, c) && (c.state === 'diverged' || c.state === 'delete-pending'); }).length;
    // `workspaceId`/`role` are reported even while disabled so a reopened panel resumes the saved setup instead of defaults.
    const status = () => ({ cardOnlyUploads: service().cardOnlyUploads ?? [], enabled: service().enabled, role: service().role ?? null, workspaceId: service().workspaceId ?? null, plan: service().plan, retained: service().retained.length, recovery: manifest.recovery(), pendingRestore: service().pendingRestore ?? null, pendingBootstrap: service().pendingBootstrap ?? null,
        vault: { origin: service().vaultOrigin ?? null, sharedFrom: service().vaultSharedFrom ?? null, missing: !fs.existsSync(masterFile()) && (service().vaultOrigin === 'shared' || (service().enabled && (Object.keys(service().lineage).length > 0))), pendingGrant: service().pendingGrant ? { from: service().pendingGrant.from, reason: service().pendingGrant.reason } : null }, shares: (service().shares ?? []).map(({ id, kind, to, via, at }) => ({ id, kind, to, via, at })),
        lastAppliedAt: service().applied.at(-1)?.at ?? null,
        localApply: (service().localApply ?? []).length, ...(service().enabled ? { sync: openTransport().status(), conflicts: conflictCount(openStore()) } : {}) });
    // ------------------------------------------------------------------ key sharing ------------------------------------------------------------------
    const publicShare = r => ({ id: r.id, kind: r.kind, to: r.to ?? null, via: r.via ?? null, at: r.at });
    const requireTransfers = () => { if (!transfers?.stageSend) throw new Error('Trusted transfer channel is unavailable on this host'); return transfers; };
    /** Joining device: a request carrying this device's sync public key (nothing secret), staged for the existing device picker. */
    async function shareRequest() {
        const s = requireEnabled(), k = await keyStore.load();
        const record = await requireTransfers().stageSend({ name: 'RisuBard 동기화 키 요청.risuplay', kind: REQUEST, build: p => writeRequestArchive(p, { workspaceId: s.identity().workspaceId, device: s.identity().deviceId, publicRaw: k.publicRaw, keyId: k.keyId }) });
        manifest.transact(x => { x.shares.push({ id: record.id, kind: 'request', at: now() }); });
        return { ...publicShare(service().shares.at(-1)), name: record.name };
    }
    /** Called by the play-set service for native inbox files only (its `trustedDevice` is transport provenance): returns the share kind or null. */
    async function detectShare(file) { try { return (await readShareArchive(file))?.kind ?? null; } catch { return 'damaged'; } }
    const consumed = nativeId => service().consumed?.[nativeId] ?? null;
    /** Terminal outcomes of native share entries, in the transfer-queue shape, so the existing native status path (the client's
     *  `state.write queue`) reports them to the sending device like any received file; never part of the play-set apply queue. */
    const consumedAll = () => Object.values(service().consumed ?? {}).map(r => ({ id: r.id, nativeId: r.id, direction: 'receive', share: true, kind: r.kind ?? null, state: r.state, createdAt: r.at, name: r.kind === 'request' ? '동기화 키 요청' : '동기화 키', error: r.error }));
    const consume = (nativeId, outcome) => { const record = { id: nativeId, direction: 'receive', share: true, at: now(), ...outcome }; manifest.transact(x => { x.consumed[nativeId] = record; }); return record; };
    /** A request from a registered/authorized device makes this authority stage a grant sealed to that device's key (ciphertext only);
     *  a grant addressed to this device installs the shared vault master. Nothing here is ever accepted from the generic incoming,
     *  NAS, GitHub or file routes, and nothing secret is written: the request is a public key, the grant is for one device's key. */
    async function receiveForeign(file, { kind, nativeId, trustedDevice }) {
        const done = consumed(nativeId); if (done) return done;
        const reject = error => { const record = consume(nativeId, { state: 'failed', error }); fs.rmSync(file, { force: true }); return record; };
        if (!trustedDevice) return reject('신뢰된 기기 전송이 아니어서 동기화 키 자료를 거부했어요.');
        let share; try { share = await readShareArchive(file); } catch (error) { return reject('손상된 동기화 키 자료: ' + error.message); }
        if (!share) return reject('동기화 키 자료가 아니에요.');
        const s = openStore();
        if (share.kind === 'request') {
            // Any enabled device that holds THIS workspace's key (the authority, or a device that received it) can answer: a lost-key
            // installation recovers from whichever trusted device still has the key. A device without the key never grants one.
            if (!service().enabled || !(service().role === 'authority' || service().vaultOrigin === 'shared')) return reject('이 기기에는 공유할 동기화 키가 없어요.');
            if (share.manifest.workspaceId !== s.identity().workspaceId) return reject('다른 작업공간의 키 요청이에요.');
            let master; try { master = await loadMaster(); } catch (error) { if (error.code === 'VAULT_MISSING') return { id: nativeId, direction: 'receive', share: true, state: 'waiting', code: 'VAULT_MISSING', error: error.message }; throw error; } // not consumed: answered once the key is back
            const v = createVault(master);
            const record = await requireTransfers().stageSend({ name: 'RisuBard 동기화 키.risuplay', kind: GRANT, build: p => writeGrantArchive(p, { workspaceId: s.identity().workspaceId, epoch: v.epoch, device: s.identity().deviceId, recipient: share.manifest.device, recipientKeyId: share.manifest.keyId, recipientPublicRaw: share.publicRaw, master }) });
            manifest.transact(x => { x.shares.push({ id: record.id, kind: 'grant', to: share.manifest.device, via: trustedDevice, at: now() }); });
            const done = consume(nativeId, { state: 'applied', kind: 'request', from: share.manifest.device, grant: record.id, replyTo: trustedDevice }); // outcome first: a replay finds it
            fs.rmSync(file, { force: true });
            return done;
        }
        // grant
        if (service().plan) return { id: nativeId, direction: 'receive', share: true, state: 'waiting', error: '동기화 적용이 끝난 뒤 키를 설치해요.' }; // not consumed: retried by the next inbox poll
        const k = await keyStore.load();
        if (share.manifest.recipient !== s.identity().deviceId || share.manifest.recipientKeyId !== k.keyId) return reject('이 기기용으로 발급된 키가 아니에요.');
        if (s.identity().workspaceId && s.identity().workspaceId !== share.manifest.workspaceId) return reject('다른 작업공간의 키예요.');
        let master; try { master = openGrant(share, k); } catch (error) { return reject(error.message); }
        if (createVault(master).epoch !== share.manifest.epoch) return reject('키와 금고 세대가 맞지 않아요.');
        const existing = await masterStore.peek();
        const keyInUse = service().vaultOrigin === 'shared' || s.state().commits.length > 0; // unpublished history counts: it was sealed with the installed key
        if (existing && !existing.equals(master) && keyInUse) {
            // Never replace a key this install has used automatically: the grant stays in the native inbox (ciphertext) until the user decides.
            manifest.transact(x => { x.pendingGrant = { nativeId, file, from: share.manifest.device, reason: 'key-conflict' }; });
            return { id: nativeId, direction: 'receive', share: true, state: 'waiting', code: 'KEY_CONFLICT', error: '이 기기에 이미 다른 동기화 키가 설치돼 있어요. 바꾸려면 확인이 필요해요.' };
        }
        return installGrant({ nativeId, file, master, workspaceId: share.manifest.workspaceId, from: share.manifest.device, replace: !!existing });
    }
    async function installGrant({ nativeId, file, master, workspaceId, from, replace }) {
        const s = openStore();
        await masterStore.importMaster(master, { replace }); vault = null;
        if (s.identity().workspaceId !== workspaceId) s.setWorkspace(workspaceId);
        // The key lands in the protected store either way; sync becomes enabled only on a device that never chose otherwise (no role
        // yet). A device the user explicitly disabled stays disabled: the delayed grant must not restart work.
        manifest.transact(x => { x.vaultOrigin = 'shared'; x.vaultSharedFrom = from; x.workspaceId = s.identity().workspaceId; x.pendingGrant = null; if (!x.enabled && x.role === null) { x.enabled = true; x.role = 'joining'; x.incarnation ??= s.identity().incarnationId; } }); // the trusted grant sender is the bootstrap authority
        const done = consume(nativeId, { state: 'applied', kind: 'grant', from, enabled: service().enabled }); // outcome first, then the ciphertext goes
        fs.rmSync(file, { force: true });
        return done;
    }
    /** Explicit replacement of an installed, used key by a pending grant (the previous key is kept as a recovery copy by the vault store). */
    async function acceptPendingGrant({ replace }) {
        const pending = service().pendingGrant; if (!pending) throw new Error('No pending sync key');
        if (replace !== true) throw new Error('Replacing the installed sync key requires confirmation');
        if (service().plan) throw new Error('Finish the pending sync apply first');
        const share = await readShareArchive(pending.file).catch(() => null), k = await keyStore.load();
        if (!share || share.kind !== 'grant') { manifest.transact(x => { x.pendingGrant = null; }); throw new Error('The pending sync key is no longer available'); }
        const master = openGrant(share, k);
        return installGrant({ nativeId: pending.nativeId, file: pending.file, master, workspaceId: share.manifest.workspaceId, from: share.manifest.device, replace: true });
    }
    async function discardShare({ id }) { await requireTransfers().dropStaged(id); manifest.transact(x => { x.shares = x.shares.filter(r => r.id !== id); }); return status(); }
    /** Startup: grants/requests that landed in the native inbox before a crash are handled now; staged sends older than a day are dropped. */
    async function sweepShares() {
        if (!transfers?.foreignInbox) return;
        for (const entry of await transfers.foreignInbox()) { try { await receiveForeign(entry.file, entry); } catch { /* reported by the next import */ } }
        for (const r of service().shares ?? []) if (now() - r.at > 86_400_000) await discardShare({ id: r.id }).catch(() => {});
    }
    // ------------------------------------------------------------------ conflicts / trash / open deletion ------------------------------------------------------------------
    /** Diverged library/settings roots with every observed head (public form: secrets are references), and delete-pending chats. */
    /** Which device a head came from: this one (own commit) or the peer that published it; unknown for history without a record. */
    function sourceOf(s, revisionId) {
        const state = s.state();
        if (state.commits.some(c => (c.revisions ?? []).includes(revisionId))) return { device: s.identity().deviceId, self: true };
        for (const [key, p] of Object.entries(state.peers)) if (Object.values(p.admittedRevisions ?? {}).some(ids => ids.includes(revisionId))) return { device: key.split('/')[0], self: false };
        return { device: null, self: false };
    }
    function rootTitle(s, key) {
        const [, type, id] = key.split('\n'), r = s.graph.get(s.graph.classify(key).liveHeads[0]);
        if (type !== 'chat') return r?.content?.name ?? id;
        const owner = s.graph.revisions().find(r => r.type === 'character' && r.content?.chatIds?.includes(id));
        return [owner?.content?.name, r?.content?.name || '이름 없는 대화'].filter(Boolean).join(' · ');
    }
    function chatDifference(heads) {
        const key = heads[0].root, signature = heads.map(h => h.id).sort().join(':');
        const cached = differenceCache.get(key);
        if (cached?.signature === signature) return cached.result;
        const first = heads[0], differs = [], same = pick => heads.every(h => hashJson(pick(h)) === hashJson(pick(first)));
        const sameMessages = same(messageBody);
        if (!sameMessages) differs.push('messages');
        const deps = (h, prefix) => Object.fromEntries(Object.entries(h.dependencies).filter(([k]) => prefix.some(p => k.startsWith(p))));
        if (!same(h => deps(h, ['bard:']))) differs.push('wiki');
        if (!same(h => deps(h, ['slot:', 'page:']))) differs.push('slots');
        if (!same(h => deps(h, ['pin:', 'envelope:']))) differs.push('settings');
        if (!same(h => deps(h, ['asset:', 'inlay:', 'inlay-metadata:']))) differs.push('media');
        if (!same(h => Object.fromEntries(Object.entries(h.content ?? {}).filter(([k]) => !['message', 'id', 'name'].includes(k)))) || (sameMessages && !same(h => h.content?.message ?? []))) differs.push('state');
        const result = { sameMessages: !differs.includes('messages'), differs };
        differenceCache.set(key, { signature, result });
        return result;
    }
    function conflicts() {
        const s = openStore(), out = [];
        for (const key of s.graph.rootKeys()) {
            if (key === 'settings\ngroup\nuserNote') continue; // legacy selected-persona mirror remains in history, never a user-facing library conflict
            const [domain, type, rootId] = key.split('\n'), c = s.graph.classify(key);
            if (c.state === 'diverged') {
                const versions = c.variants.map(ids => s.graph.get(ids[0]));
                out.push({ root: key, domain, type, id: rootId, title: rootTitle(s, key), state: branchesPreserved(s, key, c) ? 'branches-preserved' : c.state,
                    ...(type === 'chat' ? chatDifference(versions) : {}),
                    variants: c.variants.map(heads => { const r = s.graph.get(heads[0]); return { heads, source: sourceOf(s, heads[0]),
                        ...(type === 'chat' ? { messages: r.content?.message?.length ?? 0, wikiFiles: Object.keys(r.dependencies).filter(k => k.startsWith('bard:')).length } : { content: r.content }),
                        ...(rootId === 'personas' && type === 'group' ? { resolvable: !!mergePersonaHeads(s.graph, c.liveHeads.map(id => s.graph.get(id)), r.id, collectReferences) } : {}) }; }) });
            }
            else if (c.state === 'delete-pending') out.push({ root: key, domain, type, id: rootId, state: c.state, liveHeads: c.liveHeads, tombstoneHeads: c.tombstoneHeads });
        }
        return out;
    }
    /** Last captured/applied revision only: a published revision is not a receipt from another device. */
    async function overview() {
        const s = requireEnabled(), db = await readDatabase(), state = s.state(), lineage = service().lineage;
        const rows = [], commitsByRevision = new Map();
        for (const commit of state.commits) for (const id of commit.revisions ?? []) { if (!commitsByRevision.has(id)) commitsByRevision.set(id, []); commitsByRevision.get(id).push(commit); }
        for (const character of db?.characters ?? []) for (const chat of character.chats ?? []) {
            const rootId = service().branches[chat.id]?.root ?? chat.id, key = `play\nchat\n${rootId}`, c = s.graph.classify(key);
            const rev = s.graph.get(lineage[key + '#' + chat.id]);
            const own = commitsByRevision.get(rev?.id) ?? [];
            const messageContent = messages => { const value = clone(messages ?? []); sanitizeTransferMessages(value, 'message', []); return value; };
            const localChanges = rev && hashJson(messageContent(chat.message)) !== hashJson(messageContent(rev.content?.message));
            const isCurrent = rev && c.liveHeads.some(id => { const h = s.graph.get(id); return h.contentHash === rev.contentHash && h.dependencyHash === rev.dependencyHash; });
            const deps = Object.keys(rev?.dependencies ?? {});
            rows.push({ root: key, character: character.name || '이름 없는 캐릭터', name: chat.name || '이름 없는 대화',
                state: (service().cardOnlyUploads ?? []).includes(character.chaId) ? 'card-only' : !rev ? 'uncaptured' : localChanges ? 'local-changes' : c.state === 'diverged' && !branchesPreserved(s, key, c) ? 'review' : !isCurrent ? 'pending' : own.length ? (own.some(x => x.published) ? 'uploaded' : 'upload-pending') : 'applied',
                wikiFiles: deps.filter(k => k.startsWith('bard:')).length,
                slots: new Set(deps.filter(k => k.startsWith('slot:')).map(k => k.split(':')[1])).size,
                pages: deps.filter(k => k.startsWith('page:')).length });
        }
        const known = new Set(), times = new Map();
        for (const commit of state.commits) if (commit.published) for (const id of commit.revisions) { known.add(id); times.set(id, { at: commit.published.at, kind: 'uploaded' }); }
        for (const peer of Object.values(state.peers)) for (const ids of Object.values(peer.admittedRevisions ?? {})) for (const id of ids) known.add(id);
        const parents = new Set(), nasHeads = new Map();
        for (const id of known) { const r = s.graph.get(id); for (const parent of r?.parents ?? []) parents.add(parent); }
        for (const id of known) {
            const r = s.graph.get(id); if (!r || parents.has(id)) continue;
            const key = `${r.domain}\n${r.type}\n${r.root}`;
            if (!nasHeads.has(key)) nasHeads.set(key, []);
            nasHeads.get(key).push(id);
        }
        const chatRows = new Map();
        for (const row of rows) { if (!chatRows.has(row.root)) chatRows.set(row.root, []); chatRows.get(row.root).push(row); }
        const items = [...new Set([...s.graph.rootKeys(), ...chatRows.keys()])].filter(key => key !== 'settings\ngroup\nuserNote').flatMap(key => {
            const [, type, id] = key.split('\n'), c = s.graph.classify(key), heads = nasHeads.get(key) ?? [];
            const dates = heads.map(id => state.nasTimes?.[id] ? { at: state.nasTimes[id], kind: 'modified' } : times.get(id));
            const dated = dates.length && dates.every(x => Number.isSafeInteger(x?.at) && x.at > 0) ? dates.reduce((a, b) => a.at >= b.at ? a : b) : null;
            return (chatRows.get(key) ?? [null]).map(chat => ({ root: key, type, id, title: chat ? `${chat.character} · ${chat.name}` : rootTitle(s, key),
                nasAt: dated?.at ?? null, nasTimeKind: dated?.kind ?? null,
                state: chat?.state ?? (c.state === 'diverged' || c.state === 'delete-pending' ? 'review' : c.state === 'deleted' ? 'deleted' : !heads.length ? 'upload-pending' : c.heads.some(id => !known.has(id)) ? 'upload-pending' : 'recorded'),
                ...(chat ? { wikiFiles: chat.wikiFiles, slots: chat.slots, pages: chat.pages } : {}) }));
        });
        return { chats: rows, items, personas: (db?.personas ?? []).map(p => ({ name: p.name || '이름 없는 페르소나' })), localIssues: [personaMirrorIssue(db ?? {})].filter(Boolean), peerApplied: 'unconfirmed' };
    }
    /** Resolution parents every head (core resolve) with the kept head's content; the plan then materializes it locally. */
    async function resolveConflict({ root, keep }) {
        if (root === 'settings\ngroup\nuserNote') throw new Error('The selected persona owns its note; this legacy mirror is read-only');
        const s = requireEnabled(), c = s.graph.classify(root), kept = s.graph.get(keep);
        if (!kept || !c.heads.includes(keep) || kept.tombstone) throw new Error('Choose one of the live heads to keep');
        const [domain, type, rootId] = root.split('\n');
        const merged = root === 'settings\ngroup\npersonas' ? mergePersonaHeads(s.graph, c.liveHeads.map(id => s.graph.get(id)), keep, collectReferences) : null;
        if (root === 'settings\ngroup\npersonas' && !merged) throw new Error('Persona records require individual review; the whole library will not be replaced');
        const rev = s.graph.resolve({ domain, type, root: rootId, ...(merged ?? { content: kept.content, dependencies: kept.dependencies }) });
        await commitWithIntent(s, [rev], [root]);
        return { resolved: rev.id, root };
    }
    /** Narrow explicit recovery of a settings group: a PAST revision of that root is re-published as the successor of every current head
     *  (the same parents core resolve() uses) with the past revision's content and dependency/envelope references; its sealed values are
     *  opened once, in memory, only to prove this device's key can (the result is discarded). The plan then materializes it here and every
     *  peer applies it as a linear descendant. Never a play/library root. */
    async function restoreRevision({ root, revision, expectedHeads, confirmed }) {
        if (confirmed !== true) throw new Error('Restoring a past revision requires confirmation');
        const s = requireEnabled(); if (service().plan) throw new Error('Finish the pending sync apply first');
        const [domain, type, rootId] = String(root ?? '').split('\n');
        if (root === 'settings\ngroup\nuserNote') throw new Error('Restore the persona note through its persona record');
        if (domain !== 'settings' || type !== 'group' || !rootId) throw new Error('Only a settings group can be restored this way');
        const past = typeof revision === 'string' ? s.graph.get(revision) : null;
        if (!past || past.domain !== domain || past.type !== type || past.root !== rootId) throw new Error('Revision does not belong to this root');
        if (past.tombstone) throw new Error('A deletion cannot be restored as content');
        // The past content must be materializable with THIS device's key before it is queued (an envelope's mere presence is not enough):
        // the opened value is discarded at once, never logged or returned.
        const v = await openVault();
        if (!materialize(v, 'settings', past.content, envelopesFor(s, v, past), null).applied) throw Object.assign(new Error('That revision\'s sealed values cannot be opened with this device\'s key'), { code: 'VAULT_PENDING' });
        // Everything from here to the commit is synchronous (no await): pull() refreshes the graph outside the exclusive lane, so the heads
        // the caller inspected are re-checked against the live graph in the same turn as the commit that parents them. Exact set, no duplicates.
        const c = s.graph.classify(root);
        if (!c.liveHeads.length) throw new Error('Root has no live head');
        const want = new Set(Array.isArray(expectedHeads) ? expectedHeads.filter(h => typeof h === 'string') : []);
        if (!Array.isArray(expectedHeads) || want.size !== expectedHeads.length || want.size !== c.heads.length || !c.heads.every(h => want.has(h))) throw Object.assign(new Error('The root\'s heads changed since they were inspected; re-check and pass the current heads'), { code: 'HEADS_CHANGED', heads: c.heads });
        if (!c.heads.some(h => h === revision || s.graph.isAncestor(revision, h))) throw new Error('Revision is not in this root\'s history');
        if (c.variants.length === 1 && c.variants[0].some(id => { const r = s.graph.get(id); return r.contentHash === past.contentHash && r.dependencyHash === past.dependencyHash; })) throw new Error('The current head already has this content');
        const missing = Object.entries(past.dependencies).filter(([k, h]) => k.startsWith('pin:') ? false : k.startsWith('envelope:') ? !s.envelopePhysical(h).length : !s.hasBlob(h)).map(([k]) => k); // same test as plan()'s missingMaterial
        if (missing.length) throw Object.assign(new Error('Material of that revision is not in the sync store: ' + missing.join(', ')), { code: 'MISSING_MATERIAL', missing });
        const rev = makeRevision({ domain, type, root: rootId, parents: c.heads, content: past.content, dependencies: past.dependencies });
        await commitWithIntent(s, [rev], [root]);
        return { restored: rev.id, root, from: revision, parents: c.heads };
    }
    /** Local revisions the plan must materialize: the intent is durable BEFORE the store commit (a crash in between is recovered by
     *  the next plan). Only roots this call added are withdrawn, and only when the commit provably did not happen: an error after
     *  the revisions became durable (ambiguous write) keeps the intent. Never advances the applied lineage. */
    async function commitWithIntent(s, revisions, keys) {
        const added = keys.filter(k => !(service().localApply ?? []).includes(k));
        manifest.transact(x => { for (const key of keys) if (!x.localApply.includes(key)) x.localApply.push(key); });
        try { s.commit(revisions); }
        catch (error) {
            const durable = revisions.every(r => s.graph.get(r.id));
            if (!durable) manifest.transact(x => { x.localApply = x.localApply.filter(k => !added.includes(k)); });
            throw error;
        }
    }
    function trashList() { const s = requireEnabled(); return s.trash().map(t => { const r = s.graph.get(t.id); return { ...t, domain: r.domain, type: r.type, operation: r.tombstone.operation, cohort: s.graph.revisions().filter(x => x.tombstone?.operation === r.tombstone.operation).length }; }); }
    /** Restores the exact deletion cohort (core restore) and queues the roots for local materialization. */
    async function restoreTrash({ id }) {
        const s = requireEnabled(), batch = s.graph.restore(id);
        await commitWithIntent(s, batch, batch.map(r => `${r.domain}\n${r.type}\n${r.root}`));
        return { restored: batch.map(r => ({ root: r.root, type: r.type, revision: r.id })) };
    }
    /** The open chat kept through a remote deletion: publish its current state first, then un-delete or resolve, and keep its lineage. */
    async function restoreOpenDeletion({ chatId }) {
        const s = requireEnabled(); if (service().plan) throw new Error('Finish the pending sync apply first');
        await snapshot(); // the kept chat's current state (possibly edited since) becomes its own revision first
        const rootId = service().branches[chatId]?.root ?? chatId, key = `play\nchat\n${rootId}`, lineageKey = `${key}#${chatId}`, c = s.graph.classify(key);
        const own = service().lineage[lineageKey], ownRev = own ? s.graph.get(own) : null; // THIS chat's head (a sibling branch keeps its own)
        if (!ownRev || ownRev.tombstone) throw new Error('This chat has no recorded state to restore');
        // Only the deletions that hit THIS chat's lineage (their base is this head or one of its ancestors) are parented. A restore is
        // neither a conflict resolution nor a cohort restore: an unrelated concurrent sibling stays a live head and reaches every device
        // as its own branch, and another sibling's independent deletion stays in the trash, still recoverable.
        const relevant = c.tombstoneHeads.filter(id => { const base = s.graph.get(id)?.tombstone?.base; return base === own || (base && s.graph.isAncestor(base, own)); });
        if (!relevant.length) return { restored: [], state: c.state };
        const rev = makeRevision({ domain: 'play', type: 'chat', root: rootId, parents: [...(c.liveHeads.includes(own) ? [own] : []), ...relevant], content: ownRev.content, dependencies: ownRev.dependencies });
        s.commit([rev]);
        manifest.transact(x => { x.lineage[lineageKey] = rev.id; });
        recordLineage();
        return { restored: [{ root: rootId, type: 'chat', revision: rev.id }], state: s.graph.classify(key).state };
    }
    /** The user accepts the remote deletion of the chat that was kept open: its lineage goes; the client removes the chat locally. */
    function acceptOpenDeletion({ chatId }) { manifest.transact(x => { for (const k of Object.keys(x.lineage)) if (k.endsWith('#' + chatId)) delete x.lineage[k]; }); recordLineage(); return { accepted: chatId }; }
    /** The applied lineage travels with the canonical data: `risubard/nas-sync/lineage.json` is inside the app's backups (restored
     *  with them and read from the import staging before a restore publishes), and a bounded history of lineage blobs answers a DB
     *  snapshot restored by time. Called after every lineage change. */
    function recordLineage() {
        const s = openStore(), lineage = service().lineage, bytes = Buffer.from(canonical({ lineage }, true)), hash = sha256(bytes);
        if (service().lineageHistory?.at(-1)?.hash !== hash) {
            if (!s.hasBlob(hash)) { const tmp = join(root, 'lineage-' + hash); fs.writeFileSync(tmp, bytes); s.storeBlobFromFile(hash, tmp); fs.rmSync(tmp, { force: true }); }
            manifest.transact(x => { (x.lineageHistory ??= []).push({ at: now(), hash }); if (x.lineageHistory.length > 256) x.lineageHistory.splice(0, x.lineageHistory.length - 256); });
        }
        atomicWriteJson(dataRoot, LINEAGE_FILE, { version: 1, ...s.identity(), at: now(), lineage });
    }
    /** The app's own backup/snapshot restore announces itself BEFORE the data changes (durable intent, consumed by the snapshot
     *  that publishes the restored state). The intent carries the BASES recorded with the restored state — `lineage` from the
     *  backup's own lineage file, or the lineage history entry at `at` for a DB snapshot — or none (unknown origin → genesis).
     *  The snapshot then treats items absent from the restored state as not-deleted and continues present items from those bases,
     *  never from this install's newest heads, which survive as siblings. A stale mark over unchanged data is harmless. Copied data
     *  roots without the identity sidecar are still detected by the store's rotation; this covers restores that keep identity. */
    function markRestore({ source, restoreId, at = null, lineage = null }) {
        if (typeof restoreId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(restoreId)) throw new Error('Safe restore ID is required');
        let bases = null, basesFrom = 'none';
        if (lineage && typeof lineage === 'object' && !Array.isArray(lineage)) { bases = Object.fromEntries(Object.entries(lineage).filter(([k, v]) => typeof k === 'string' && typeof v === 'string')); basesFrom = 'recorded'; }
        else if (typeof at === 'number' && Number.isFinite(at)) {
            const entry = [...(service().lineageHistory ?? [])].reverse().find(e => e.at <= at);
            if (entry) { try { bases = JSON.parse(fs.readFileSync(openStore().blobFile(entry.hash), 'utf8')).lineage; basesFrom = 'history'; } catch { bases = null; } }
        }
        const mark = { id: restoreId, source: String(source ?? 'restore').slice(0, 64), at: now(), restoredAt: at, bases, basesFrom };
        manifest.transact(x => { x.pendingRestore = mark; });
        return mark;
    }
    /** A restore that failed before publishing anything withdraws its mark; a mark for another restore is left alone. */
    function clearRestore(restoreId) { manifest.transact(x => { if (x.pendingRestore?.id === restoreId) x.pendingRestore = null; }); }
    /** `role`: `authority` (the tablet whose state wins the initial bootstrap and which answers key requests) or `joining`. */
    function enable({ workspaceId, role }) {
        const s = openStore(); if (s.identity().workspaceId !== workspaceId) s.setWorkspace(workspaceId);
        if (role !== undefined && role !== 'authority' && role !== 'joining') throw new Error('Role must be authority or joining');
        manifest.transact(x => { x.enabled = true; x.role = role ?? x.role ?? 'authority'; x.workspaceId = s.identity().workspaceId; x.incarnation ??= s.identity().incarnationId; });
        return status();
    }
    /** Joining-device bootstrap: for every library/settings root where this device's own genesis revision diverges from the
     *  authority device's head, resolve to the authority content (parents: authority head + local genesis only). The local
     *  originals stay in the graph and are additionally archived, sealed, under recovery/bootstrap-<id>/. Chats are never
     *  touched here: differing chats remain automatic branches. */
    async function bootstrap({ authorityDevice }) {
        const s = requireEnabled(), v = await openVault();
        if (service().plan) throw new Error('Finish the pending sync apply before bootstrapping');
        const peerRevisions = new Set(Object.entries(s.state().peers).filter(([k]) => k.startsWith(authorityDevice + '/')).flatMap(([, p]) => Object.values(p.admittedRevisions ?? {}).flat()));
        const ownRevisions = new Set(s.state().commits.flatMap(c => c.revisions));
        const resolutions = [], originals = []; // joining originals, already in public form (secret version refs, no values) with their envelope ids
        for (const key of s.graph.rootKeys()) {
            const [domain, type, rootId] = key.split('\n'), c = s.graph.classify(key);
            if (key === 'settings\ngroup\nuserNote' || key === 'settings\ngroup\npersonas') continue;
            if (domain === 'play' || c.state !== 'diverged' || c.variants.length !== 2) continue;
            const authority = c.variants.map(variant => variant.find(id => peerRevisions.has(id))).find(Boolean);
            const joining = c.variants.flat().find(id => ownRevisions.has(id) && s.graph.get(id).parents.length === 0);
            if (!authority || !joining || authority === joining) continue;
            const rev = s.graph.get(joining);
            originals.push({ root: key, revision: joining, content: rev.content, envelopes: Object.fromEntries(Object.entries(rev.dependencies).filter(([k]) => k.startsWith('envelope:')).map(([, sem]) => [sem, s.envelopePhysical(sem)[0] ?? null])) });
            resolutions.push(s.graph.bootstrapResolution(authority, joining));
        }
        if (!resolutions.length) return { resolved: 0 };
        const id = randomUUID(), roots = resolutions.map(r => `${r.domain}\n${r.type}\n${r.root}`);
        atomicWriteJson(root, `recovery/bootstrap-${id}/originals.json`, { authorityDevice, at: now(), originals });
        // Durable intent before the store commit. The applied lineage is NOT advanced here: the canonical database still holds the
        // joining values until the client applies the resolution through plan → arm → finish, which records the lineage then.
        // Until that apply a snapshot finds the joining values equal to their recorded head and publishes nothing.
        manifest.transact(x => { x.pendingBootstrap = { id, authorityDevice, at: now(), roots, revisions: resolutions.map(r => r.id) }; });
        await hooks.beforeBootstrapCommit?.();
        const entry = s.commit(resolutions);
        await hooks.afterBootstrapCommit?.();
        manifest.transact(x => { x.bootstraps.push({ id, authorityDevice, at: now(), roots, commit: entry?.commitId ?? null }); x.pendingBootstrap = null; });
        return { resolved: resolutions.length, archive: `recovery/bootstrap-${id}/originals.json`, commit: entry ? { sequence: entry.sequence, commitId: entry.commitId } : null };
    }
    function disable() { manifest.transact(x => { x.enabled = false; }); return status(); }

    const readAsset = work => async path => {
        if (storage.kvGetUpdatedAt(path) === null) return null;
        const target = join(work, randomUUID());
        if (!await storage.kvExportFile(path, target)) return null;
        return { path: target, hash: await hashFile(target) };
    };
    const readInlaySource = work => async id => {
        const inlay = await readInlay(id);
        if (!inlay) return null;
        if (typeof inlay.data === 'string' || Buffer.isBuffer(inlay.data)) return inlay;
        const target = join(work, randomUUID()), digest = createHash('sha256');
        await pipeline(Readable.fromWeb(inlay.data.stream()), new Transform({ transform(chunk, _e, done) { digest.update(chunk); done(null, chunk); } }), fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
        return { metadata: inlay.metadata, data: { path: target, hash: digest.digest('hex') } };
    };
    const walkFiles = async (dir, prefix = '') => { const out = []; if (!fs.existsSync(dir)) return out; for (const e of (await fsp.readdir(dir, { withFileTypes: true })).sort((x, y) => compare(x.name, y.name))) { const p = join(dir, e.name); if (e.isDirectory()) out.push(...await walkFiles(p, prefix + e.name + '/')); else out.push({ path: prefix + e.name, file: p }); } return out; };
    const canonicalBardBytes = (path, bytes) => {
        // One canonical serialization for Bard JSON so every device hashes identical bytes; readers only JSON.parse these files.
        try {
            if (path.endsWith('.json')) return Buffer.from(canonical(JSON.parse(bytes.toString('utf8'))));
            if (path.endsWith('.jsonl')) { const lines = bytes.toString('utf8').split('\n'); return Buffer.from(lines.map((line, i) => { if (!line.trim()) return line; try { return canonical(JSON.parse(line)); } catch (error) { if (i === lines.length - 1) return line; throw error; } }).join('\n')); }
        } catch { /* leave unparsable bytes exactly as they are */ }
        return bytes;
    };
    const blockOf = async (capture, file, path) => { const bytes = canonicalBardBytes(path, await fsp.readFile(file)); const hash = sha256(bytes), entry = 'blobs/' + hash; if (!capture.blocks.has(entry)) { const target = join(dirname(capture.blocks.values().next().value ?? file), 'n-' + hash); await fsp.writeFile(target, bytes); capture.blocks.set(entry, target); } return { path, hash, entry, bytes: bytes.length }; };
    /** Sync payloads live in ROOT identity space: a locally materialized sibling branch (chat~seg, slot~seg) is relinked back to
     *  its root ids before hashing, with the same helper the receiver used, so all devices publish identical bytes. */
    async function normalizeCaptures(captures, db, branches, work) {
        for (const [chaId, capture] of captures) {
            const character = (db.characters ?? []).find(c => c.chaId === chaId);
            for (const workspace of capture.workspaces) {
                const branch = branches[workspace.sourceChatId];
                if (branch) {
                    const seg8 = sha256(branch.segment).slice(0, 8), chat = (character?.chats ?? []).find(ch => ch.id === workspace.sourceChatId);
                    const identities = { characters: new Map([[chaId, chaId]]), chats: new Map([[workspace.sourceChatId, branch.root]]), slots: new Map(workspace.slots.map(s => [s.sourceId, s.sourceId.endsWith('~' + seg8) ? s.sourceId.slice(0, -(seg8.length + 1)) : s.sourceId])), sources: new Map(), inlays: new Map(), assets: new Map(), hashes: new Map() };
                    sourceIdentityMap({ ...character, chaId }, [{ ...chat, id: workspace.sourceChatId }], chaId, identities);
                    const archive = { copyEntry: async (entry, path) => { await fsp.mkdir(dirname(path), { recursive: true }); await fsp.copyFile(capture.blocks.get(entry), path); } };
                    const mapped = await relinkWorkspace({ archive, workspace, directory: join(work, 'unlink-' + randomUUID()), identities, destinationChatId: branch.root });
                    workspace.files = []; for (const f of await walkFiles(mapped.current)) workspace.files.push(await blockOf(capture, f.file, f.path));
                    workspace.slots = [];
                    for (const slot of mapped.slots) {
                        const files = []; for (const f of await walkFiles(slot.directory)) files.push(await blockOf(capture, f.file, f.path));
                        const pages = []; for (const page of slot.pages) pages.push(await blockOf(capture, join(mapped.current, '..', 'pages', page.hash.slice(0, 2), page.hash), page.hash.slice(0, 2) + '/' + page.hash));
                        workspace.slots.push({ sourceId: slot.saveId, files, pages });
                    }
                    workspace.identities = identities;
                } else {
                    workspace.files = await Promise.all(workspace.files.map(f => blockOf(capture, capture.blocks.get(f.entry), f.path)));
                    for (const slot of workspace.slots) slot.files = await Promise.all(slot.files.map(f => blockOf(capture, capture.blocks.get(f.entry), f.path)));
                }
            }
        }
    }
    async function setCardOnlyUpload({ characterId, enabled } = {}) {
        requireEnabled();
        if (service().plan) throw new Error('진행 중인 동기화 적용이 끝난 뒤 설정해 주세요.');
        if (typeof characterId !== 'string' || typeof enabled !== 'boolean') throw new Error('캐릭터와 업로드 설정이 필요해요.');
        const db = await readDatabase();
        if (!db?.characters?.some(c => c.chaId === characterId)) throw new Error('캐릭터를 찾지 못했어요.');
        manifest.transact(x => { x.cardOnlyUploads = [...new Set([...(x.cardOnlyUploads ?? []).filter(id => id !== characterId), ...(enabled ? [characterId] : [])])]; });
        return status();
    }
    // Omitting chat bodies is an upload preference, never a deletion or an empty-chat replacement.
    function cardOnlyProjection(db, s) {
        const memberships = new Map(), preserved = new Set();
        const characters = (db.characters ?? []).map(c => {
            if (!(service().cardOnlyUploads ?? []).includes(c.chaId)) return c;
            const key = `library\ncharacter\n${c.chaId}`, known = service().lineage[key + '#' + c.chaId];
            const ids = new Set([...(known ? s.graph.get(known)?.content?.chatIds ?? [] : []),
                ...s.graph.classify(key).liveHeads.flatMap(id => s.graph.get(id)?.content?.chatIds ?? [])]);
            memberships.set(c.chaId, [...ids]);
            for (const chat of c.chats ?? []) ids.add(service().branches[chat.id]?.root ?? chat.id);
            for (const id of ids) preserved.add(`play\nchat\n${id}`);
            return { ...c, chats: [] };
        });
        return { database: { ...db, characters }, memberships, preserved };
    }
    /** Snapshot: hydrated canonical DB → changed revisions committed with their blobs. Rejects while a plan is active. */
    async function snapshot() {
        const s = requireEnabled(), v = await openVault();
        if (service().plan) throw Object.assign(new Error('Finish the pending sync apply before taking a snapshot'), { code: 'NAS_SYNC_PLAN_PENDING' });
        const original = await readDatabase();
        if (!original) throw new Error('Database unavailable');
        const { database: db, memberships, preserved } = cardOnlyProjection(original, s);
        const work = await fsp.mkdtemp(join(root, 'snapshot-')), captures = new Map(), cleanups = [];
        try {
            for (const character of db.characters ?? []) {
                const chatIds = (character.chats ?? []).map(c => c.id).filter(Boolean);
                if (!chatIds.length) continue;
                const capture = await memory.capturePlaySetMemory({ characterId: character.chaId, chatIds, temporaryDirectory: work });
                captures.set(character.chaId, capture); cleanups.push(capture.cleanup);
            }
            await normalizeCaptures(captures, db, service().branches, work);
            const projection = await projectDatabase({ database: db, cardOnlyMemberships: memberships, vault: v, captures, materials: playSetMemoryMaterials, branches: service().branches, readAsset: readAsset(work), readInlay: readInlaySource(work), inlayMeta, readColdChat, remapBranchChat: (value, workspace) => workspace?.identities ? remapBardChat(value, workspace.identities) : value });
            if (projection.missing.length) throw Object.assign(new Error('Snapshot is missing referenced material: ' + projection.missing.map(m => m.reason).join('; ')), { code: 'SNAPSHOT_MISSING', missing: projection.missing });
            const lineage = service().lineage, restoreMark = service().pendingRestore ?? null;
            const restored = !!restoreMark || (service().incarnation !== null && service().incarnation !== s.identity().incarnationId && /sidecar/.test(s.state().rotations.at(-1)?.reason ?? ''));
            // A restored state continues the bases recorded with it (or starts genesis roots), never this install's newest heads: a copied
            // data root carries its own lineage in this manifest; an in-place restore carries it in the mark.
            const diff = diffProjection(s.graph, projection.desired, restoreMark ? (restoreMark.bases ?? {}) : lineage, { restore: restored });
            // Items this device knew that vanished locally become causal tombstones in one operation; a deleted character takes
            // the chats it owned (its last known membership) with it as the same deletion cohort.
            // Deletions are causal against what THIS device observed: the tombstone's base is the device's lineage head, never a
            // pulled-but-unapplied peer head. A deleted character takes only the chats whose observed head is still a live head of
            // theirs (no newer unseen edit); otherwise the child stays and the container becomes delete-pending.
            // A restored backup (store rotated its incarnation because the protected sidecar was missing) is a snapshot of an older
            // state: items absent from it are NOT deletions; their lineage is dropped and the recorded bases keep edits causal.
            if (diff.diverged.length) throw Object.assign(new Error('Local items lost their lineage; resolve before snapshot: ' + diff.diverged.join(', ')), { code: 'LINEAGE_LOST', diverged: diff.diverged });
            const present = new Set([...projection.desired.map(d => d.lineageKey), ...Object.keys(lineage).filter(k => preserved.has(k.split('#')[0]))]), operation = `snapshot-${randomUUID()}`, tombstones = new Map();
            const vanished = restored ? [] : Object.entries(lineage).filter(([k, head]) => !present.has(k) && s.graph.get(head) && !s.graph.get(head).tombstone && !k.startsWith('settings\n'));
            const dropped = restored ? Object.keys(lineage).filter(k => !present.has(k)) : [];
            const tombstoneOf = (key, observed) => {
                const [domain, type, rootId] = key.split('\n'), c = s.graph.classify(key), rev = s.graph.get(observed);
                if (tombstones.has(key) || !rev || rev.tombstone) return;
                const variant = c.variants.find(v => v.includes(observed));
                tombstones.set(key, makeRevision({ domain, type, root: rootId, parents: variant ?? [observed], tombstone: { operation, base: observed } }));
            };
            for (const [lineageKey, head] of vanished) {
                const key = lineageKey.split('#')[0], type = key.split('\n')[1];
                tombstoneOf(key, head);
                if (type === 'character') for (const chatRoot of s.graph.get(head).content.chatIds ?? []) {
                    const ck = `play\nchat\n${chatRoot}`, observedChild = Object.entries(lineage).find(([k]) => k.startsWith(ck + '#'))?.[1];
                    if (!observedChild || [...present].some(k => k.startsWith(ck + '#'))) continue;
                    if (s.graph.classify(ck).liveHeads.includes(observedChild)) tombstoneOf(ck, observedChild); // unseen newer child edit → child survives, container delete-pending
                }
            }
            const targets = tombstones;
            const revisions = [...diff.revisions, ...tombstones.values()];
            if (!revisions.length) { if (restored || dropped.length) { manifest.transact(x => { for (const k of dropped) delete x.lineage[k]; if (restoreMark) for (const [k, id] of Object.entries(diff.matched)) x.lineage[k] = id; x.incarnation = s.identity().incarnationId; if (restoreMark && x.pendingRestore?.id === restoreMark.id) x.pendingRestore = null; }); recordLineage(); } return { committed: null, skipped: diff.skipped.length, excluded: projection.excluded.length, provenance: restored ? 'restored-backup' : 'edit', restore: restoreMark }; }
            const blobs = {};
            for (const h of new Set([...revisions.flatMap(r => Object.entries(r.dependencies).filter(([k]) => !k.startsWith('envelope:')).map(([, x]) => x)), ...projection.envelopes.values()])) {
                const source = projection.blobs.get(h); if (!source) continue;
                if (source.path) blobs[h] = source.path; else { blobs[h] = join(work, h); await fsp.writeFile(blobs[h], source.bytes); }
            }
            const intent = { lineage: {}, vanished: [...vanished.map(([k]) => k), ...dropped], provenance: restored ? 'restored-backup' : 'edit', restore: restoreMark, revisions: revisions.map(r => r.id) };
            if (restoreMark) for (const [k, id] of Object.entries(diff.matched)) intent.lineage[k] = id; // a restored item equal to a head returns its lineage there
            for (const d of projection.desired) { const rev = diff.revisions.find(r => r.root === d.root && r.type === d.type && r.domain === d.domain && r.contentHash === d.contentHash && r.dependencyHash === d.dependencyHash); if (rev) intent.lineage[d.lineageKey] = rev.id; }
            manifest.transact(x => { x.pendingLineage = intent; }); // durable intent BEFORE the store commit
            await hooks.beforeSnapshotCommit?.(intent);
            const entry = s.commit(revisions, { blobs, envelopes: Object.fromEntries(projection.envelopes) });
            await hooks.afterSnapshotCommit?.(entry);
            manifest.transact(x => { for (const [k, id] of Object.entries(intent.lineage)) x.lineage[k] = id; for (const k of intent.vanished) delete x.lineage[k]; x.pendingLineage = null; x.incarnation = s.identity().incarnationId; if (intent.restore && x.pendingRestore?.id === intent.restore.id) x.pendingRestore = null; });
            recordLineage();
            return { committed: entry ? { sequence: entry.sequence, commitId: entry.commitId, revisions: entry.revisions.length, tombstones: targets.size } : null, skipped: diff.skipped.length, excluded: projection.excluded.length, provenance: intent.provenance, restore: intent.restore };
        } finally { for (const cleanup of cleanups) await cleanup().catch(() => {}); await fsp.rm(work, { recursive: true, force: true }); }
    }

    // ------------------------------------------------------------------ apply ------------------------------------------------------------------
    const readBlobJson = (s, h) => JSON.parse(fs.readFileSync(s.blobFile(h), 'utf8'));
    /** Every cached ciphertext for a semantic id is verified (identity + authenticated decryption) before use. */
    const verifiedEnvelope = (s, v, semantic) => { for (const h of s.envelopePhysical(semantic)) { try { const env = readBlobJson(s, h); if (envelopeIdentity(env) === semantic) { v.open(env); return env; } } catch { /* next */ } } return null; };
    const envelopesFor = (s, v, rev) => Object.entries(rev.dependencies).filter(([k]) => k.startsWith('envelope:')).map(([, semantic]) => verifiedEnvelope(s, v, semantic)).filter(Boolean);
    /** Secrets are resolved only in memory. Library items are applied inside their inventory wrapper so full paths resolve. */
    function materialize(v, kind, content, envelopes, current) {
        const refs = content[REFS]; if (!refs) return { applied: true, value: content };
        const body = { ...content }; delete body[REFS];
        const wrap = kind === 'character' ? x => ({ characters: [x] }) : kind === 'plugin' ? x => ({ plugins: [x] }) : kind === 'module' ? x => ({ modules: [x] }) : x => x;
        const unwrap = kind === 'character' ? x => x.characters[0] : kind === 'plugin' ? x => x.plugins[0] : kind === 'module' ? x => x.modules[0] : x => x;
        const result = v.apply({ ...wrap(body), [REFS]: refs }, envelopes, current);
        return result.applied ? { applied: true, value: unwrap(result.value) } : result;
    }
    /** Seal records for disk: the vault inventory addresses DATABASE-ROOT keys, so settings are projected at the root
     *  together with modules/plugins/characters, then split back. Envelope ciphertexts go to the blob store; the journal
     *  keeps only their hashes. `chats` never carry inventory secrets and are stored as given. */
    const COLLECTION_KEYS = ['modules', 'plugins', 'characters'];
    async function sealRecord(s, v, { settings = {}, modules = [], plugins = [], characters = [], chats = [] }, work) {
        const { public: pub, envelopes } = v.project({ ...settings, modules, plugins, characters });
        const mapping = {};
        for (const env of envelopes) { const bytes = Buffer.from(canonical(env)), h = sha256(bytes), path = join(work, h); if (!s.hasBlob(h)) { await fsp.writeFile(path, bytes); s.storeBlobFromFile(h, path); } mapping[envelopeIdentity(env)] = h; }
        const sealedSettings = Object.fromEntries(Object.entries(pub).filter(([k]) => !COLLECTION_KEYS.includes(k) && k !== REFS));
        return { settings: sealedSettings, modules: pub.modules, plugins: pub.plugins, characters: pub.characters, chats, secretRefs: pub[REFS] ?? [], envelopes: mapping };
    }
    /** Inverse of sealRecord with verified envelopes; throws VAULT_PENDING when this device's key cannot open them. */
    function unsealRecord(s, v, sealed) {
        const envelopes = Object.values(sealed.envelopes ?? {}).map(h => { try { const env = readBlobJson(s, h); v.open(env); return env; } catch { return null; } }).filter(Boolean);
        const applied = v.apply({ ...sealed.settings, modules: sealed.modules ?? [], plugins: sealed.plugins ?? [], characters: sealed.characters ?? [], [REFS]: sealed.secretRefs ?? [] }, envelopes, null);
        if (!applied.applied) throw Object.assign(new Error('Sealed record cannot be opened with this vault key'), { code: 'VAULT_PENDING', pending: applied.pending });
        const { modules, plugins, characters, ...settings } = applied.value;
        return { settings, modules, plugins, characters, chats: sealed.chats ?? [] };
    }
    /** Build an apply plan from admitted-but-unapplied commits; idempotent while a plan is active. Returns the sealed plan. */
    /** Read-only view for the client's safe-window decision: which roots the admitted-but-unapplied commits (and queued local
     *  resolutions) would touch, with the local chat ids a chat root maps to (branches included). No plan, no lock, nothing consumed. */
    function pendingRoots() {
        const s = requireEnabled(), branches = service().branches ?? {}, roots = new Map();
        const add = key => { if (roots.has(key)) return; const [domain, type, root] = key.split('\n'); const entry = { domain, type, root };
            if (domain === 'play' && type === 'chat') entry.chatIds = [root, ...Object.entries(branches).filter(([, b]) => b.root === root).map(([id]) => id)];
            roots.set(key, entry); };
        for (const p of s.pendingApply()) for (const id of p.revisions ?? []) { const r = s.graph.get(id); if (r) add(`${r.domain}\n${r.type}\n${r.root}`); }
        for (const key of service().localApply ?? []) add(key);
        return { roots: [...roots.values()], plan: service().plan ? service().plan.transaction : null };
    }
    async function plan() {
        const s = requireEnabled(), v = await openVault();
        if (service().plan) return materializePlan(s, v, readPlan(service().plan.transaction)); // retry: same authenticated in-memory payload
        const pending = s.pendingApply().sort((a, b) => compare(a.device, b.device) || compare(a.incarnation, b.incarnation) || a.sequence - b.sequence);
        if (!pending.length && !(service().localApply ?? []).length) return { empty: true, pending: [] };
        const db = await readDatabase(); if (!db) throw new Error('Database unavailable');
        const transaction = randomUUID(), staging = join(root, 'apply', transaction), work = join(staging, 'work');
        await fsp.mkdir(work, { recursive: true, mode: 0o700 });
        const touched = new Map();
        for (const p of pending) for (const id of p.revisions ?? []) { const r = s.graph.get(id); if (r) touched.set(`${r.domain}\n${r.type}\n${r.root}`, true); }
        for (const key of service().localApply ?? []) touched.set(key, true); // local conflict resolutions / trash restores awaiting materialization
        const lineage = service().lineage, branches = service().branches;
        // A local item that differs from its recorded head carries an edit no snapshot has published yet. Such a root is never
        // overwritten: it stays pending until the next snapshot turns the edit into its own causal revision (then both heads meet
        // as branches or a conflict), and the commits that touch it are not acknowledged.
        const localEdits = await unsnapshottedRoots(s, v, db, touched);
        // Merge only captured revisions. Unpublished local edits, real persona conflicts and overlapping Wiki edits stay protected.
        for (const key of touched.keys()) {
            if (localEdits.has(key)) continue;
            if (key === 'settings\ngroup\npersonas' && !personaMirrorsMatch(db)) continue;
            const c = s.graph.classify(key);
            if (c.state !== 'diverged') continue;
            const heads = c.liveHeads.map(id => s.graph.get(id));
            const merged = key === 'settings\ngroup\npersonas' ? mergePersonaHeads(s.graph, heads, undefined, collectReferences) : null;
            if (merged) { const [domain, type, rootId] = key.split('\n'); await commitWithIntent(s, [makeRevision({ domain, type, root: rootId, parents: c.heads, ...merged })], [key]); }
        }
        const result = { transaction, workspaceId: s.identity().workspaceId, phase: 'preparing', createdAt: now(), commits: [], appliedRoots: [], pending: [],
            settings: {}, pluginEnabled: null, modules: [], plugins: [], characters: [], newCharacters: [], chats: [], deletions: [], before: null, lineage: {}, branches: {}, workspaces: [], media: [], expected: null, progress: { workspaces: {}, acked: [] } };
        const before = { settings: {}, chats: [], characters: [], modules: [], plugins: [] };
        const localChatsOf = rootId => { const ids = [rootId, ...Object.entries(branches).filter(([, b]) => b.root === rootId).map(([id]) => id)]; return (db.characters ?? []).flatMap(c => (c.chats ?? []).filter(ch => ids.includes(ch.id)).map(ch => ({ character: c, chat: ch }))); };
        // Envelope material counts as present when any ciphertext exists; whether THIS key can open it is the vault's verdict (pending 'vault').
        const missingMaterial = rev => Object.entries(rev.dependencies).filter(([k, h]) => k.startsWith('pin:') ? false : k.startsWith('envelope:') ? !s.envelopePhysical(h).length : !s.hasBlob(h)).map(([k]) => k);
        /** Media collisions are detected by content hash: same path/id with other bytes makes the root pending. */
        const mediaFor = async (rev, rootKey) => {
            const items = [];
            for (const [k, h] of Object.entries(rev.dependencies)) {
                if (k.startsWith('asset:')) { const key = k.slice(6); if (storage.kvGetUpdatedAt(key) !== null) { const tmp = join(work, randomUUID()); await storage.kvExportFile(key, tmp); if (await hashFile(tmp) !== h) return { collision: key }; } else items.push({ kind: 'asset', key, hash: h }); }
                else if (k.startsWith('inlay:')) { const id = k.slice(6), existing = await readInlay(id); if (existing) { const bytes = typeof existing.data === 'string' ? Buffer.from(existing.data) : Buffer.isBuffer(existing.data) ? existing.data : Buffer.from(await existing.data.arrayBuffer()); if (sha256(bytes) !== h) return { collision: id }; } else items.push({ kind: 'inlay', id, hash: h, metadata: rev.dependencies['inlay-metadata:' + id] ?? null, owner: rootKey.startsWith('play\nchat\n') ? { root: rootKey.split('\n')[2] } : null }); }
            }
            return { items };
        };
        const applyRoot = (key, head) => { result.appliedRoots.push(key); };
        /** The database as it will look after this plan's library/settings changes (for dependency pin checks). */
        const planView = (base, r) => {
            const view = clone(base);
            for (const [k, v] of Object.entries(r.settings)) { if (v === null) delete view[k]; else view[k] = v; }
            for (const item of r.modules.map(clone)) { view.modules ??= []; const i = view.modules.findIndex(m => m.id === item.id); if (i >= 0) view.modules[i] = item; else view.modules.push(item); }
            for (const item of r.plugins.map(clone)) { view.plugins ??= []; const i = view.plugins.findIndex(p => p.name === item.name); if (i >= 0) view.plugins[i] = item; else view.plugins.push(item); } // clones: the view must never mutate plan items
            if (r.pluginEnabled) for (const p of view.plugins ?? []) if (p.name in r.pluginEnabled) p.enabled = r.pluginEnabled[p.name];
            for (const u of r.characters) { const t = (view.characters ?? []).find(c => c.chaId === u.chaId); if (t) Object.assign(t, u.fields); }
            for (const n of r.newCharacters) if (!(view.characters ?? []).some(c => c.chaId === n.chaId)) { const { chatIds: _ids, ...rest } = n; (view.characters ??= []).push({ ...rest, chats: [] }); }
            for (const d of r.deletions) { if (d.kind === 'module') view.modules = (view.modules ?? []).filter(m => m.id !== d.id); if (d.kind === 'plugin') view.plugins = (view.plugins ?? []).filter(p => p.name !== d.id); if (d.kind === 'character') view.characters = (view.characters ?? []).filter(c => c.chaId !== d.id); }
            return view;
        };
        // Settings groups and library items.
        for (const key of touched.keys()) {
            const [domain, type, rootId] = key.split('\n'), c = s.graph.classify(key);
            if (domain === 'play') continue;
            if (key === 'settings\ngroup\nuserNote') { applyRoot(key); continue; }
            if (localEdits.has(key)) { result.pending.push({ root: key, reason: 'local-edit' }); continue; }
            if (c.state === 'diverged') { result.pending.push({ root: key, reason: 'diverged', variants: c.variants.length }); continue; }
            if (c.state === 'deleted') {
                if (type === 'character') {
                    // A container is removed only when no child it owned survived the deletion cohort (unseen concurrent child edits keep it delete-pending).
                    const operation = s.graph.get(c.tombstoneHeads[0]).tombstone.operation;
                    if (s.graph.containerState(key, operation) === 'delete-pending') { result.pending.push({ root: key, reason: 'delete-pending', operation }); continue; }
                    const existing = (db.characters ?? []).find(x => x.chaId === rootId); if (existing) { result.deletions.push({ kind: 'character', id: rootId }); before.characters.push(clone(existing)); }
                }
                else if (type !== 'group') { const col = type + 's', existing = (db[col] ?? []).find(i => (type === 'plugin' ? i.name : i.id) === rootId); if (existing) { result.deletions.push({ kind: type, id: rootId }); before[col].push(clone(existing)); } }
                applyRoot(key); result.lineage[key + '#' + rootId] = c.tombstoneHeads[0]; continue;
            }
            const head = s.graph.get(c.liveHeads[0]), missing = missingMaterial(head);
            if (missing.length) { result.pending.push({ root: key, reason: 'missing material', missing }); continue; }
            const media = await mediaFor(head, key); if (media.collision) { result.pending.push({ root: key, reason: 'media collision', item: media.collision }); continue; }
            const content = clone(head.content);
            if (domain === 'settings') {
                if (rootId === 'personas' && !personaMirrorsMatch(db)) { result.pending.push({ root: key, reason: 'local-persona-edit' }); continue; }
                if (rootId === 'personas' && !lineage[key + '#personas'] && (db.personas ?? []).some(p => !(content.personas ?? []).some(incoming => incoming.id === p.id && hashJson(incoming) === hashJson(p)))) {
                    result.pending.push({ root: key, reason: 'local-edit' }); continue;
                }
                if (rootId === 'personas') for (const key of PERSONA_MIRRORS) delete content[key];
                const current = Object.fromEntries(Object.keys(content).filter(k => k !== REFS && k !== 'pluginEnabled').map(k => [k, db[k]]));
                const m = materialize(v, 'settings', content, envelopesFor(s, v, head), current);
                if (!m.applied) { result.pending.push({ root: key, reason: 'vault', pending: m.pending }); continue; }
                for (const [k, value] of Object.entries(m.value)) { if (k === 'pluginEnabled') result.pluginEnabled = value; else { result.settings[k] = value; before.settings[k] = k in db ? db[k] : null; } }
                for (const k of GROUP_KEYS[`settings:${rootId}`] ?? []) if (!(rootId === 'personas' && PERSONA_MIRRORS.includes(k)) && !(k in content) && k in db) { result.settings[k] = null; before.settings[k] = db[k]; }
                if (rootId === 'personas' && Array.isArray(m.value.personas)) {
                    const ids = new Set(m.value.personas.map(p => p.id));
                    result.settings.personas = [...(db.personas ?? []).filter(p => ids.has(p.id)).map(p => m.value.personas.find(x => x.id === p.id)), ...m.value.personas.filter(p => !(db.personas ?? []).some(x => x.id === p.id))];
                    for (const [k, value] of Object.entries(personaSelection(db, result.settings.personas))) { result.settings[k] = value; before.settings[k] = k in db ? db[k] : null; }
                }
            } else if (type === 'character') {
                const existing = (db.characters ?? []).find(x => x.chaId === rootId);
                const m = materialize(v, 'character', content, envelopesFor(s, v, head), existing ?? null);
                if (!m.applied) { result.pending.push({ root: key, reason: 'vault', pending: m.pending }); continue; }
                const { chatIds, ...fields } = m.value;
                if (existing) { before.characters.push(clone(existing)); result.characters.push({ chaId: rootId, fields, chatIds }); }
                else result.newCharacters.push({ ...fields, chaId: rootId, chats: [], chatPage: 0, chatIds });
            } else {
                const col = type + 's', existing = (db[col] ?? []).find(i => (type === 'plugin' ? i.name : i.id) === rootId);
                const m = materialize(v, type, content, envelopesFor(s, v, head), existing ?? null);
                if (!m.applied) { result.pending.push({ root: key, reason: 'vault', pending: m.pending }); continue; }
                if (existing) before[col].push(clone(existing));
                result[col].push(type === 'plugin' ? { ...m.value, enabled: existing?.enabled ?? false } : m.value);
            }
            result.media.push(...media.items); applyRoot(key); result.lineage[key + '#' + rootId] = head.id;
        }
        // settings:activation owns every plugin's enabled flag (the plugin record carries none). While a named plugin's record is not here
        // (vault-pending or missing) and not in this plan either, the group waits: otherwise the client could apply only the flags of present
        // plugins, the saved state would not verify (finish → PARTIAL), and the absent plugin's flag would be lost once its record arrived.
        const activationKey = 'settings\ngroup\nactivation';
        if (result.pluginEnabled && result.appliedRoots.includes(activationKey)) {
            const removed = new Set(result.deletions.filter(d => d.kind === 'plugin').map(d => d.id)); // deleted by this plan: absent after the save
            const present = new Set([...(db.plugins ?? []).map(p => p.name).filter(name => !removed.has(name)), ...result.plugins.map(p => p.name)]);
            const absent = Object.keys(result.pluginEnabled).filter(name => !present.has(name));
            if (absent.length) {
                for (const k of GROUP_KEYS['settings:activation'] ?? []) { delete result.settings[k]; delete before.settings[k]; }
                result.pluginEnabled = null; result.appliedRoots = result.appliedRoots.filter(k => k !== activationKey); delete result.lineage[activationKey + '#activation'];
                result.pending.push({ root: activationKey, reason: 'plugin-pending', pending: absent });
            }
        }
        // Chats: linear continuation updates the local chat; other variants become stable sibling branches with relinked Bard material.
        const chatOwner = new Map();
        for (const character of db.characters ?? []) for (const ch of character.chats ?? []) chatOwner.set(ch.id, character.chaId);
        for (const row of result.characters) for (const id of row.chatIds) chatOwner.set(id, row.chaId);
        for (const row of result.newCharacters) for (const id of row.chatIds) chatOwner.set(id, row.chaId);
        // A chat restored from the trash is no longer in its owner's CURRENT membership: the owner is the character whose recorded
        // membership history (typed `chatIds` content of its revisions) listed the chat; a character still present locally wins.
        const ownerFromHistory = chatRoot => {
            const owners = [...new Set(s.graph.revisions().filter(r => r.type === 'character' && (r.content?.chatIds ?? []).includes(chatRoot)).map(r => r.root))];
            return owners.find(id => (db.characters ?? []).some(c => c.chaId === id) || result.newCharacters.some(c => c.chaId === id)); // a pending (e.g. vault) owner leaves the chat 'owner unknown'
        };
        // Pins are compared in the same secret-stripped public form the sender used, on the database as this plan will leave it.
        const futureView = v.project(planView(db, result)).public;
        for (const key of touched.keys()) {
            const [domain, type, rootId] = key.split('\n');
            if (domain !== 'play' || type !== 'chat') continue;
            if (localEdits.has(key)) { result.pending.push({ root: key, reason: 'local-edit' }); continue; }
            const c = s.graph.classify(key), locals = localChatsOf(rootId);
            if (c.state === 'deleted') { for (const { character, chat } of locals) { result.deletions.push({ kind: 'chat', characterId: character.chaId, id: chat.id }); before.chats.push({ characterId: character.chaId, chat: clone(chat) }); } applyRoot(key); result.lineage[key + '#' + rootId] = c.tombstoneHeads[0]; continue; }
            // Delete-pending (a deletion and an unseen live edit coexist): the live edit is kept and offered as a branch; nothing is removed.
            if (c.state === 'delete-pending' && !locals.length && !(db.characters ?? []).some(x => x.chaId === chatOwner.get(rootId))) { result.pending.push({ root: key, reason: 'delete-pending', heads: c.liveHeads }); continue; }
            if (c.variants.length > 1 && c.state === 'diverged' && chatDifference(c.liveHeads.map(id => s.graph.get(id))).sameMessages) {
                result.pending.push({ root: key, reason: 'same-messages', variants: c.variants.length }); continue;
            }
            const segments = s.graph.branchSegments(key), taken = new Set(locals.map(l => l.chat.id)); // local ids in use, including the ones this plan assigns
            let rootApplied = true;
            for (const variant of c.variants) {
                const head = s.graph.get(variant[0]), missing = missingMaterial(head);
                if (missing.length) { result.pending.push({ root: key, head: head.id, reason: 'missing material', missing }); rootApplied = false; continue; }
                // A local chat continues exactly ONE variant: the one on its own branch segment (the deterministic chain that
                // inherited its segment). Every other concurrent child gets a distinct stable sibling id, so no branch is lost.
                const segment = segments.get(head.id) ?? rootId;
                const continuing = locals.find(({ chat }) => { const known = lineage[key + '#' + chat.id]; return known && (segments.get(known) ?? rootId) === segment && variant.some(id => id === known || s.graph.isAncestor(known, id)); });
                // Local ids are device-local: the first variant that finds the root id free takes it (a restore gets its familiar id back), every
                // other variant gets its deterministic segment id; ids assigned earlier in this plan are reserved, never reused.
                const localId = continuing ? continuing.chat.id : (!taken.has(rootId) ? rootId : `${rootId}~${sha256(segment).slice(0, 8)}`);
                if (!continuing && taken.has(localId)) { result.pending.push({ root: key, head: head.id, reason: 'local id collision', localId }); rootApplied = false; continue; }
                taken.add(localId);
                const characterId = continuing?.character.chaId ?? chatOwner.get(rootId) ?? chatOwner.get(localId) ?? ownerFromHistory(rootId);
                if (!characterId) { result.pending.push({ root: key, head: head.id, reason: 'owner unknown' }); rootApplied = false; continue; }
                const knownHead = continuing ? s.graph.get(lineage[key + '#' + continuing.chat.id]) : null;
                if (knownHead && (variant.includes(knownHead.id) || (knownHead.contentHash === head.contentHash && knownHead.dependencyHash === head.dependencyHash))) { result.lineage[key + '#' + localId] = head.id; continue; } // already at this head or equal content: nothing to apply
                const media = await mediaFor(head, key); if (media.collision) { result.pending.push({ root: key, head: head.id, reason: 'media collision', item: media.collision }); rootApplied = false; continue; }
                let content = clone(head.content); content.id = localId;
                // Exact dependency compatibility: every pinned item must be active locally with exactly the pinned content once this
                // plan has applied its own library/settings updates; a conflicting or pending dependency blocks the chat, not the batch.
                const ownerView = (futureView.characters ?? []).find(x => x.chaId === characterId);
                const pins = Object.entries(head.dependencies).filter(([k]) => k.startsWith('pin:'));
                const mismatch = ownerView ? pins.filter(([k, h]) => localPins(futureView, ownerView, content)[k] !== h).map(([k]) => k) : pins.map(([k]) => k);
                if (mismatch.length) { result.pending.push({ root: key, head: head.id, reason: 'dependency', pins: mismatch }); rootApplied = false; continue; }
                // Bard workspace from dependencies; sibling branches are relinked (chat/slot identities, evidence, hashes) with the existing helper.
                const workspace = { characterId, chatId: localId, files: [], slots: {}, pages: [], relinked: false };
                for (const [k, h] of Object.entries(head.dependencies)) {
                    const bytes = s.hasBlob(h) ? fs.statSync(s.blobFile(h)).size : 0;
                    if (k.startsWith('bard:')) workspace.files.push({ path: k.slice(5), hash: h, entry: 'blobs/' + h, bytes });
                    else if (k.startsWith('slot:')) { const [, saveId, ...rest] = k.split(':'); (workspace.slots[saveId] ??= { files: [], pages: [] }).files.push({ path: rest.join(':'), hash: h, entry: 'blobs/' + h, bytes }); }
                    else if (k.startsWith('page:')) workspace.pages.push({ hash: h, entry: 'blobs/' + h, bytes });
                }
                for (const slot of Object.values(workspace.slots)) slot.pages = workspace.pages;
                if (localId !== rootId) {
                    const identities = { characters: new Map([[characterId, characterId]]), chats: new Map([[rootId, localId]]), slots: new Map(Object.keys(workspace.slots).map(id => [id, `${id}~${sha256(segment).slice(0, 8)}`])), sources: new Map(), inlays: new Map(), assets: new Map(), hashes: new Map() };
                    const owner = (db.characters ?? []).find(x => x.chaId === characterId) ?? result.newCharacters.find(x => x.chaId === characterId) ?? { chaId: characterId };
                    sourceIdentityMap({ ...owner, chaId: characterId }, [{ ...content, id: rootId }], characterId, identities);
                    const archive = { copyEntry: async (entry, path) => { await fsp.mkdir(dirname(path), { recursive: true }); await fsp.copyFile(s.blobFile(entry.slice(6)), path); } };
                    const dir = join(staging, 'relink-' + randomUUID());
                    const mapped = await relinkWorkspace({ archive, workspace: { files: workspace.files, slots: Object.entries(workspace.slots).map(([sourceId, slot]) => ({ sourceId, files: slot.files, pages: slot.pages })) }, directory: dir, identities, destinationChatId: localId, media: content.risuTransferMedia });
                    content = mapped.chat(content);
                    workspace.relinked = true; workspace.current = relative(root, mapped.current); workspace.relinkedSlots = mapped.slots.map(x => ({ saveId: x.saveId, directory: relative(root, x.directory), pages: x.pages }));
                    result.branches[localId] = { root: rootId, segment };
                }
                if (continuing) before.chats.push({ characterId, chat: clone(continuing.chat) });
                if (workspace.files.length || Object.keys(workspace.slots).length) result.workspaces.push(workspace);
                for (const item of media.items) if (item.kind === 'inlay') item.owner = { root: rootId, characterId, chatId: localId }; // ownership follows the materialized chat
                result.media.push(...media.items);
                result.chats.push({ characterId, chat: content, update: !!continuing, root: rootId, head: head.id });
                result.lineage[key + '#' + localId] = head.id;
            }
            if (rootApplied) applyRoot(key);
        }
        const planned = result.chats.length + Object.keys(result.settings).length + result.characters.length + result.newCharacters.length + result.modules.length + result.plugins.length + result.deletions.length + (result.pluginEnabled ? 1 : 0);
        if (!planned && !result.appliedRoots.length) { await fsp.rm(staging, { recursive: true, force: true }); return { empty: true, pending: result.pending }; }
        // Only commits whose every root was planned are acknowledged at finish; the rest stay pending for a later plan.
        const appliedRoots = new Set(result.appliedRoots);
        result.commits = pending.filter(p => (p.revisions ?? []).every(id => { const r = s.graph.get(id); return r && appliedRoots.has(`${r.domain}\n${r.type}\n${r.root}`); })).map(({ device, incarnation, sequence, commitId }) => ({ device, incarnation, sequence, commitId }));
        // Sealed recovery copy and sealed plan journal; media staged (immutable, hash-checked) before the client sees the plan.
        atomicWriteJson(root, `recovery/${transaction}/before.json`, await sealRecord(s, v, before, work));
        for (const item of new Map(result.media.map(i => [i.kind + ':' + (i.key ?? i.id), i])).values()) {
            if (item.kind === 'inlay') {
                const meta = item.metadata ? readBlobJson(s, item.metadata) : { metadata: {}, ownership: null }, name = 'inlay-' + randomUUID();
                await fsp.copyFile(s.blobFile(item.hash), join(staging, name));
                const ownership = meta.ownership ? { ...meta.ownership, ...(item.owner?.chatId && meta.ownership.chatId === item.owner.root ? { chatId: item.owner.chatId } : {}), ...(item.owner?.characterId ? { charId: item.owner.characterId } : {}) } : null;
                await installInlay({ id: item.id, metadata: meta.metadata, file: name, ownership }, staging); item.installed = true;
            } else {
                // The KV import CONSUMES its source file (file-kv moves/unlinks it). Hand it a staged copy, never the admitted blob:
                // the blob stays pinned by the admitted revision and every later plan/verification that depends on it.
                const copy = join(staging, 'asset-' + randomUUID()); await fsp.copyFile(s.blobFile(item.hash), copy);
                await storage.kvReplacePrefixesFromFilesAsync([{ key: item.key, sourcePath: copy }], []); item.installed = true;
            }
        }
        const sealedPlan = await sealRecord(s, v, { settings: result.settings, modules: result.modules, plugins: result.plugins, characters: [...result.characters.map(r => ({ chaId: r.chaId, ...r.fields })), ...result.newCharacters] }, work);
        const journal = { ...result, before: undefined, settings: sealedPlan.settings, modules: sealedPlan.modules, plugins: sealedPlan.plugins,
            characters: result.characters.map((r, i) => ({ chaId: r.chaId, chatIds: r.chatIds, fields: Object.fromEntries(Object.entries(sealedPlan.characters[i]).filter(([k]) => k !== 'chaId')) })),
            newCharacters: sealedPlan.characters.slice(result.characters.length), secretRefs: sealedPlan.secretRefs, envelopes: sealedPlan.envelopes, phase: 'prepared' };
        delete journal.before;
        journal.prepared = entityHashes(journal, db); // the canonical state this plan was computed from; arm refuses a different one
        writePlan(journal); manifest.transact(x => { x.plan = { transaction, phase: 'prepared', workspaceId: journal.workspaceId }; });
        await fsp.rm(work, { recursive: true, force: true });
        return materializePlan(s, v, journal);
    }
    /** The in-memory plan handed to the authenticated client: sealed journal + verified envelopes → real values. */
    function materializePlan(s, v, journal) {
        const value = unsealRecord(s, v, { ...journal, characters: [...journal.characters.map(r => ({ chaId: r.chaId, ...r.fields })), ...journal.newCharacters] });
        const out = { ...journal, settings: value.settings, modules: value.modules, plugins: value.plugins,
            characters: journal.characters.map((r, i) => ({ chaId: r.chaId, chatIds: r.chatIds, fields: Object.fromEntries(Object.entries(value.characters[i]).filter(([k]) => k !== 'chaId')) })),
            newCharacters: value.characters.slice(journal.characters.length) };
        delete out.secretRefs; delete out.envelopes; delete out.before; delete out.baseline; delete out.prepared;
        return out;
    }
    /** Roots among `touched` whose local items differ from their recorded lineage head: the same projection snapshot() uses,
     *  restricted to the touched chats' Bard material. A diverged (lineage-lost) item counts as edited. */
    async function unsnapshottedRoots(s, v, db, touched) {
        const edited = new Set(), lineage = service().lineage, branches = service().branches;
        const scoped = cardOnlyProjection(db, s), memberships = scoped.memberships;
        db = scoped.database;
        // An excluded local conversation has not been compared; do not overwrite it during a download.
        for (const key of touched.keys()) if (scoped.preserved.has(key)) edited.add(key);
        const known = [...touched.keys()].filter(key => Object.keys(lineage).some(k => k.startsWith(key + '#')));
        if (!known.length) return edited;
        const work = await fsp.mkdtemp(join(root, 'plan-check-')), captures = new Map(), cleanups = [];
        try {
            const chatRoots = new Set(known.filter(k => k.startsWith('play\nchat\n')).map(k => k.split('\n')[2]));
            for (const character of db.characters ?? []) {
                const chatIds = (character.chats ?? []).map(c => c.id).filter(id => id && (chatRoots.has(id) || chatRoots.has(branches[id]?.root)));
                if (!chatIds.length) continue;
                const capture = await memory.capturePlaySetMemory({ characterId: character.chaId, chatIds, temporaryDirectory: work });
                captures.set(character.chaId, capture); cleanups.push(capture.cleanup);
            }
            await normalizeCaptures(captures, db, branches, work);
            const projection = await projectDatabase({ database: db, cardOnlyMemberships: memberships, vault: v, captures, materials: playSetMemoryMaterials, branches, readAsset: readAsset(work), readInlay: readInlaySource(work), inlayMeta, readColdChat, remapBranchChat: (value, workspace) => workspace?.identities ? remapBardChat(value, workspace.identities) : value });
            const diff = diffProjection(s.graph, projection.desired.filter(d => known.includes(d.key)), lineage);
            for (const r of diff.revisions) edited.add(`${r.domain}\n${r.type}\n${r.root}`);
            for (const k of diff.diverged) edited.add(k.split('#')[0]);
        } finally { for (const cleanup of cleanups) await cleanup().catch(() => {}); await fsp.rm(work, { recursive: true, force: true }); }
        return edited;
    }
    /** Client echo of the normalized records it will save; only hashes are stored. Moves the write gate to this transaction. */
    const entityHashes = (current, db) => {
        const chatOf = (characterId, chatId) => (db.characters ?? []).find(c => c.chaId === characterId)?.chats?.find(ch => ch.id === chatId);
        return {
            chats: current.chats.map(r => { const c = chatOf(r.characterId, r.chat.id); return c ? localHash(c) : null; }),
            settings: Object.fromEntries(Object.keys(current.settings).map(k => [k, k in db ? localHash(db[k]) : null])),
            characters: [...current.characters, ...current.newCharacters].map(r => { const c = (db.characters ?? []).find(x => x.chaId === r.chaId); if (!c) return null; const { chats: _chats, ...rest } = c; return localHash(rest); }),
            modules: current.modules.map(m => { const x = (db.modules ?? []).find(y => y.id === m.id); return x ? localHash(x) : null; }),
            plugins: current.plugins.map(p => { const x = (db.plugins ?? []).find(y => y.name === p.name); return x ? localHash(x) : null; }),
            deletions: current.deletions.map(d => d.kind === 'chat' ? !!chatOf(d.characterId, d.id) : d.kind === 'character' ? (db.characters ?? []).some(c => c.chaId === d.id) : (db[d.kind + 's'] ?? []).some(i => (d.kind === 'plugin' ? i.name : i.id) === d.id)),
        };
    };
    async function arm(transaction, echo = {}) {
        const current = service().plan?.transaction === transaction && readPlan(transaction);
        if (!current || current.phase !== 'prepared') throw new Error('Sync apply preparation expired');
        // Baseline of every planned entity BEFORE the client mutates anything: finish may roll back only if all of them are still exactly this.
        current.baseline = entityHashes(current, await readDatabase());
        // A legitimate write that reached a planned entity between prepare and arm makes the plan (and its recovery copy) stale:
        // newer local data is never treated as disposable — the client abandons this plan and plans again.
        if (current.prepared && canonical(current.baseline, true) !== canonical(current.prepared, true)) throw Object.assign(new Error('Local data changed after the sync apply was prepared; plan again'), { code: 'NAS_SYNC_REPLAN', status: 409 });
        const chats = echo.chats ?? [];
        if (chats.length !== current.chats.length || chats.some((row, i) => row.characterId !== current.chats[i].characterId || row.chat?.id !== current.chats[i].chat.id)) throw new Error('Sync apply identity changed');
        const kept = new Set((echo.keptDeletions ?? []).map(d => `${d.kind}:${d.characterId ?? ''}:${d.id}`));
        current.expected = {
            chats: chats.map(row => ({ characterId: row.characterId, chatId: row.chat.id, fields: Object.keys(row.chat), hash: localHash(row.chat) })),
            settings: Object.fromEntries(Object.keys(current.settings).map(k => [k, echo.settings && k in echo.settings ? localHash(echo.settings[k]) : null])),
            characters: (echo.characters ?? []).map(row => ({ chaId: row.chaId, fields: Object.keys(row.fields), hash: localHash(row.fields) })),
            modules: (echo.modules ?? []).map(m => ({ id: m.id, hash: localHash(m) })), plugins: (echo.plugins ?? []).map(p => ({ name: p.name, hash: localHash(p) })),
            pluginEnabled: current.pluginEnabled ? localHash(echo.pluginEnabled ?? current.pluginEnabled) : null,
            deletions: current.deletions.filter(d => !kept.has(`${d.kind}:${d.characterId ?? ''}:${d.id}`)), keptDeletions: current.deletions.filter(d => kept.has(`${d.kind}:${d.characterId ?? ''}:${d.id}`)),
        };
        if (current.expected.characters.length !== current.characters.length + current.newCharacters.length || current.expected.modules.length !== current.modules.length || current.expected.plugins.length !== current.plugins.length) throw new Error('Sync apply echo is incomplete');
        current.phase = 'saving'; writePlan(current); manifest.transact(x => { x.plan.phase = 'saving'; }); // journal first, pointer second (reconciled on open)
        return { ready: true };
    }
    /** Move a directory aside into the recovery area; the original is never deleted, failure keeps it in place. */
    async function moveAside(source, destination) {
        if (!fs.existsSync(source)) return false;
        await fsp.mkdir(dirname(destination), { recursive: true });
        if (fs.existsSync(destination)) return true; // already moved by an earlier attempt of this same step
        await hooks.beforeMoveAside?.(source, destination);
        await fsp.rename(source, destination);
        return true;
    }
    function verifySaved(current, db) {
        const e = current.expected; if (!e) return false;
        const chatOf = (characterId, chatId) => (db.characters ?? []).find(c => c.chaId === characterId)?.chats?.find(ch => ch.id === chatId);
        const chats = e.chats.every(x => { const chat = chatOf(x.characterId, x.chatId); return chat && !x.fields.some(f => chat[f] === undefined) && localHash(Object.fromEntries(x.fields.map(f => [f, chat[f]]))) === x.hash; });
        const settings = Object.entries(e.settings).every(([k, h]) => h === null ? (current.settings[k] === null ? !(k in db) : false) : localHash(k in db ? db[k] : null) === h);
        const characters = e.characters.every(x => { const c = (db.characters ?? []).find(y => y.chaId === x.chaId); return c && localHash(Object.fromEntries(x.fields.map(f => [f, c[f]]))) === x.hash; });
        const modules = e.modules.every(x => { const m = (db.modules ?? []).find(y => y.id === x.id); return m && localHash(m) === x.hash; });
        const plugins = e.plugins.every(x => { const p = (db.plugins ?? []).find(y => y.name === x.name); return p && localHash(p) === x.hash; });
        const pluginEnabled = !e.pluginEnabled || localHash(Object.fromEntries((db.plugins ?? []).filter(p => p.name in current.pluginEnabled).map(p => [p.name, p.enabled ?? false]))) === e.pluginEnabled;
        const deletions = e.deletions.every(d => d.kind === 'chat' ? !chatOf(d.characterId, d.id) : d.kind === 'character' ? !(db.characters ?? []).some(c => c.chaId === d.id) : !(db[d.kind + 's'] ?? []).some(i => (d.kind === 'plugin' ? i.name : i.id) === d.id));
        return chats && settings && characters && modules && plugins && pluginEnabled && deletions;
    }
    /** Verify the saved canonical state once, then complete idempotent, journaled steps: Bard material, lineage, ACKs. */
    async function finish(transaction, confirmed = false) {
        const pointer = service().plan;
        // The durable completion record answers retries whose response was lost after the final manifest write; a newer plan is untouched.
        const done = service().applied.find(a => a.transaction === transaction);
        if (done) return { state: 'applied', transaction, commits: done.commits, chats: done.chats ?? 0, pending: done.pending ?? [], keptDeletions: done.keptDeletions ?? [], completedAt: done.at };
        if ((service().rolledBack ?? []).some(a => a.transaction === transaction)) return { state: 'rolled-back', transaction };
        const current = pointer?.transaction === transaction ? readPlan(transaction) : null;
        if (!current) { if (confirmed) throw new Error('No sync apply is pending'); return { state: 'idle' }; }
        // Finishing a persisted plan is local recovery of this device's own saved state: it does not depend on the auto-sync
        // switch (a user who disabled sync with a plan pending must still get the plan committed or rolled back at startup).
        const s = openStore(), staging = join(root, 'apply', transaction);
        const step = async mutate => { mutate(current); writePlan(current); await hooks.afterStep?.(current); };
        if (current.phase === 'saving' || current.phase === 'prepared') {
            const db = await readDatabase();
            if (current.phase === 'saving' && verifySaved(current, db)) { await step(c => { c.phase = 'committed'; }); manifest.transact(x => { x.plan.phase = 'committed'; }); }
            else {
                if (confirmed) throw new Error('Saved state does not match the prepared sync apply; recovery retained');
                // Roll back only when every planned entity is provably still in its pre-apply state; anything mixed or unknown keeps the plan and the write gate.
                const untouched = current.phase === 'prepared' || (current.baseline && canonical(entityHashes(current, db), true) === canonical(current.baseline, true));
                if (!untouched) throw Object.assign(new Error('Part of the sync apply may have been saved; recovery retained'), { code: 'NAS_SYNC_PARTIAL' });
                for (const item of current.media) if (item.installed) { if (item.kind === 'inlay') await removeInlay(item.id).catch(() => {}); else storage.kvDel(item.key); }
                manifest.transact(x => { x.plan = null; (x.rolledBack ??= []).push({ transaction, at: now() }); });
                await fsp.rm(file(planPath(transaction)), { force: true }); await fsp.rm(staging, { recursive: true, force: true });
                return { state: 'rolled-back', transaction };
            }
        }
        // committed: every step below is idempotent and recorded, so a crash anywhere resumes here.
        const kept = new Set((current.expected?.keptDeletions ?? []).map(d => `${d.kind}:${d.characterId ?? ''}:${d.id}`));
        const OWNER = '.nas-sync-owner.json';
        const ownedByThisPlan = dir => { try { return JSON.parse(fs.readFileSync(join(dir, OWNER), 'utf8')).transaction === transaction; } catch { return false; } };
        /** Install `stage` at `target`: move an existing foreign directory aside first; an existing directory this plan already installed is kept. */
        const install = async (stage, target, recoveryDir, build) => {
            if (fs.existsSync(target) && ownedByThisPlan(target)) { await fsp.rm(stage, { recursive: true, force: true }); return; }
            if (!fs.existsSync(stage)) { const tmp = stage + '.part'; await fsp.rm(tmp, { recursive: true, force: true }); await fsp.mkdir(tmp, { recursive: true }); await build(tmp); atomicWriteJson(tmp, OWNER, { transaction }); await fsp.rename(tmp, stage); }
            await moveAside(target, recoveryDir);
            if (fs.existsSync(target)) throw new Error('Workspace target still occupied by an unknown directory: ' + target);
            await fsp.mkdir(dirname(target), { recursive: true }); await fsp.rename(stage, target);
        };
        for (const workspace of current.workspaces) {
            const progress = current.progress.workspaces[workspace.chatId] ??= { current: false, slots: {} };
            if (progress.done) continue;
            const chatDir = resolveMemoryWorkspace(dataRoot, workspace.characterId, workspace.chatId).directory, recoveryDir = join(root, 'recovery', transaction, 'bard', b64(workspace.chatId));
            await safeParents(dataRoot, dirname(chatDir));
            if (!progress.current) {
                await install(join(staging, 'ws-' + b64(workspace.chatId)), chatDir, recoveryDir, async tmp => {
                    if (workspace.relinked) { if (workspace.current) await fsp.cp(join(root, workspace.current), tmp, { recursive: true }); }
                    else for (const f of workspace.files) { const target = join(tmp, f.path); await fsp.mkdir(dirname(target), { recursive: true }); await fsp.copyFile(s.blobFile(f.hash), target); }
                });
                await step(c => { c.progress.workspaces[workspace.chatId].current = true; });
            }
            const slots = workspace.relinked ? workspace.relinkedSlots.map(x => ({ saveId: x.saveId, source: join(root, x.directory), pages: x.pages.map(p => ({ hash: p.hash, source: join(root, workspace.current, '..', 'pages', p.hash.slice(0, 2), p.hash) })) }))
                : Object.entries(workspace.slots).map(([saveId, slot]) => ({ saveId, files: slot.files, pages: workspace.pages.map(p => ({ hash: p.hash, source: s.blobFile(p.hash) })) }));
            for (const slot of slots) {
                if (progress.slots[slot.saveId]) continue;
                const slotDir = resolveMemoryWorkspace(dataRoot, workspace.characterId, memorySaveWorkspaceId(slot.saveId)).directory;
                await install(join(staging, 'slot-' + b64(slot.saveId)), slotDir, join(root, 'recovery', transaction, 'slot', b64(slot.saveId)), async tmp => {
                    if (slot.source) await fsp.cp(slot.source, tmp, { recursive: true });
                    else for (const f of slot.files) { const target = join(tmp, f.path); await fsp.mkdir(dirname(target), { recursive: true }); await fsp.copyFile(s.blobFile(f.hash), target); }
                });
                const store = saveStoreDirectory(slotDir);
                for (const page of slot.pages) { const target = join(store, page.hash.slice(0, 2), page.hash); if (fs.existsSync(target)) continue; await fsp.mkdir(dirname(target), { recursive: true }); await fsp.copyFile(page.source, target); }
                await step(c => { c.progress.workspaces[workspace.chatId].slots[slot.saveId] = true; });
            }
            for (const dir of [chatDir, ...slots.map(slot => resolveMemoryWorkspace(dataRoot, workspace.characterId, memorySaveWorkspaceId(slot.saveId)).directory)]) for (const suffix of ['', '.sha256', '.bak', '.bak.sha256']) await fsp.rm(join(dir, OWNER + suffix), { force: true });
            await syncDir(dirname(chatDir)); memory.invalidateTransferCache?.(workspace.characterId, workspace.chatId);
            await step(c => { c.progress.workspaces[workspace.chatId].done = true; });
        }
        const lineageUpdate = Object.fromEntries(Object.entries(current.lineage).filter(([k]) => !current.deletions.some(d => kept.has(`${d.kind}:${d.characterId ?? ''}:${d.id}`) && k.endsWith('#' + d.id))));
        manifest.transact(x => {
            for (const [k, head] of Object.entries(lineageUpdate)) x.lineage[k] = head;
            for (const d of current.expected?.deletions ?? []) for (const k of Object.keys(x.lineage)) if (k.endsWith('#' + d.id)) delete x.lineage[k];
            Object.assign(x.branches, current.branches);
            x.localApply = (x.localApply ?? []).filter(k => !current.appliedRoots.includes(k));
        });
        recordLineage();
        const keptRoots = new Set((current.expected?.keptDeletions ?? []).map(d => d.kind === 'chat' ? `play\nchat\n${d.id}` : `library\n${d.kind}\n${d.id}`));
        for (const c of current.commits) {
            const key = `${c.device}/${c.incarnation}/${c.sequence}_${c.commitId}`;
            if (current.progress.acked.includes(key)) continue;
            const pair = s.pendingApply().find(p => p.device === c.device && p.incarnation === c.incarnation && p.sequence === c.sequence && p.commitId === c.commitId);
            if (pair && !(pair.revisions ?? []).some(id => { const r = s.graph.get(id); return r && keptRoots.has(`${r.domain}\n${r.type}\n${r.root}`); })) s.markApplied(c.device, c.incarnation, c.sequence, c.commitId);
            await step(x => { x.progress.acked.push(key); });
        }
        const outcome = { state: 'applied', transaction, commits: current.commits.length, chats: current.chats.length, pending: current.pending, keptDeletions: current.expected?.keptDeletions ?? [] };
        manifest.transact(x => { x.plan = null; x.applied.push({ transaction, at: now(), commits: outcome.commits, chats: outcome.chats, pending: outcome.pending, keptDeletions: outcome.keptDeletions }); });
        await hooks.afterCompletion?.(outcome);
        await fsp.rm(file(planPath(transaction)), { force: true }); await fsp.rm(staging, { recursive: true, force: true });
        return outcome;
    }
    function hold(transaction) {
        if (service().plan?.transaction !== transaction) throw new Error('No pending sync apply recovery');
        manifest.transact(x => { x.retained.push({ ...x.plan, heldAt: now() }); x.plan = null; });
        return { state: 'recovery-held', transaction };
    }
    const recovery = async () => { await sweepShares(); return service().plan ? [{ transaction: service().plan.transaction, phase: service().plan.phase }] : []; };
    // Single-flight: a client that dropped its HTTP wait (deadline, pause) and calls again joins the run still in progress instead of
    // starting a duplicate; a rejected run is not sticky; a run in flight finishes after disable (its uploads are immutable), while
    // the next call is refused by requireEnabled until re-enable.
    const inFlight = { publish: null, pull: null };
    const singleFlight = (name, run) => inFlight[name] ??= run().finally(() => { inFlight[name] = null; });
    // The NAS route (home/external) is pinned for the whole run: one publish or pull never mixes endpoints mid PUT/verify/MOVE.
    const pinned = fn => nasRoute ? nasRoute.run(fn) : fn();
    const publish = () => { requireEnabled(); return singleFlight('publish', () => pinned(() => openTransport().publish())); };
    const pull = () => { requireEnabled(); return singleFlight('pull', () => pinned(() => openTransport().pull())); };
    async function currentPlan() { const s = requireEnabled(), v = await openVault(); return service().plan ? materializePlan(s, v, readPlan(service().plan.transaction)) : { empty: true }; }
    function registerRoutes(app, { auth, activeSession }) {
        const route = (method, path, handler) => app[method]('/api/nas-sync' + path, async (req, res) => {
            try {
                if (!await auth(req, res) || method !== 'get' && !activeSession(req, res)) return;
                res.json(await handler(req));
            } catch (error) { if (!res.headersSent) res.status(error.status ?? 400).json({ error: error.message, code: error.code }); }
        });
        route('get', '/status', () => status());
        // Home/external route: the client (Android native bridge) reports the live network before each cycle; Windows detects itself.
        route('get', '/network', () => nasRoute ? nasRoute.status() : { route: 'single', reason: 'no-route' });
        route('post', '/network', req => { if (!nasRoute) return { route: 'single', reason: 'no-route' }; nasRoute.report(req.body ?? {}); return nasRoute.status(); });
        route('post', '/network/register', () => { if (!nasRoute) throw new Error('No route'); return nasRoute.registerCurrent(); });
        route('post', '/network/forget', req => { if (!nasRoute) throw new Error('No route'); return nasRoute.forget(String(req.body?.ssid ?? '')); });
        route('get', '/recovery', () => recovery());
        route('post', '/enable', req => enable(req.body));
        route('post', '/disable', () => disable());
        route('post', '/card-only-upload', req => exclusive(() => setCardOnlyUpload(req.body)));
        route('post', '/snapshot', () => exclusive(snapshot));
        route('post', '/bootstrap', req => exclusive(() => bootstrap(req.body)));
        route('post', '/publish', () => publish());
        route('post', '/pull', () => pull());
        route('get', '/pending-roots', () => pendingRoots());
        route('post', '/plan', () => exclusive(plan));
        route('post', '/arm', req => exclusive(() => arm(req.body.transaction, req.body)));
        route('post', '/finish', req => exclusive(() => finish(req.body.transaction, req.body.confirmed === true)));
        route('post', '/hold', req => { if (req.body.confirmed !== true) throw new Error('Recovery exit requires confirmation'); return exclusive(() => hold(req.body.transaction)); });
        route('post', '/share/request', () => exclusive(shareRequest));
        route('post', '/share/accept', req => exclusive(() => acceptPendingGrant(req.body)));
        route('post', '/share/discard', req => exclusive(() => discardShare(req.body)));
        route('get', '/conflicts', () => conflicts());
        route('get', '/overview', () => overview());
        route('post', '/resolve', req => exclusive(() => resolveConflict(req.body)));
        route('post', '/restore-revision', req => exclusive(() => restoreRevision(req.body)));
        route('get', '/trash', () => trashList());
        route('post', '/trash/restore', req => exclusive(() => restoreTrash(req.body)));
        route('post', '/open-deletion/restore', req => exclusive(() => restoreOpenDeletion(req.body)));
        route('post', '/open-deletion/accept', req => exclusive(() => acceptOpenDeletion(req.body)));
    }
    return { assertWrite, status, pendingRoots, enable, disable, setCardOnlyUpload: input => exclusive(() => setCardOnlyUpload(input)), markRestore, clearRestore, shareRequest: () => exclusive(shareRequest), detectShare, consumed, consumedAll, receiveForeign: (...a) => exclusive(() => receiveForeign(...a)), acceptPendingGrant: (...a) => exclusive(() => acceptPendingGrant(...a)), discardShare, sweepShares,
        conflicts, overview, resolveConflict: (...a) => exclusive(() => resolveConflict(...a)), restoreRevision: (...a) => exclusive(() => restoreRevision(...a)), trashList, restoreTrash: (...a) => exclusive(() => restoreTrash(...a)), restoreOpenDeletion: (...a) => exclusive(() => restoreOpenDeletion(...a)), acceptOpenDeletion, snapshot: () => exclusive(snapshot), bootstrap: (...a) => exclusive(() => bootstrap(...a)), plan: () => exclusive(plan), currentPlan: () => exclusive(currentPlan), arm: (...a) => exclusive(() => arm(...a)), finish: (...a) => exclusive(() => finish(...a)), hold: (...a) => exclusive(() => hold(...a)), recovery, publish, pull, registerRoutes,
        store: () => openStore(), transport: () => openTransport(), vault: () => openVault(), state: () => manifest.view() };
}
module.exports = { createNasSyncService };
