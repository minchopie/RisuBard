<script lang="ts">
    // Content updates: publish a character card or persona to the NAS once; other devices ask whether to import it.
    import { onMount } from 'svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import {
        fetchOverview, describeFile, baseName, publishContent, checkContentUpdates, recordDecision, itemLabel, contentUpdateStatus,
        type ContentItem, type ContentKind, kindLabel } from 'src/ts/content-updates/contentUpdates'

    let items = $state<ContentItem[]>([])
    let configured = $state(true)
    let message = $state('')
    let working = $state(false)
    let picked = $state<{ fileName: string; bytes: Uint8Array; kind: ContentKind; title: string; version: string; series?: string } | null>(null)
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
            const file = await selectSingleFile(['charx', 'png', 'json', 'risup', 'risupreset', 'js', 'risum'])
            if (!file) return
            const described = await describeFile(file.name, file.data)
            picked = { fileName: file.name, bytes: file.data, ...described }
            // A module: its namespace (stays the same across its versions), or its name when it has none.
            publishName = described.kind === 'module' ? described.series ?? described.title : described.kind === 'persona' || described.kind === 'plugin' ? described.title : baseName(described.title)
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
            // A decided item is forgotten first; only its explicit re-download bypasses installed detection.
            if (item.decision) await recordDecision(item, 'reset')
            // 0.9.96-ver5: the pressed item is asked first.
            await checkContentUpdates(true, item.key, !!item.decision)
            await refresh()
        })
    }
    function decline(item: ContentItem) {
        return run(async () => { await recordDecision(item, 'declined'); await refresh() })
    }
    // 0.9.96-ver7: 「서버 끄기」 (PC only; appCodeUpdate.ts shutdownServer).
    let shutdownShown = $state(false)
    let stopping = $state(false)
    let stopMessage = $state('')
    async function stopServer() {
        if (stopping) return
        // Publishing or a check started from this panel talks to the NAS through the server: let it finish.
        if (working) { stopMessage = '지금은 서버를 끌 수 없어요: 위의 배포 작업(올리기·확인)이 진행 중이에요. 끝난 뒤 다시 눌러 주세요.'; return }
        stopping = true; stopMessage = ''
        try { stopMessage = await (await import('src/ts/content-updates/appCodeUpdate')).shutdownServer() }
        catch (error) { stopMessage = `서버를 끄지 못했어요: ${error instanceof Error ? error.message : String(error)}` }
        finally { stopping = false }
    }
    onMount(() => {
        void refresh()
        void import('src/ts/content-updates/appCodeUpdate').then(m => { shutdownShown = m.serverShutdownAvailable() }).catch(() => {})
    })
</script>

<fieldset disabled={working} aria-label="캐릭터·페르소나 배포">
    <legend>캐릭터·페르소나 배포 (NAS)</legend>
    <p>한 기기에서 카드나 페르소나 PNG를 올리면, 같은 NAS를 쓰는 다른 기기가 앱을 열 때 「가져올까요? 네/아니오」로 물어봐요. 캐릭터는 이미 있는 캐릭터를 고르면 대화는 그대로 두고 카드만 새 판으로 바꿔요. 플러그인(.js)과 모듈(.risum)도 올릴 수 있어요. 모듈은 같은 이름표(namespace)의 옛 모듈이 켜져 있던 곳에서 새 모듈로 바꿔 켜고, 옛 모듈은 꺼진 채 남겨요.</p>
    {#if !configured}
        <p class="hint">NAS 연결이 아직 설정되지 않았어요. 위의 「NAS 연결 설정」을 먼저 해 주세요.</p>
    {/if}
    <div class="transfer-actions">
        <ShButton variant="outline" onclick={pick}>파일 골라서 올리기 (charx · json · png · risup · js · risum)</ShButton>
        <ShButton variant="outline" onclick={() => run(async () => { await checkContentUpdates(true); await refresh() })}>지금 새 배포 확인</ShButton>
    </div>
    {#if picked}
        <div class="sync-card">
            <strong>{kindLabel(picked.kind)} · {itemLabel(picked)}</strong>
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
                    <strong>{item.kind === 'character' ? '캐릭터' : kindLabel(item.kind)} · {itemLabel(item)}</strong>
                    <span>{new Date(item.publishedAt).toLocaleString()}{item.publishedBy ? ` · ${item.publishedBy}` : ''} · {decisionText[item.decision] ?? item.decision}</span>
                    {#if !item.decision}
                        <ShButton variant="outline" onclick={() => askAgain(item)}>지금 물어보기</ShButton>
                        <ShButton variant="outline" onclick={() => decline(item)}>이 기기에서 안 받기</ShButton>
                    {:else}
                        <ShButton variant="outline" onclick={() => askAgain(item)}>다시 받기</ShButton>
                    {/if}
                </div>
            {/each}
        </details>
    {/if}
</fieldset>
{#if shutdownShown}
    <fieldset class="server-stop" disabled={stopping} aria-label="서버 끄기">
        <legend>서버 끄기 (이 PC)</legend>
        <p>탭을 닫아도 이 PC의 RisuBard 서버는 창 없이 계속 돌아요. 여기서 끄면 저장을 마친 뒤 서버가 꺼져요. 다시 쓰려면 RisuBard를 실행하세요. NAS에서 받아 둔 새 앱 코드는 서버가 다시 켜질 때 적용돼요. 답변·전송·NAS 동기화·가져오기가 진행 중이면 끄지 않고 이유를 알려 줘요.</p>
        <div class="transfer-actions"><ShButton variant="destructive" onclick={stopServer}>서버 끄기</ShButton></div>
        {#if stopMessage}<p role="status">{stopMessage}</p>{/if}
    </fieldset>
{/if}
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
    .server-stop { margin-top: 1rem; }
</style>
