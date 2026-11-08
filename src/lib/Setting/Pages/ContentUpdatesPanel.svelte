<script lang="ts">
    // Content updates: publish a character card or persona to the NAS once; other devices ask whether to import it.
    import { onMount } from 'svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import {
        fetchOverview, describeFile, baseName, publishContent, checkContentUpdates, recordDecision, itemLabel, contentUpdateStatus,
        type ContentItem, type ContentKind,
    } from 'src/ts/content-updates/contentUpdates'

    let items = $state<ContentItem[]>([])
    let configured = $state(true)
    let message = $state('')
    let working = $state(false)
    let picked = $state<{ fileName: string; bytes: Uint8Array; kind: ContentKind; title: string; version: string } | null>(null)
    let publishName = $state('')

    const decisionText: Record<string, string> = { applied: '이 기기에 가져옴', declined: '이 기기에서 안 받음', published: '이 기기에서 올림', '': '아직 안 물어봄' }

    async function refresh() {
        try {
            const overview = await fetchOverview()
            configured = overview.configured
            items = [...overview.items].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
        } catch (error) { message = `목록을 읽지 못했어요: ${error instanceof Error ? error.message : String(error)}` }
    }
    async function run(work: () => Promise<void>) {
        if (working) return
        working = true; message = ''
        try { await work() } catch (error) { message = error instanceof Error ? error.message : String(error) }
        finally { working = false }
    }
    function pick() {
        return run(async () => {
            const { selectSingleFile } = await import('src/ts/util')
            const file = await selectSingleFile(['charx', 'png', 'json'])
            if (!file) return
            const described = await describeFile(file.name, file.data)
            picked = { fileName: file.name, bytes: file.data, ...described }
            publishName = described.kind === 'character' ? baseName(described.title) : described.title
        })
    }
    function publish() {
        return run(async () => {
            if (!picked) return
            const name = publishName.trim()
            if (!name) throw new Error('배포 이름을 적어 주세요.')
            const item = await publishContent({ key: `${picked.kind}:${name}`, kind: picked.kind, title: picked.title, version: picked.version, fileName: picked.fileName, bytes: picked.bytes })
            message = `「${itemLabel(item)}」를 올렸어요. 다른 기기에서 앱을 열거나 다시 켜면 가져올지 물어봐요.`
            picked = null
            await refresh()
        })
    }
    function askAgain(item: ContentItem) {
        return run(async () => {
            // A declined item is forgotten first, so the check asks about it again.
            if (item.decision) await recordDecision(item, 'reset')
            await checkContentUpdates(true)
            await refresh()
        })
    }
    function decline(item: ContentItem) {
        return run(async () => { await recordDecision(item, 'declined'); await refresh() })
    }
    onMount(() => { void refresh() })
</script>

<fieldset disabled={working} aria-label="캐릭터·페르소나 배포">
    <legend>캐릭터·페르소나 배포 (NAS)</legend>
    <p>한 기기에서 카드나 페르소나 PNG를 올리면, 같은 NAS를 쓰는 다른 기기가 앱을 열 때 「가져올까요? 네/아니오」로 물어봐요. 캐릭터는 이미 있는 캐릭터를 고르면 대화는 그대로 두고 카드만 새 판으로 바꿔요.</p>
    {#if !configured}
        <p class="hint">NAS 연결이 아직 설정되지 않았어요. 위의 「NAS 연결 설정」을 먼저 해 주세요.</p>
    {/if}
    <div class="transfer-actions">
        <ShButton variant="outline" onclick={pick}>파일 골라서 올리기 (charx · json · png)</ShButton>
        <ShButton variant="outline" onclick={() => run(async () => { await checkContentUpdates(true); await refresh() })}>지금 새 배포 확인</ShButton>
    </div>
    {#if picked}
        <div class="sync-card">
            <strong>{picked.kind === 'character' ? '캐릭터 카드' : '페르소나'} · {itemLabel(picked)}</strong>
            <span>{picked.fileName} · {(picked.bytes.length / 1_000_000).toFixed(1)} MB</span>
            <label>배포 이름<input bind:value={publishName} maxlength="120" /></label>
            <p class="hint">같은 배포 이름으로 다시 올리면 그 항목이 새 판으로 바뀌어요. 다른 계열(예: 별도 판)은 이름을 다르게 적어 주세요.</p>
            <div class="transfer-actions">
                <ShButton onclick={publish}>NAS에 올리기</ShButton>
                <ShButton variant="outline" onclick={() => { picked = null }}>취소</ShButton>
            </div>
        </div>
    {/if}
    {#if $contentUpdateStatus}<p role="status">{$contentUpdateStatus}</p>{/if}
    {#if message}<p role="status">{message}</p>{/if}
    {#if items.length}
        <details class="sync-card" open>
            <summary>NAS에 올라온 배포 {items.length}개</summary>
            {#each items as item (item.key)}
                <div class="remote-file">
                    <strong>{item.kind === 'character' ? '캐릭터' : '페르소나'} · {itemLabel(item)}</strong>
                    <span>{new Date(item.publishedAt).toLocaleString()}{item.publishedBy ? ` · ${item.publishedBy}` : ''} · {decisionText[item.decision] ?? item.decision}</span>
                    {#if !item.decision}
                        <ShButton variant="outline" onclick={() => askAgain(item)}>지금 물어보기</ShButton>
                        <ShButton variant="outline" onclick={() => decline(item)}>이 기기에서 안 받기</ShButton>
                    {:else if item.decision === 'declined'}
                        <ShButton variant="outline" onclick={() => askAgain(item)}>다시 받기</ShButton>
                    {/if}
                </div>
            {/each}
        </details>
    {/if}
</fieldset>
<style>
    fieldset { border: 1px solid var(--color-darkborderc); border-radius: var(--risu-radius-lg, .5rem); padding: 1rem; display: flex; flex-wrap: wrap; gap: .75rem; min-width: 0; }
    fieldset > p { width: 100%; }
    label { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; }
    input { border: 1px solid var(--color-darkborderc); background: var(--color-bgcolor); color: var(--color-textcolor); border-radius: calc(var(--risu-radius-lg, .5rem) * .8); padding: .6rem; min-width: 0; max-width: 100%; }
    p, strong, span { overflow-wrap: anywhere; }
    .sync-card { width: 100%; display: grid; gap: .5rem; padding: .75rem 1rem; border-radius: var(--risu-radius-lg, .5rem); border: 1px solid var(--color-darkborderc); }
    .sync-card summary { cursor: pointer; }
    .remote-file { width: 100%; min-width: 0; display: flex; flex-wrap: wrap; gap: .5rem; margin-block: .5rem; }
    .transfer-actions { width: 100%; display: flex; flex-wrap: wrap; gap: .5rem; }
    .hint { opacity: .8; font-size: .9em; }
</style>
