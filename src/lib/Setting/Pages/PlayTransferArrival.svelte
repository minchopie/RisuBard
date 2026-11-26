<script lang="ts">
    // 0.9.103-ver4 (transfer-sync, user 2026-11-26 「Wi-Fi·USB 받는 쪽 도착 중 진행」): while this device's own Wi-Fi/USB transferer is
    // still receiving a file from another device (server GET /api/play-transfer/arrivals, polled every 1.5 s while the page is visible),
    // a line at the bottom of the screen shows it: a bar with percent when the transferer tells the size (newer Windows transferer), else
    // a moving bar with the MB that arrived. Mounted once by startTransferInbox (no host change). Hidden while this device is sending or a
    // transfer of its own runs (the panel and the overlay show those). Display only.
    import { onDestroy } from 'svelte'
    import { transferArrivals, arrivalView, type TransferArrival } from 'src/ts/playTransfer'
    import { transferBusy } from 'src/ts/transferState'
    import { nativeSend, playSetAvailable } from 'src/ts/transferNative'

    let arrivals = $state<TransferArrival[]>([])
    let polling = false, controller: AbortController | undefined
    async function tick() {
        if (polling || document.hidden || !playSetAvailable()) { if (!playSetAvailable()) arrivals = []; return }
        polling = true
        const c = controller = new AbortController(), limit = setTimeout(() => c.abort(), 5000)
        try { arrivals = await transferArrivals(c.signal) } catch { arrivals = [] }
        finally { clearTimeout(limit); controller = undefined; polling = false }
    }
    const timer = setInterval(tick, 1500)
    void tick()
    onDestroy(() => { clearInterval(timer); controller?.abort() })
    const sending = $derived(!!$nativeSend && !['delivered', 'applied', 'failed', 'cancelled', 'unknown'].includes($nativeSend.state))
    const view = $derived($transferBusy || sending ? null : arrivalView(arrivals))
</script>

{#if view}
    <div class="play-transfer-arrival" role="status" aria-live="polite" aria-busy="true" data-transfer-arrival>
        <span class="label">{view.label}</span>
        <div class="track" role="progressbar" aria-label="받는 파일 진행률" aria-valuemin="0" aria-valuemax="100" aria-valuenow={view.percent ?? undefined}>
            {#if view.percent !== null}<div class="fill" style="width: {view.percent}%"></div>{:else}<div class="fill moving"></div>{/if}
        </div>
        <span class="detail">{view.percent !== null ? `${view.percent}% · ` : ''}{view.detail}</span>
    </div>
{/if}

<style>
    .play-transfer-arrival { position: fixed; left: 50%; bottom: calc(env(safe-area-inset-bottom, 0px) + .75rem); transform: translateX(-50%); z-index: 99990;
        width: min(32rem, calc(100vw - 1.5rem)); display: grid; gap: .3rem; padding: .55rem .8rem; font-size: .85rem; color: var(--color-textcolor);
        border: 1px solid var(--color-darkborderc); border-radius: var(--risu-radius-lg, .5rem); background: var(--color-bgcolor); box-shadow: 0 4px 16px rgb(0 0 0 / .25); }
    .label { font-weight: 600; overflow-wrap: anywhere; }
    .detail { opacity: .85; overflow-wrap: anywhere; }
    .track { height: .5rem; border-radius: 999px; background: var(--color-darkbg); overflow: hidden; }
    .fill { height: 100%; background: var(--color-primary, var(--color-selected)); transition: width .4s; }
    .fill.moving { width: 35%; opacity: .7; animation: play-transfer-arrival-move 1.4s ease-in-out infinite; }
    @keyframes play-transfer-arrival-move { 0% { transform: translateX(-30%); } 100% { transform: translateX(290%); } }
    @media (prefers-reduced-motion: reduce) { .fill.moving { animation: none; transform: none; } }
</style>
