'use strict';

const { MODULE_OWNER } = require('./character-assets.cjs');

function registerModuleAssetRoutes(app, { auth, activeSession, queue, prepare, assets, kv, recordTransition }) {
    const valid = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
    const result = moduleId => ({
        ...assets.moduleStatus(moduleId),
        kv: kv.retiredStatus(MODULE_OWNER(moduleId)),
        store: kv.assetStoreShare && assets.moduleOwnedKeys ? kv.assetStoreShare(assets.moduleOwnedKeys(moduleId)) : { stored: 0, bytes: 0 },
        diagnostics: assets.diagnostics(),
    });
    const restoreKv = moduleId => kv.restoreRetiredAssets(MODULE_OWNER(moduleId), (key, entry) => assets.read(key, entry));
    const record = (action, outcome) => {
        try {
            recordTransition?.({
                kind: 'module-asset-transition', trigger: action, outcome,
                ...(outcome === 'failure' ? { errorCode: 'MODULE_ASSET_TRANSITION_FAILED' } : {}),
            });
        } catch { /* Observation must not change a completed storage operation. */ }
    };

    // Read-only status for badges and lists: memory state only, no identifiers beyond IDs.
    app.get('/api/storage-packages/overview', async (req, res, next) => {
        if (!await auth(req, res)) return;
        try {
            const { characters, modules } = assets.overview();
            const retired = kv.retiredSummary();
            for (const [owner, count] of Object.entries(retired)) {
                if (owner.startsWith('module:')) {
                    const id = owner.slice('module:'.length);
                    modules[id] = { ...(modules[id] || { enabled: false, copied: 0, failed: 0 }), retired: count };
                } else {
                    characters[owner] = { ...(characters[owner] || { package: false, assets: false }), retired: count };
                }
            }
            res.json({ characters, modules });
        } catch (error) { next(error); }
    });

    app.get('/api/module-assets/status', async (req, res, next) => {
        if (!await auth(req, res)) return;
        if (!valid(req.query.moduleId)) return res.status(400).json({ error: 'Invalid module ID' });
        try { res.json(result(req.query.moduleId)); }
        catch (error) { next(error); }
    });

    // Copying thousands of files must not block saves: only planning and publishing are queued.
    async function migrate(moduleId, res) {
        let plan = null;
        try {
            let refusal = null;
            await queue(async () => {
                const database = await prepare();
                if (!database) refusal = [409, 'Save pending or canonical files unavailable'];
                else if (database.modules?.filter(module => module?.id === moduleId).length !== 1) refusal = [404, 'Module unavailable'];
                else plan = assets.prepareModuleCopy(database, moduleId);
            });
            if (refusal) return res.status(refusal[0]).json({ error: refusal[1] });
            const copied = await assets.copyModule(plan);
            await queue(async () => { assets.publishModuleCopy(plan, copied); });
            record('migrate', 'success');
            res.json(result(moduleId));
        } catch (error) {
            record('migrate', 'failure');
            if (error?.code === 'MODULE_COPY_RUNNING') return res.status(409).json({ error: 'Module asset copy already running' });
            let status;
            try { status = result(moduleId); } catch { /* Status may also be unavailable during recovery. */ }
            res.status(500).json({ error: 'Module asset transition failed; original KV files retained', code: 'MODULE_ASSET_TRANSITION_FAILED', status });
        } finally {
            assets.releaseModuleCopy(plan);
        }
    }

    // Hashing every copy happens between two short queued steps, like migrate.
    async function retire(moduleId, res) {
        try {
            let refusal = null;
            let plan = null;
            await queue(async () => {
                const database = await prepare();
                if (!database) refusal = [409, 'Save pending or canonical files unavailable'];
                else if (database.modules?.filter(module => module?.id === moduleId).length !== 1) refusal = [404, 'Module unavailable'];
                else if (!assets.moduleStatus(moduleId).enabled) refusal = [409, 'Module asset folder is required'];
                else plan = assets.moduleRetirementPlan(database, moduleId);
            });
            if (refusal) return res.status(refusal[0]).json({ error: refusal[1] });
            const verified = await assets.verifyModuleRetirement(plan);
            let moved = { retired: 0 };
            // retireAssets re-checks each key against the current manifest object and size.
            await queue(async () => { moved = kv.retireAssets(MODULE_OWNER(moduleId), verified.candidates); });
            record('retire-kv', 'success');
            res.json({ ...result(moduleId), v4: { retired: moved.retired, shared: verified.shared, sharedBy: verified.sharedBy, unverified: verified.unverified + verified.candidates.length - moved.retired } });
        } catch {
            record('retire-kv', 'failure');
            let status;
            try { status = result(moduleId); } catch { /* Status may also be unavailable during recovery. */ }
            res.status(500).json({ error: 'Module asset transition failed; original KV files retained', code: 'MODULE_ASSET_TRANSITION_FAILED', status });
        }
    }

    app.post('/api/module-assets/transition', async (req, res) => {
        if (!await auth(req, res) || !activeSession(req, res)) return;
        const { moduleId, action } = req.body || {};
        if (!valid(moduleId) || !['migrate', 'disable', 'retire-kv', 'restore-kv'].includes(action)) {
            return res.status(400).json({ error: 'Explicit module and action required' });
        }
        if (action === 'migrate') return migrate(moduleId, res);
        if (action === 'retire-kv') return retire(moduleId, res);
        try {
            await queue(async () => {
                // Returning entries to the manifest and turning folder reads off never need canonical files.
                if (action === 'restore-kv' || action === 'disable') {
                    const restored = restoreKv(moduleId);
                    if (action === 'disable') {
                        if (restored.failed > 0) throw new Error('Retired module assets could not be restored');
                        assets.disableModule(moduleId);
                    }
                    record(action, restored.failed ? 'failure' : 'success');
                    return res.json({ ...result(moduleId), v4: restored });
                }
            });
        } catch {
            record(action, 'failure');
            let status;
            try { status = result(moduleId); } catch { /* Status may also be unavailable during recovery. */ }
            res.status(500).json({ error: 'Module asset transition failed; original KV files retained', code: 'MODULE_ASSET_TRANSITION_FAILED', status });
        }
    });
}

module.exports = { registerModuleAssetRoutes };
