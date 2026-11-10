<script lang="ts">
    // 0.9.92-ver7 (transfer-sync): NAS sync progress, shown only while a sync cycle runs — the step, the files and size moved by the
    // running upload/download (server GET /api/nas-sync/progress, polled every second) and the elapsed time. Display only.
    import { onDestroy } from 'svelte'
    import { coordinatorState } from 'src/ts/nasSyncCoordinator'
    import { syncTransferProgress } from 'src/ts/nasSync'

    let { compact = false }: { compact?: boolean } = $props()
    let progress = $state<any>(null)
    let now = $state(Date.now())
    let timer: ReturnType<typeof setInterval> | undefined
    let polling = false, generation = 0, controller: AbortController | undefined

    const STEPS: Record<string, string> = {
        status: '상태 확인 중', release: '이전 준비 정리 중', snapshot: '내 변경을 묶는 중', publish: 'NAS에 올리는 중',
        pull: 'NAS에서 받는 중', preview: '받은 변경 확인 중', apply: '받은 변경 적용 중',
    }
    async function tick() {
        now = Date.now()
        if (polling) return
        polling = true
        // A hung request is cut after 5 s; a reply that lands after the cycle ended (generation changed) is dropped.
        const mine = generation, c = new AbortController(), limit = setTimeout(() => c.abort(), 5000)
        controller = c
        try { const value = await syncTransferProgress(c.signal); if (mine === generation) progress = value }
        catch { if (mine === generation) progress = null }
        finally { clearTimeout(limit); if (controller === c) { controller = undefined; polling = false } }
    }
    function stop() {
        generation++; controller?.abort(); controller = undefined; polling = false
        if (timer) clearInterval(timer); timer = undefined; progress = null
    }
    $effect(() => {
        if ($coordinatorState?.running) { if (!timer) { void tick(); timer = setInterval(tick, 1000) } }
        else stop()
    })
    onDestroy(stop)

    const mb = (n: number) => (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)
    const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초` }
    const step = $derived(STEPS[progress?.phase ?? $coordinatorState?.stage ?? 'status'] ?? '동기화 중')
    const byBytes = $derived(!!progress?.bytesTotal && !progress?.sizeUnknown)
    const total = $derived(progress ? (byBytes ? progress.bytesTotal : progress.filesTotal) : 0)
    const done = $derived(progress ? (byBytes ? Math.min(progress.bytes, progress.bytesTotal) : progress.files) : 0)
    const percent = $derived(total ? Math.min(100, Math.floor(done / total * 100)) : null)
    const detail = $derived(progress && progress.filesTotal
        ? `파일 ${Math.min(progress.files, progress.filesTotal)}/${progress.filesTotal}${progress.bytesTotal ? ` · ${mb(Math.min(progress.bytes, progress.bytesTotal))}/${mb(progress.bytesTotal)} MB` : ''}`
        : '')
    const elapsed = $derived(clock(progress?.elapsedMs ?? (now - ($coordinatorState?.stageAt ?? now))))
</script>

{#if $coordinatorState?.running}
    <div class={compact ? 'shrink-0 flex items-center gap-3 border-t border-darkborderc bg-bgcolor px-3 py-1 text-xs text-textcolor' : 'nas-sync-progress'} role="status" aria-live="polite" data-sync-progress>
        <span class="shrink-0">NAS 동기화 · {step}</span>
        <div class="min-w-16 flex-1 h-1.5 rounded bg-darkbg overflow-hidden" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={percent ?? undefined}>
            {#if percent !== null}<div class="h-full bg-selected transition-all" style="width: {percent}%"></div>{:else}<div class="h-full w-1/3 bg-selected opacity-60 animate-pulse"></div>{/if}
        </div>
        <span class="shrink-0">{percent !== null ? `${percent}%` : ''}{detail ? ` · ${detail}` : ''} · {elapsed}</span>
    </div>
{/if}

<style>
    .nas-sync-progress { display: flex; align-items: center; gap: .75rem; font-size: .85rem; margin: .25rem 0 .5rem; }
</style>
