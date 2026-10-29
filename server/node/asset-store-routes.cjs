'use strict';

// Explicit, resumable conversion between the KV manifest and the asset store.
// The client calls convert/revert repeatedly; each call is one queued batch,
// so saves keep flowing between batches and a stop takes effect at once.
const BATCH_LIMIT = 5000;

function registerAssetStoreRoutes(app, { auth, activeSession, queue, kv, recordTransition }) {
    const limitOf = value => {
        const number = Math.floor(Number(value));
        return Number.isFinite(number) && number > 0 ? Math.min(number, BATCH_LIMIT) : BATCH_LIMIT;
    };
    const record = (action, outcome, extra = {}) => {
        try {
            recordTransition?.({
                kind: 'asset-store-transition', trigger: action, outcome, ...extra,
                ...(outcome === 'failure' ? { errorCode: 'ASSET_STORE_TRANSITION_FAILED' } : {}),
            });
        } catch { /* Observation must not change a completed storage operation. */ }
    };

    app.get('/api/asset-store/status', async (req, res, next) => {
        if (!await auth(req, res)) return;
        try { res.json(kv.assetStoreStatus()); }
        catch (error) { next(error); }
    });

    for (const action of ['convert', 'revert']) {
        app.post(`/api/asset-store/${action}`, async (req, res, next) => {
            if (!await auth(req, res)) return;
            if (!activeSession(req, res)) return;
            try {
                let result;
                await queue(async () => {
                    result = action === 'convert'
                        ? await kv.convertToAssetStore({ limit: limitOf(req.body?.limit), verify: req.body?.verify === true })
                        : await kv.revertAssetStore({ limit: limitOf(req.body?.limit) });
                });
                record(action, 'success', { publishedFiles: action === 'convert' ? result.converted : result.reverted });
                res.json({ ...result, status: kv.assetStoreStatus() });
            } catch (error) {
                record(action, 'failure');
                next(error);
            }
        });
    }
}

module.exports = { registerAssetStoreRoutes };
