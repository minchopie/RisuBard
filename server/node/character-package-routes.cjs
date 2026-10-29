'use strict';

function registerCharacterPackageRoutes(app, { auth, activeSession, queue, prepare, repository, assets, readSource, kv, acceptTransition, recordTransition }) {
    const valid = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
    const result = characterId => ({
        ...repository.characterDirectoryStatus(characterId),
        assets: assets.status(characterId),
        kv: kv ? kv.retiredStatus(characterId) : { retired: 0, bytes: 0 },
        store: kv?.assetStoreShare && assets.ownedKeys ? kv.assetStoreShare(assets.ownedKeys(characterId)) : { stored: 0, bytes: 0 },
        diagnostics: assets.diagnostics(),
    });
    // V4 pilot restore reads only digest-verified folder copies when an object is missing.
    const restoreKv = characterId => kv
        ? kv.restoreRetiredAssets(characterId, (key, entry) => assets.read(key, entry))
        : { restored: 0, failed: 0 };
    const transition = operation => {
        try { operation(); }
        catch (error) {
            if (error.canonicalTransitionRecovered === true) acceptTransition();
            throw error;
        }
        acceptTransition();
    };
    const record = (action, outcome) => {
        try {
            recordTransition?.({
                kind: 'character-package-transition', trigger: action, outcome,
                ...(outcome === 'failure' ? { errorCode: 'CHARACTER_PACKAGE_TRANSITION_FAILED' } : {}),
            });
        } catch { /* Observation must not change a completed storage operation. */ }
    };

    app.get('/api/character-packages/status', async (req, res, next) => {
        if (!await auth(req, res)) return;
        if (!valid(req.query.characterId)) return res.status(400).json({ error: 'Invalid character ID' });
        try { res.json(result(req.query.characterId)); }
        catch (error) { next(error); }
    });

    app.post('/api/character-packages/transition', async (req, res) => {
        if (!await auth(req, res) || !activeSession(req, res)) return;
        const { characterId, action } = req.body || {};
        if (!valid(characterId) || !['migrate', 'refresh', 'rollback', 'retire-kv', 'restore-kv'].includes(action)) {
            return res.status(400).json({ error: 'Explicit character and action required' });
        }
        try {
            await queue(async () => {
                // Returning entries to the manifest must stay possible without canonical files.
                if (action === 'restore-kv') {
                    const restored = restoreKv(characterId);
                    const status = result(characterId);
                    record(action, restored.failed ? 'failure' : 'success');
                    return res.json({ ...status, v4: restored });
                }
                const database = await prepare();
                if (!database) return res.status(409).json({ error: 'Save pending or canonical files unavailable' });
                if (database.characters?.filter(character => character.chaId === characterId).length !== 1) {
                    return res.status(404).json({ error: 'Character unavailable' });
                }
                if (action === 'retire-kv') {
                    if (!kv || !repository.characterDirectoryStatus(characterId).enabled) {
                        return res.status(409).json({ error: 'A V3 character package is required' });
                    }
                    const plan = assets.retirementCandidates(database, characterId);
                    const moved = kv.retireAssets(characterId, plan.candidates);
                    const status = result(characterId);
                    record(action, 'success');
                    return res.json({ ...status, v4: { retired: moved.retired, shared: plan.shared, sharedBy: plan.sharedBy, unverified: plan.unverified + plan.candidates.length - moved.retired } });
                }
                if (action === 'rollback') {
                    // Folder paths change below, so retired entries return to the manifest first.
                    if (restoreKv(characterId).failed > 0) throw new Error('Retired assets could not be restored');
                    transition(() => repository.rollbackCharacterDirectoryMapping(characterId));
                    assets.reload();
                    assets.disable(characterId);
                    const status = result(characterId);
                    record(action, 'success');
                    return res.json(status);
                }
                const alreadyEnabled = repository.characterDirectoryStatus(characterId).enabled;
                if (alreadyEnabled) {
                    transition(() => repository.refreshCharacterDirectoryMapping(characterId));
                } else {
                    assets.migrate(database, characterId, readSource);
                    transition(() => repository.publishCharacterDirectoryMapping(characterId));
                }
                assets.reload();
                if (action === 'refresh' && alreadyEnabled) assets.migrate(database, characterId, readSource);
                const status = result(characterId);
                record(action, 'success');
                res.json(status);
            });
        } catch {
            record(action, 'failure');
            let status;
            try { status = result(characterId); } catch { /* Status may also be unavailable during recovery. */ }
            res.status(500).json({
                error: 'Character package transition failed; recoverable source data was retained',
                code: 'CHARACTER_PACKAGE_TRANSITION_FAILED',
                status,
            });
        }
    });
}

module.exports = { registerCharacterPackageRoutes };
