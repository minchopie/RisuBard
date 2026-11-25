<script lang="ts">
    // 0.9.103-ver4 (transfer-sync, user 2026-11-26 「진행이 되고 있는지 알 수가 없어 … 진행 그래프같은걸 띄워줬으면 해」): progress of a
    // character·chat transfer (play set) — the step, a bar with percent, MB and item counts, speed and remaining time, elapsed time (server
    // GET /api/play-transfer/progress, polled every second while something runs, every 3 s while the panel is only watching) and a native
    // Wi-Fi/USB send ($nativeSend). A step without a known total shows the moving bar with the step name. When a run the user waited on
    // ends, a done/failed line stays until the next one. Same line style as NasSyncProgress (0.9.92-ver7). Display only.
    import { onDestroy } from 'svelte'
    import { playTransferProgress, transferProgressView, type TransferProgress } from 'src/ts/playTransfer'
    import { transferStatus } from 'src/ts/transferState'
    import { nativeSend } from 'src/ts/transferNative'

    let { active = false, watch = false, outcome = null }: { active?: boolean; watch?: boolean; outcome?: { ok: boolean; elapsedMs: number } | null } = $props()
    let progress = $state<TransferProgress | null>(null)
    let now = $state(Date.now()), startedAt = $state(0), ended = $state<{ ok: boolean; elapsedMs: number } | null>(null)
    let timer: ReturnType<typeof setInterval> | undefined, every = 0
    let polling = false, generation = 0, controller: AbortController | undefined

    async function tick() {
        now = Date.now()
        if (polling || document.hidden) return
        polling = true
        // A hung request is cut after 5 s; a reply that lands after polling stopped (generation changed) is dropped.
        const mine = generation, c = new AbortController(), limit = setTimeout(() => c.abort(), 5000)
        controller = c
        try { const value = await playTransferProgress(c.signal); if (mine === generation) progress = value }
        catch { if (mine === generation) progress = null }
        finally { clearTimeout(limit); if (controller === c) { controller = undefined; polling = false } }
    }
    function stop() {
        generation++; controller?.abort(); controller = undefined; polling = false
        if (timer) clearInterval(timer); timer = undefined; every = 0; progress = null
    }
    // Any native state other than a final one is still running (sending, preparing, ready = USB waits for the PC transferer).
    const nativeRunning = $derived(!!$nativeSend && !['delivered', 'applied', 'failed', 'cancelled', 'unknown'].includes($nativeSend.state))
    $effect(() => {
        const wanted = active || nativeRunning ? 1000 : watch ? 3000 : 0
        if (wanted === every) return
        if (timer) clearInterval(timer)
        timer = undefined; every = wanted
        if (wanted) { void tick(); timer = setInterval(tick, wanted) } else stop()
    })
    $effect(() => {
        // A run the user waited on (at least 1.5 s): its end is shown as done/failed; quick list/config actions are not.
        // `outcome` is set in the same step that ends `active`, so the one read here belongs to this run.
        if (active) { if (!startedAt) { startedAt = Date.now(); ended = null } }
        else if (startedAt) { ended = Date.now() - startedAt >= 1500 ? outcome : null; startedAt = 0 }
    })
    // Which kind of work the line is about: a native send keeps its own final state (전달 완료/가져오기 완료) until another run starts.
    let source = $state<'run' | 'native' | ''>('')
    $effect(() => { if (nativeRunning) source = 'native'; else if (active || progress) source = 'run' })
    onDestroy(stop)

    const clock = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초` }
    const running = $derived(active || !!progress || nativeRunning)
    const native = $derived(!progress && (nativeRunning || (!active && source === 'native')) ? $nativeSend : null)
    const view = $derived(transferProgressView(progress, native, $transferStatus))
    const detail = $derived(progress || native ? view.detail : [view.detail, startedAt ? `경과 ${clock(now - startedAt)}` : ''].filter(Boolean).join(' · '))
    const final = $derived(!running && source === 'run' ? ended : null)
</script>

{#if running || native || final}
    <div class="play-transfer-progress" role="status" aria-live="polite" aria-busy={running} data-transfer-progress data-tone={final ? (final.ok ? 'done' : 'failed') : view.tone}>
        {#if !final}
            <span class="label">{view.tone === 'done' ? '✓ ' : view.tone === 'failed' ? '✕ ' : ''}{view.label}</span>
            <div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={view.percent ?? undefined}>
                {#if view.percent !== null}<div class="fill" style="width: {view.percent}%"></div>{:else}<div class="fill moving"></div>{/if}
            </div>
            <span class="detail">{view.percent !== null ? `${view.percent}%` : ''}{view.percent !== null && detail ? ' · ' : ''}{detail}</span>
        {:else}
            <span class="label">{final.ok ? '✓ 끝났어요' : '✕ 실패했어요'}</span>
            <div class="track"><div class="fill" style="width: 100%"></div></div>
            <span class="detail">걸린 시간 {clock(final.elapsedMs)}{$transferStatus ? ` · ${$transferStatus}` : ''}</span>
        {/if}
    </div>
{/if}

<style>
    .play-transfer-progress { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr); gap: .35rem; padding: .6rem .8rem; font-size: .85rem;
        border: 1px solid var(--color-darkborderc); border-radius: var(--risu-radius-lg, .5rem); background: var(--color-bgcolor); }
    .label { font-weight: 600; overflow-wrap: anywhere; }
    .detail { opacity: .85; overflow-wrap: anywhere; }
    .track { height: .5rem; border-radius: 999px; background: var(--color-darkbg); overflow: hidden; }
    .fill { height: 100%; background: var(--color-primary, var(--color-selected)); transition: width .4s; }
    .fill.moving { width: 35%; opacity: .7; animation: play-transfer-move 1.4s ease-in-out infinite; }
    [data-tone='done'] .fill { background: var(--color-draculagreen, var(--color-primary)); }
    [data-tone='failed'] .fill { background: var(--color-draculared, var(--color-selected)); }
    [data-tone='failed'] .label { color: var(--color-draculared, inherit); }
    @keyframes play-transfer-move { 0% { transform: translateX(-30%); } 100% { transform: translateX(290%); } }
    @media (prefers-reduced-motion: reduce) { .fill.moving { animation: none; transform: none; } }
</style>
