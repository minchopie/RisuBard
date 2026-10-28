<script lang="ts">
    import { onMount } from 'svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import { DBState, selectedCharID } from 'src/ts/stores.svelte'
    import { parseNasListing } from 'src/ts/transferNas'
    import { downloadFile } from 'src/ts/globalApi.svelte'
    import { alertConfirm } from 'src/ts/alert'
    import { playSetAvailable, androidTransferAvailable, playNative, sendNative, nativeSend } from 'src/ts/transferNative'
    import { transferBusy, transferStatus, transferQueue, refreshTransfers, queueTransferFile, exportTransfer, receiveTransfer, cancelTransfer, requestRemoteTransfer, uploadLegacyChat } from 'src/ts/playTransfer'
    import { isNodeServer } from 'src/ts/platform'
    import { syncStatus, syncOverview, enableSync, disableSync, setCardOnlyUpload, shareRequestSync, acceptSharedKey, discardShareSync, syncConflicts, resolveSyncConflict, syncTrash, restoreSyncTrash, restoreOpenDeletion, acceptOpenDeletion, bootstrapSync , syncNetwork, reportSyncNetwork, registerHomeNetwork, forgetHomeNetwork, reportSyncProfile } from 'src/ts/nasSync'
    import { syncCoordinator, coordinatorState } from 'src/ts/nasSyncCoordinator'
    import { syncStateRows, syncItemTitle, syncDifference, syncRevisionTime, groupSyncItemsByTime, syncGroupTitles, syncGroupStates, SYNC_ITEM_STATE, keyRequestNeeded, bootstrapAuthority, incomingPeers, conflictVariantLabel, shareMethodAllowed, hydrateSyncForm, routeLabel, withSavedHomeSsids, syncOutcomeText, syncDeviceName, syncHeadline, groupSyncTrash, detectDeviceKind } from 'src/ts/nasSyncUi'
    let selected = $state<string[]>([])
    let compatibility = $state(false)
    let result = $state<any>(null)
    let working = $state(false)
    let syncActionResult = $state('')
    let manualOpen = $state(false)
    let method = $state<'file' | 'nas' | 'github' | 'wifi' | 'share' | 'usb'>('file')
    let devices = $state<{ id: string; name: string; registered: boolean }[]>([])
    let registration = $state<{ code: string; expiresAt: number } | null>(null)
    let pairCode = $state('')
    let usbDevices = $state<{ serial: string; model: string; transportId: string }[]>([])
    let usbTarget = $state('')
    let remoteFiles = $state<any[]>([])
    let nas = $state({ url: '', username: '', password: '', hasPassword: false, homeUrl: '', homeSsids: [] as string[], certHost: '', homeCertHost: '' })
    let syncRoute = $state<any>(null)
    let github = $state({ repository: '', branch: '', token: '', hasToken: false })
    async function remote(operation: string, input = {}) {
        // Manual NAS list/upload/download choose home/external like sync does: refresh the device's network view first (best effort).
        if (method === 'nas' && operation !== 'config') await reportSyncNetwork().catch(() => {})
        if (method !== 'nas' && method !== 'github') throw new Error('원격 전송 방법을 선택해 주세요.')
        return requestRemoteTransfer(method, operation, input)
    }
    async function listRemote() {
        const result = await remote('list')
        remoteFiles = method === 'nas' ? parseNasListing(result.xml, result.url) : result
        transferStatus.set(`저장된 파일 ${remoteFiles.length}개`)
    }
    async function chooseMethod() {
        remoteFiles = []
        if (method === 'wifi') { await run(async () => { devices = await playNative('network.devices') }); return }
        if (method === 'usb' && !androidTransferAvailable()) { await run(async () => { usbDevices = await playNative('usb.devices'); usbTarget = usbDevices[0]?.serial ?? '' }); return }
        if (method === 'file' || method === 'share' || method === 'usb') return
        await run(async () => {
            const saved = await remote('config')
            if (method === 'nas') nas = { ...saved, password: '' }; else github = { ...saved, token: '' }
        })
    }
    const character = $derived(DBState.db.characters[$selectedCharID])
    $effect(() => { selected = character?.chats[character.chatPage]?.id ? [character.chats[character.chatPage].id] : []; result = null })
    onMount(() => { void refreshTransfers().catch(error => transferStatus.set(String(error))) })
    async function run(work: () => Promise<unknown>) {
        working = true
        try { await work() } catch (error) { transferStatus.set(String(error)) } finally { working = false }
    }
    async function download() {
        if (androidTransferAvailable()) { await sendNative(result.id, 'file', undefined, result.name); return }
        const link = document.createElement('a'); link.href = `/api/play-transfer/${result.id}/file`; link.download = result.name; link.click()
        transferStatus.set('파일 저장을 요청했어요. 다운로드 완료 여부는 기기의 파일 목록에서 확인해 주세요.')
    }
    const stateLabel: Record<string, string> = { waiting: '가져오기 대기', applying: '가져오는 중', applied: '가져오기 완료', failed: '실패', cancelled: '취소', receiving: '받는 중', ready: '파일 준비 완료' }

    // ---- automatic NAS sync (Node/embedded runtime only; reuses the NAS connection saved above and the device picker for key sharing) ----
    let sync = $state<any>(null)
    let syncConflictList = $state<any[]>([])
    let syncOverviewState = $state<any>(null)
    let syncTrashList = $state<any[]>([])
    let syncRole = $state<'authority' | 'joining'>('authority')
    let syncWorkspace = $state('risubard')
    let syncAuthorityPick = $state('')
    let syncFormHydrated = false
    let profileReported = false
    const syncSupported = isNodeServer
    const coordinator = () => syncCoordinator()
    async function runSync(direction: 'upload' | 'download') {
        await run(async () => {
            const label = direction === 'upload' ? '업로드' : '다운로드'
            syncActionResult = ''
            transferStatus.set(`${label} 중…`)
            const outcome = await (direction === 'upload' ? coordinator().uploadNow() : coordinator().downloadNow())
            syncActionResult = `${label}: ${syncOutcomeText(outcome, coordinator().state)}`
            transferStatus.set(syncActionResult)
            await refreshSync()
        })
    }
    /** One scoped status poll (10 s, visible only, while enabled) + the coordinator's reactive snapshot; user edits of role/workspace are never overwritten while disabled. */
    async function refreshSync() {
        if (!syncSupported) return
        const next = await syncStatus()
        sync = next
        syncRoute = next?.enabled ? await syncNetwork().catch(() => null) : null
        // The saved workspace/role fill the form once (disabled or enabled); later polls never overwrite the user's edits.
        const hydrated = hydrateSyncForm(next, { workspace: syncWorkspace, role: syncRole }, syncFormHydrated)
        if (hydrated.hydrated && !syncFormHydrated) { syncWorkspace = hydrated.form.workspace; syncRole = hydrated.form.role; syncFormHydrated = true }
        if (next?.enabled && !profileReported) {
            // Display only: tell the service whether this is the PC app, a tablet or a phone so other devices can name it.
            profileReported = true
            const kind = detectDeviceKind(navigator.userAgent, window.screen)
            if (next.sync?.profile?.kind !== kind) await reportSyncProfile({ kind }).then(() => syncStatus()).then(s => { sync = s }).catch(() => { profileReported = false })
        }
        if (next?.enabled) { syncConflictList = await syncConflicts(); syncTrashList = await syncTrash(); syncOverviewState = await syncOverview() }
        else { syncConflictList = []; syncTrashList = []; syncOverviewState = null }
    }
    onMount(() => {
        void refreshSync().catch(error => transferStatus.set(String(error)))
        const timer = setInterval(() => { if (sync?.enabled && !document.hidden && !working) void refreshSync().catch(() => {}) }, 10_000)
        return () => clearInterval(timer)
    })
    const syncRows = $derived(syncStateRows(sync, $coordinatorState))
    const syncDeletedOpen = $derived(character?.chats.filter((c: any) => c.risuSyncDeleted) ?? [])
    const shareResult = $derived(!!result?.share)
    /** Stage a key payload for the trusted device picker only (Wi-Fi registered device or USB). */
    function pickShareTarget(id: string, name: string) {
        manualOpen = true
        result = { id, name, bytes: 0, share: true }
        if (!shareMethodAllowed(method)) method = 'wifi'
        void chooseMethod()
        transferStatus.set('위 「내 기기 · 같은 Wi-Fi」 목록에서 기기를 골라 보내거나, USB로 보내 주세요. 다른 전송 방법으로는 키를 보낼 수 없어요.')
    }
</script>

<section class="transfer-panel" aria-label="캐릭터·대화 전송">
    <h3>캐릭터·대화 옮기기</h3>
    <p>같은 캐릭터가 있으면 대화만 추가해요. 기존 대화와 현재 화면은 유지돼요.</p>
    {#if syncSupported}
    <fieldset disabled={working} aria-label="NAS 자동 동기화">
        <legend>내 기기 자동 동기화</legend>
        <ShButton variant="outline" onclick={() => { manualOpen = true; method = 'nas'; void chooseMethod() }}>NAS 연결 설정</ShButton>
        {#if !sync}
            <p>동기화 상태를 읽는 중…</p>
        {:else if !sync.enabled}
            <p>같은 NAS 폴더를 쓰는 내 기기끼리 대화·설정을 자동으로 맞춰요. 먼저 기준이 될 기기(보통 태블릿)를 <strong>권한 기기</strong>로 켜고, 다른 기기는 <strong>참여 기기</strong>로 켠 뒤 등록된 Wi-Fi 기기나 USB로 동기화 키를 받아요. 암호·토큰은 기기 보안 저장소에만 있고 NAS에는 암호화된 형태로만 올라가요.</p>
            <label>작업공간 이름<input bind:value={syncWorkspace} placeholder="risubard" /></label>
            <label>이 기기의 역할<select bind:value={syncRole}><option value="authority">권한 기기 · 이 기기의 자료를 기준으로 시작</option><option value="joining">참여 기기 · 권한 기기의 키를 받아 합류</option></select></label>
            <ShButton onclick={() => run(async () => { sync = await enableSync(syncWorkspace.trim() || 'risubard', syncRole); coordinator().enabled(true); await refreshSync(); transferStatus.set(syncRole === 'authority' ? '자동 동기화를 켰어요. 다른 기기에서 참여 기기로 켜고 키를 요청해 주세요.' : '자동 동기화를 켰어요. 아래에서 키 요청을 준비해 보내 주세요.') })}>자동 동기화 켜기</ShButton>
        {:else}
            {@const headline = syncHeadline(sync, syncConflictList, $coordinatorState)}
            <div class="sync-headline" data-tone={headline.tone}>
                <strong>{headline.tone === 'ok' ? '✓ ' : headline.tone === 'waiting' ? '… ' : '! '}{headline.title}</strong>
                <span>{headline.detail}</span>
            </div>
            <div class="transfer-actions">
                <ShButton variant="outline" disabled={$coordinatorState?.running || $coordinatorState?.paused} onclick={() => runSync('upload')}>{$coordinatorState?.running && $coordinatorState.direction === 'upload' ? '업로드 중…' : 'NAS에 업로드'}</ShButton>
                <ShButton variant="outline" disabled={$coordinatorState?.running || $coordinatorState?.paused} onclick={() => runSync('download')}>{$coordinatorState?.running && $coordinatorState.direction === 'download' ? '다운로드 중…' : '이 기기에 다운로드'}</ShButton>
                <ShButton variant="outline" onclick={() => coordinator().pause(!($coordinatorState?.paused ?? false))}>{$coordinatorState?.paused ? '자동 동기화 재개' : '잠시 중지'}</ShButton>
            </div>
            <p class="hint">업로드: 이 기기 → NAS · 다운로드: NAS → 이 기기에 바로 적용. 자동 동기화는 그대로 계속돼요.</p>
            {#if working || syncActionResult}<p role="status" aria-live="polite">{working ? $transferStatus : syncActionResult}</p>{/if}
            {#if $coordinatorState?.paused}<p>전송하려면 자동 동기화를 재개해 주세요.</p>{/if}
            {#if syncOverviewState}
                {#each syncOverviewState.localIssues ?? [] as issue}
                    <p role="status">페르소나 「{issue.name}」의 현재 표시값과 저장된 내용이 달라서 받기를 기다려요. 페르소나 편집 화면에서 이 항목의 이름·그림·설명·메모를 확인하고 저장해 주세요. 그 뒤 「이 기기에 다운로드」를 누르면 다시 확인해요. 현재 값과 받은 원본은 덮어쓰지 않았어요.</p>
                {/each}
            {/if}
            {#if keyRequestNeeded(sync)}
                <p>{sync.vault?.missing ? '이 기기의 동기화 키가 없어요. 이 작업공간의 키를 아직 가진 다른 기기(권한 기기 등)에서 받아야 하며, 새 키를 만들지는 않아요.' : '동기화 키가 아직 없어요.'} 키 요청을 준비한 뒤 등록된 Wi-Fi 기기 또는 USB로 보내 주세요. Wi-Fi 등록 기기는 키를 자동으로 돌려보내고, USB로 받은 기기는 그 기기의 전송 화면에서 「동기화 키」를 USB로 다시 보내야 해요.</p>
                <ShButton onclick={() => run(async () => { const r = await shareRequestSync(); await refreshSync(); pickShareTarget(r.id, r.name) })}>동기화 키 요청 준비</ShButton>
            {/if}
            {#if sync.vault?.pendingGrant}
                <p>받은 동기화 키가 이 기기에 설치된 키와 달라요. 바꾸면 기존 키는 복구용으로 보관돼요.</p>
                <ShButton onclick={() => run(async () => { await acceptSharedKey(); await refreshSync(); transferStatus.set('공유받은 동기화 키로 바꿨어요.') })}>받은 키로 바꾸기</ShButton>
            {/if}
            {#each sync.shares ?? [] as share (share.id)}
                <div class="remote-file"><span>{share.kind === 'grant' ? `동기화 키 (받는 기기: ${syncDeviceName(sync, share.to)}${share.via === 'usb:adb' ? ' · USB로 보내 주세요' : ''})` : '동기화 키 요청'} · {new Date(share.at).toLocaleTimeString()}</span>
                    <ShButton variant="outline" onclick={() => pickShareTarget(share.id, share.kind === 'grant' ? '동기화 키' : '동기화 키 요청')}>보낼 기기 선택</ShButton>
                    <ShButton variant="outline" onclick={() => run(async () => { await discardShareSync(share.id); await refreshSync() })}>버리기</ShButton>
                </div>
            {/each}
            {@const choices = syncConflictList.filter(c => c.state === 'diverged')}
            {@const kept = syncConflictList.filter(c => c.state !== 'diverged')}
            {#if choices.length}
                <div class="sync-card">
                    <strong>기기 간 차이 {choices.length}건</strong>
                    {#if sync.role === 'joining' && sync.conflicts}
                        {@const authority = bootstrapAuthority(sync)}
                        <span>처음 합류할 때 겹친 캐릭터 카드·모듈·플러그인과 앱 설정은 {authority ? `${syncDeviceName(sync, authority.device).replace(/ · 기준$/, '')}(기준 기기)` : '고른 기기'}의 값으로 한 번에 맞출 수 있어요. 대화·페르소나와 합류 뒤에 고친 항목은 아래에서 하나씩 골라 주세요. 이 기기의 원래 값은 복구 기록에 보관돼요.</span>
                        {#if !authority}<label>기준 기기<select bind:value={syncAuthorityPick}><option value="">선택…</option>{#each incomingPeers(sync) as peer (peer.device + peer.incarnation)}<option value={peer.device}>{syncDeviceName(sync, peer.device)} · {peer.label}</option>{/each}</select></label>{/if}
                        <ShButton disabled={!authority && !syncAuthorityPick} onclick={() => run(async () => { const device = authority?.device ?? syncAuthorityPick; const r = await bootstrapSync(device); await refreshSync(); transferStatus.set(r.resolved ? `${syncDeviceName(sync, device)} 기준으로 카드·모듈·설정 ${r.resolved}개를 맞췄어요. 원래 값은 복구 기록에 있어요.` : '한 번에 맞출 처음 겹친 항목이 없어요. 남은 항목은 아래에서 하나씩 골라 주세요.') })}>{authority ? `처음 겹친 카드·모듈·설정을 ${syncDeviceName(sync, authority.device).replace(/ · 기준$/, '')} 값으로 맞추기` : '처음 겹친 카드·모듈·설정을 고른 기기 값으로 맞추기'}</ShButton>
                    {/if}
                    <details><summary>하나씩 골라서 맞추기</summary>
                        {#each choices as conflict (conflict.root)}
                            <div class="remote-file"><strong>{syncItemTitle(conflict)}</strong>
                                <span>{conflict.type === 'chat' ? syncDifference(conflict) : conflict.id === 'personas' ? '같은 페르소나의 수정이 겹쳤어요. 새로 추가한 항목은 양쪽 모두 보존해요.' : '설정 내용이 달라요. 남길 쪽을 골라 주세요.'}</span>
                                {#if conflict.type !== 'chat' || conflict.sameMessages}
                                {#each conflict.variants as variant, i (variant.heads[0])}
                                    {#if variant.resolvable === false}<span>이 판본은 식별자·이미지·보호된 자료를 먼저 확인해야 해요. 원본은 보존돼요.</span>
                                    {:else}<ShButton variant="outline" onclick={() => run(async () => { await resolveSyncConflict(conflict.root, variant.heads[0]); await refreshSync(); transferStatus.set('선택한 쪽으로 정했어요. 다음 동기화 때 반영돼요.') })}>{conflictVariantLabel(variant, i, conflict.variants.filter((v: any) => v !== variant), sync)}</ShButton>{/if}
                                {/each}
                                {:else}<span>다르게 진행된 대화는 각각의 갈래로 보존해요.</span>{/if}
                                <details><summary>진단용 식별자</summary><code>{conflict.root}</code></details>
                            </div>
                        {/each}
                    </details>
                </div>
            {/if}
            {#if kept.length}
                <details class="sync-card"><summary>양쪽 모두 보존한 대화 {kept.length}건 · 할 일 없음</summary>
                    <p>한 기기에서 지웠거나 서로 다르게 진행한 대화를 지우지 않고 모두 남겨 뒀어요.</p>
                    {#each kept as conflict (conflict.root)}
                        <div class="remote-file"><strong>{syncItemTitle(conflict)}</strong><span>{conflict.state === 'branches-preserved' ? '서로 다르게 진행한 대화를 각각 보존했어요.' : '다른 기기에서 지웠지만 이 기기에 새 변경이 있어요. 양쪽 모두 보존됐어요.'}</span>
                            <details><summary>진단용 식별자</summary><code>{conflict.root}</code></details>
                        </div>
                    {/each}
                </details>
            {/if}
            {#each syncDeletedOpen as chat (chat.id)}
                <div class="remote-file"><span>열려 있던 대화 「{chat.name}」를 다른 기기에서 지웠어요. 이 기기에는 그대로 있어요.</span>
                    <ShButton variant="outline" disabled={$transferBusy} onclick={() => run(async () => { await restoreOpenDeletion(character.chaId, chat.id); await refreshSync(); transferStatus.set('대화를 되살렸어요.') })}>되살리기</ShButton>
                    <ShButton variant="outline" disabled={$transferBusy} onclick={() => run(async () => { await acceptOpenDeletion(character.chaId, chat.id); await refreshSync(); transferStatus.set('삭제를 받아들였어요.') })}>삭제 적용</ShButton>
                </div>
            {/each}
            {@const trashRows = groupSyncTrash(syncTrashList)}
            {#if trashRows.length}
                <details class="sync-card"><summary>휴지통 · 최근 {trashRows.length}건 (최신 3건만 보관)</summary>
                    {#each trashRows as row (row.id)}
                        <div class="remote-file"><span>{row.title} · {syncRevisionTime(row.deletedAt)} 삭제{row.expired ? ' · 복원 기간 지남' : ''}</span>
                            <ShButton variant="outline" disabled={row.expired} onclick={() => run(async () => { await restoreSyncTrash(row.id); await refreshSync(); transferStatus.set('복원을 예약했어요. 다음 동기화 때 되살아나요.') })}>복원</ShButton>
                        </div>
                    {/each}
                </details>
            {/if}
            <details><summary>자세히 · 연결·복구·기록</summary>
                {#if syncRoute}<p>{routeLabel(syncRoute)}</p>{/if}
                {#each syncRows as row}<p>{row}</p>{/each}
                {#if syncOverviewState}
                    <p>마지막으로 확인한 NAS 판본과 이 기기의 적용 기록이에요. NAS 업로드 완료와 다른 기기의 적용 완료는 달라요. 다른 기기의 적용 여부는 아직 확인되지 않았어요.</p>
                    <p>페르소나 {syncOverviewState.personas.length}개: {syncOverviewState.personas.map((p: any) => p.name).join(', ')}</p>
                    {@const timeline = groupSyncItemsByTime(syncOverviewState.items ?? syncOverviewState.chats)}
                    <details class="sync-timeline">
                        <summary>NAS 최신판 기록 · 최근 {timeline.groups.length}개 시각{timeline.groups[0] ? ` · 마지막 ${timeline.groups[0].label}` : ''}</summary>
                        <p>최근 전송으로 확인한 NAS 최신판 · 한국시간. 같은 시각(분)에 올라간 자료는 한 항목으로 묶어 최근 5개 시각만 보여 줘요. 날짜는 표시용이며, 내용이 다른 자료를 날짜만 보고 덮어쓰지 않아요.</p>
                        {#each timeline.groups as group (group.key)}
                            <div class="remote-file"><strong>{group.label}</strong><span>{group.items.length}개 자료: {syncGroupTitles(group.items)}</span><span>{syncGroupStates(group.items)}</span>
                                <details><summary>자료별로 보기</summary>
                                    {#each group.items as item}
                                        <div class="remote-file"><strong>{item.type ? syncItemTitle(item) : `${item.character} · ${item.name}`}</strong><span>NAS 최신판: {syncRevisionTime(item.nasAt)}{item.nasTimeKind === 'uploaded' ? ' (업로드 확인)' : ''}</span><span>{SYNC_ITEM_STATE[item.state] ?? '확인 중'}</span>{#if item.wikiFiles !== undefined}<span>이 기기에 반영된 기록: Wiki·기억 {item.wikiFiles}파일 · 저장 슬롯 {item.slots}개 · 참조 페이지 {item.pages}개</span>{/if}</div>
                                    {/each}
                                </details>
                            </div>
                        {/each}
                        {#if timeline.hiddenGroups}<p>이전 기록 {timeline.hiddenGroups}개 시각 · 자료 {timeline.hiddenItems}개는 목록에서만 생략했어요{timeline.hiddenAttention ? ` (그중 업로드 대기·확인 필요 ${timeline.hiddenAttention}개)` : ''}. NAS와 이 기기의 자료는 그대로예요.</p>{/if}
                    </details>
                {/if}
                {#if character?.chaId}
                    <label>
                        <input type="checkbox" checked={sync.cardOnlyUploads?.includes(character.chaId) ?? false}
                            onchange={(event) => { const enabled = event.currentTarget.checked; void run(async () => { sync = await setCardOnlyUpload(character.chaId, enabled); await refreshSync(); }) }} />
                        「{character.name}」 카드만 업로드
                    </label>
                    <p>이 기기에서 선택한 캐릭터의 카드와 카드 자료만 올려요. 기존 대화·Wiki는 삭제하지 않고, 기존 대화에 받은 변경도 보류해요. 대화 동기화를 재개하려면 체크를 해제해 주세요.</p>
                {/if}
                <ShButton variant="outline" onclick={() => run(async () => { if (!await alertConfirm('자동 동기화를 끌까요? 대화·설정과 NAS에 올린 자료는 그대로 남고, 다시 켜면 이어서 동기화돼요.')) return; coordinator().enabled(false); sync = await disableSync(); await refreshSync(); transferStatus.set('자동 동기화를 껐어요.') })}>자동 동기화 끄기</ShButton>
            </details>
        {/if}
    </fieldset>
    {/if}
    <p role="status" aria-live="polite">{$transferStatus}</p>
    <details bind:open={manualOpen}>
    <summary>파일·USB·Wi-Fi로 직접 옮기기 / 연결 설정</summary>
    <fieldset disabled={working || $transferBusy}>
        <legend>1. 보낼 대화</legend>
        {#if character}
            <strong>{character.name}</strong>
            {#each character.chats as chat, i (chat.id)}
                <label><input type="checkbox" value={chat.id} bind:group={selected} />{chat.name || `대화 ${i + 1}`}{i === character.chatPage ? ' (현재 대화)' : ''}</label>
            {/each}
            <label><input type="checkbox" bind:checked={compatibility} />구 RisuAI USB 앱용 호환 파일 (BardWiki·저장 슬롯 제외)</label>
            <ShButton disabled={!selected.length} onclick={() => run(async () => { result = await exportTransfer(selected, compatibility) })}>보낼 자료 확인</ShButton>
        {:else}<p>보낼 캐릭터를 먼저 열어 주세요. 파일 받기는 바로 사용할 수 있어요.</p>{/if}
    </fieldset>
    {#if result}
        {#each result.missing ?? [] as item}<p class="error">빠진 자료: {item.path} · {item.reason}</p>{/each}
        {#each result.excluded ?? [] as item}<p>제외: {item.path} · {item.reason}</p>{/each}
        {#each result.external ?? [] as item}<p>외부 자료: {item.path} · 인터넷 연결이 필요할 수 있어요.</p>{/each}
        {#if result.id}
            <p>{result.name} · {Math.ceil(result.bytes / 1024).toLocaleString()} KiB</p>
        {/if}
    {/if}
    <fieldset disabled={working || $transferBusy}>
        <legend>2. 전송 방법 · 보내기와 받기</legend>
        <label>방법<select bind:value={method} onchange={chooseMethod}>
            <option value="file" disabled={shareResult}>파일</option><option value="nas" disabled={shareResult}>NAS · WebDAV</option><option value="github" disabled={shareResult}>GitHub 개인 백업</option>
            {#if playSetAvailable()}<option value="wifi">내 기기 · 같은 Wi-Fi</option><option value="share" disabled={shareResult}>Quick Share · 시스템 공유</option><option value="usb">USB</option>{/if}
        </select></label>
        {#if method === 'file'}
            {#if result?.id && !shareResult}<ShButton onclick={() => run(download)}>파일로 저장</ShButton>{/if}
        {:else if method === 'wifi'}
            <ShButton variant="outline" onclick={() => run(async () => { devices = await playNative('network.devices') })}>내 기기 찾기</ShButton>
            <ShButton variant="outline" onclick={() => run(async () => { registration = await playNative('network.registration') })}>이 기기 등록 코드 표시</ShButton>
            {#if registration}<p>등록 코드: <strong>{registration.code}</strong> · {new Date(registration.expiresAt).toLocaleTimeString()}까지 · 5회 실패하면 다시 표시해 주세요.</p>{/if}
            <label>상대 기기의 6자리 코드<input inputmode="numeric" pattern="[0-9]{6}" maxlength="6" bind:value={pairCode} /></label>
            {#each devices as device (device.id)}
                <div class="remote-file"><strong>{device.name}</strong>
                    {#if device.registered}
                        <span>등록된 내 기기</span>
                        {#if result?.id}<ShButton onclick={() => run(() => sendNative(result.id, 'wifi', device.id))}>보내기</ShButton>{/if}
                        <ShButton variant="outline" onclick={() => run(async () => { await playNative('network.forget', { device: device.id }); devices = await playNative('network.devices') })}>등록 해제</ShButton>
                    {:else}<ShButton disabled={!/^\d{6}$/.test(pairCode)} onclick={() => run(async () => { await playNative('network.pair', { device: device.id, code: pairCode }); pairCode = ''; devices = await playNative('network.devices'); transferStatus.set('기기를 등록했어요. 다음부터는 코드를 입력하지 않아도 돼요.') })}>기기 등록</ShButton>{/if}
                </div>
            {/each}
            {#if !devices.length}<p>같은 Wi-Fi에서 상대 기기의 RisuBard를 열고 다시 찾아 주세요.</p>{/if}
        {:else if method === 'share' || method === 'usb'}
            <p>{method === 'usb' ? 'USB 디버깅을 허용한 PC와 연결하고, PC 전송기에서 RisuBard를 선택해 주세요.' : '시스템 공유창에서 대상 기기를 선택해 주세요. 받은 .risuplay 파일을 RisuBard로 열면 수신 목록에 표시돼요.'}</p>
            {#if method === 'usb' && !androidTransferAvailable()}
                <ShButton variant="outline" onclick={chooseMethod}>연결된 기기 새로고침</ShButton>
                <label>USB 기기<select bind:value={usbTarget}>{#each usbDevices as device (device.serial)}<option value={device.serial}>{device.model} · {device.serial}</option>{/each}</select></label>
                <ShButton disabled={!usbTarget} onclick={() => run(async () => {
                    const transfer = crypto.randomUUID(), device = usbDevices.find(item => item.serial === usbTarget)
                    await playNative('usb.receive', { transfer, device })
                    for (;;) {
                        const progress = await playNative<{ state: string; error?: string; sent?: number; total?: number }>('usb.progress', { transfer })
                        nativeSend.set(progress)
                        if (progress.state === 'failed' || progress.state === 'cancelled') throw new Error(progress.error || '전송이 취소됐어요.')
                        if (progress.state === 'delivered') { transferStatus.set('USB 전달 완료 · 가져오기 대기'); break }
                        await new Promise(resolve => setTimeout(resolve, 1000))
                    }
                })}>기기에서 받기</ShButton>
            {/if}
            {#if result?.id && !(shareResult && method === 'share')}<ShButton disabled={method === 'usb' && !androidTransferAvailable() && !usbTarget} onclick={() => run(() => sendNative(result.id, method as 'share' | 'usb', method === 'usb' && !androidTransferAvailable() ? usbDevices.find(item => item.serial === usbTarget) : undefined))}>{method === 'usb' ? 'USB로 보내기 준비' : '공유창 열기'}</ShButton>{/if}
        {:else}
            <details>
                <summary>연결 설정</summary>
                {#if method === 'nas'}
                    <label>HTTPS 폴더 주소<input type="url" bind:value={nas.url} placeholder="https://nas.example/home/RisuAI/" /></label>
                    <label>인증서 이름 (선택 · 주소를 IP로 적을 때, 인증서의 호스트명)<input bind:value={nas.certHost} placeholder="nas.example" /></label>
                    <label>집 네트워크용 내부 HTTPS 주소 (선택, 같은 폴더·계정)<input type="url" bind:value={nas.homeUrl} placeholder="https://nas-home.example:5006/home/RisuAI/" /></label>
                    {#if nas.homeUrl}
                        <label>내부 주소의 인증서 이름 (선택 · 내부 주소를 IP로 적을 때)<input bind:value={nas.homeCertHost} placeholder="nas-home.example" /></label>
                        <p>집 Wi-Fi: {nas.homeSsids.length ? nas.homeSsids.join(', ') : '등록된 이름 없음'} · 등록된 Wi-Fi에서는 내부 주소, 그 외에는 바깥 주소를 씁니다. 유선 PC는 내부 주소가 응답하면 그쪽을 씁니다. 모르는 Wi-Fi는 집으로 보지 않아요.</p>
                        <div class="transfer-actions"><ShButton variant="outline" size="sm" onclick={() => run(async () => { const r: any = await registerHomeNetwork(); if (r?.requested) { transferStatus.set('위치 권한을 허용한 뒤 다시 눌러 주세요 (Wi-Fi 이름을 읽는 데 필요해요).'); return } nas = withSavedHomeSsids(nas, await remote('config')); transferStatus.set('지금 연결된 Wi-Fi를 집으로 등록했어요. 내부 주소를 바꿨다면 설정 저장도 눌러 주세요.') })}>지금 연결된 Wi-Fi를 집으로 등록</ShButton>
                        {#each nas.homeSsids as ssid (ssid)}<ShButton variant="outline" size="sm" onclick={() => run(async () => { await forgetHomeNetwork(ssid); nas = withSavedHomeSsids(nas, await remote('config')) })}>{ssid} 지우기</ShButton>{/each}</div>
                    {/if}
                    <label>계정<input autocomplete="username" bind:value={nas.username} /></label>
                    <label>비밀번호<input type="password" autocomplete="new-password" bind:value={nas.password} placeholder={nas.hasPassword ? '저장됨 · 바꾸려면 입력' : ''} /></label>
                {:else}
                    <label>비공개 저장소<input bind:value={github.repository} placeholder="계정/개인백업저장소" /></label>
                    <label>브랜치<input bind:value={github.branch} placeholder="비워 두면 기본 브랜치" /></label>
                    <label>토큰<input type="password" autocomplete="new-password" bind:value={github.token} placeholder={github.hasToken ? '저장됨 · 바꾸려면 입력' : ''} /></label>
                    <p>같은 대화는 최신 파일 하나로 갱신돼요. 이전 Git 이력과 다른 대화 백업은 유지돼요.</p>
                {/if}
                <ShButton onclick={() => run(async () => {
                    const saved = await remote('configure', method === 'nas' ? nas : github)
                    if (method === 'nas') nas = { ...saved, password: '' }; else github = { ...saved, token: '' }
                    transferStatus.set('연결 정보를 기기의 보안 저장소에 저장했어요.')
                })}>설정 저장</ShButton>
                <ShButton variant="outline" onclick={() => run(async () => {
                    if (!await alertConfirm('NAS와 GitHub 연결 정보를 모두 재설정할까요? 대화와 원격 백업은 유지되고, 주소·계정·비밀번호·토큰을 다시 입력해야 해요. 기존 암호화 파일은 복구용으로 보관돼요.')) return
                    await remote('reset-credentials')
                    nas = { url: '', username: '', password: '', hasPassword: false, homeUrl: '', homeSsids: [], certHost: '', homeCertHost: '' }
                    github = { repository: '', branch: '', token: '', hasToken: false }
                    remoteFiles = []
                    transferStatus.set('전송 연결 정보를 재설정했어요. 새 연결 정보를 저장해 주세요.')
                })}>전송 연결 정보 모두 재설정</ShButton>
            </details>
            {#if result?.id && !shareResult}<ShButton onclick={() => run(async () => { transferStatus.set('업로드·검증 중…'); await remote('upload', { id: result.id }); transferStatus.set('전달 완료 · 받는 기기에서 목록을 열어 내려받아 주세요.'); })}>준비한 대화 업로드</ShButton>{/if}
            <ShButton variant="outline" onclick={() => run(listRemote)}>저장된 파일 목록</ShButton>
            {#if method === 'github'}
                <details>
                    <summary>기존 RisuAI 채팅 JSON 호환</summary>
                    <p>기존 chat-uploads 브랜치의 8 MiB 이하 대화 JSON이에요. BardWiki·저장 슬롯·이미지 파일은 포함되지 않아요. 내려받은 JSON은 캐릭터의 대화 가져오기에서 열 수 있어요.</p>
                    <ShButton disabled={!character} onclick={() => run(async () => { transferStatus.set('현재 대화 JSON 업로드·검증 중…'); const saved = await uploadLegacyChat(); transferStatus.set(saved?.cancelled ? '업로드를 취소했어요. 기존 백업은 유지됩니다.' : '현재 대화 JSON 백업 완료'); })}>현재 대화 JSON 백업</ShButton>
                    <ShButton variant="outline" onclick={() => run(async () => { remoteFiles = await remote('legacy-list'); transferStatus.set(`기존 JSON 백업 ${remoteFiles.length}개`); })}>기존 JSON 백업 목록</ShButton>
                </details>
            {/if}
            {#each remoteFiles as file (file.name)}
                <div class="remote-file"><span>{file.name} · {Math.ceil(file.bytes / 1024).toLocaleString()} KiB</span>
                    <ShButton onclick={() => run(async () => {
                        transferStatus.set('다운로드·검증 중…')
                        if (file.legacy) { const saved = await remote('legacy-download', file); await downloadFile(saved.name, new TextEncoder().encode(saved.document)); transferStatus.set('JSON 파일 저장을 요청했어요. 캐릭터의 대화 가져오기에서 열어 주세요.') }
                        else { await remote('download', { ...file, applyRequested: true }); await refreshTransfers(); transferStatus.set('받기 완료 · 기존 작업이 끝나면 앱에 바로 반영해요. 다운로드 폴더에는 저장하지 않아요.') }
                    })}>{file.legacy ? 'JSON 파일로 저장' : '앱으로 받기'}</ShButton>
                </div>
            {/each}
        {/if}
    </fieldset>
    <fieldset disabled={working || $transferBusy}>
        <legend>받기</legend>
        <label>전송 파일 열기<input type="file" accept=".risuplay" onchange={event => { const file = event.currentTarget.files?.[0]; if (file) void run(() => queueTransferFile(file)); event.currentTarget.value = '' }} /></label>
        <ShButton variant="outline" onclick={() => run(refreshTransfers)}>수신 목록 새로고침</ShButton>
    </fieldset>

    {#if $nativeSend?.total}<progress max={$nativeSend.total} value={$nativeSend.sent ?? 0} aria-label="전송 진행률"></progress>{/if}
    {#each $transferQueue.filter(row => row.direction === 'receive' && !(row as any).share) as entry (entry.id)}
        <div class="entry">
            <strong>{entry.name}</strong><span>{entry.state === 'waiting' && entry.applyRequested ? '앱에 반영 대기 · 기존 작업이 끝나면 자동 반영' : entry.state === 'recovery-held' ? '복구 보관' : stateLabel[entry.state] ?? entry.state}</span>
            {#if entry.error}<p class="error">{entry.error}</p>{/if}
            {#if ['waiting', 'failed'].includes(entry.state)}
                <ShButton disabled={working || $transferBusy} onclick={() => run(() => receiveTransfer(entry.id))}>가져오기</ShButton>
                <ShButton variant="outline" disabled={working || $transferBusy} onclick={() => run(() => cancelTransfer(entry.id))}>취소</ShButton>
            {/if}
        </div>
    {/each}
    </details>
</section>
<style>
    .transfer-panel { display: grid; gap: 1rem; margin-block: 1rem; }
    fieldset, .entry { border: 1px solid var(--color-darkborderc); border-radius: .5rem; padding: 1rem; display: flex; flex-wrap: wrap; gap: .75rem; min-width: 0; }
    fieldset > label, fieldset > p, fieldset > strong, .entry > p { width: 100%; }
    label { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; }
    input[type=file] { max-width: 100%; }
    details, .remote-file { width: 100%; min-width: 0; }
    details label, .remote-file { display: flex; flex-wrap: wrap; gap: .5rem; margin-block: .5rem; }
    input:not([type=checkbox]), select { border: 1px solid var(--color-darkborderc); background: var(--color-bgcolor); color: var(--color-textcolor); border-radius: .4rem; padding: .6rem; min-width: 0; max-width: 100%; }
    p, strong, span { overflow-wrap: anywhere; }
    .error { color: var(--color-draculared); }
    .sync-timeline summary { cursor: pointer; }
    .sync-headline { width: 100%; display: grid; gap: .25rem; padding: .75rem 1rem; border-radius: .5rem; border: 1px solid var(--color-darkborderc); }
    .sync-headline[data-tone='ok'] strong { color: var(--color-draculagreen, inherit); }
    .sync-headline[data-tone='attention'] strong { color: var(--color-draculaorange, inherit); }
    .sync-headline[data-tone='waiting'] strong { color: var(--color-draculayellow, inherit); }
    .sync-card { width: 100%; display: grid; gap: .5rem; padding: .75rem 1rem; border-radius: .5rem; border: 1px solid var(--color-darkborderc); }
    .sync-card summary, details > summary { cursor: pointer; }
    .transfer-actions { width: 100%; display: flex; flex-wrap: wrap; gap: .5rem; }
    .hint { opacity: .8; font-size: .9em; }
    .sync-timeline .remote-file .remote-file { padding-left: 1rem; }
</style>
