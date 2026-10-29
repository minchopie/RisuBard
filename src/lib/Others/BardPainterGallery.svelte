<script lang="ts">
    import { Buffer } from 'buffer'
    import { untrack } from 'svelte'
    import { Archive, Check, ChevronLeft, ChevronRight, Copy, Images, LoaderCircle, RefreshCw, Trash2, X } from '@lucide/svelte'
    import ShButton from '../UI/GUI/ShButton.svelte'
    import ShDialog from '../UI/GUI/ShDialog.svelte'
    import { alertConfirm, notifyError, notifySuccess } from 'src/ts/alert'
    import { getInlayAssetBlob, listInlayExplorerItems, removeInlayAsset, type InlayExplorerItem } from 'src/ts/process/files/inlays'
    import type { character } from 'src/ts/storage/database.svelte'
    import { filterPainterGallery, loadPainterGalleryRecord, novelAiGalleryInfo, painterGalleryInfo, preservePainterChatsGallery, PAINTER_GALLERY_DELETED_CHAT, PAINTER_GALLERY_UNASSIGNED, type GalleryGenerationInfo } from 'src/ts/bardPainter/gallery'
    import { readPainterImageMetadata } from 'src/ts/bardPainter/metadata'
    import { downloadFile, requestImmediateSave } from 'src/ts/globalApi.svelte'
    import { readArchiveFiles, usedInlayIds, writeArchiveFolder, zipArchiveFiles } from 'src/ts/bardPainter/galleryArchive'

    let { bot, disabled = false }: { bot: character; disabled?: boolean } = $props()
    type ThumbSize = 'small' | 'medium' | 'large'
    const sizeKey = 'risubard.painterGallery.thumbSize'
    function storedSize(): ThumbSize {
        try { const value = localStorage.getItem(sizeKey); return value === 'small' || value === 'large' ? value : 'medium' } catch { return 'medium' }
    }
    let thumbSize = $state<ThumbSize>(storedSize())
    function chooseSize(value: ThumbSize) { thumbSize = value; try { localStorage.setItem(sizeKey, value) } catch { /* Size is a per-browser convenience. */ } }
    const pageSize = $derived(thumbSize === 'small' ? 36 : thumbSize === 'large' ? 12 : 24)
    // Which images the bot's chats still show; read once per filter request, refreshed with the list.
    let usage = $state<'all' | 'used' | 'unused'>('all')
    let usedIds = $state<Set<string> | null>(null), usageLoading = $state(false), usageError = $state('')
    let usageVersion = 0
    let selected = $state<string[]>([])
    let rangeStart = ''
    let archiveOpen = $state(false), archiveMode = $state<'zip' | 'folder'>('zip'), archiveRemove = $state(true), archiving = $state(false)
    const folderSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window
    let items = $state<InlayExplorerItem[]>([])
    let loading = $state(false), deleting = $state(false), loadError = $state('')
    let deletingImageId = $state('')
    let chatFilter = $state(''), oldestFirst = $state(false), page = $state(0)
    let viewer = $state<InlayExplorerItem | null>(null), viewerOpen = $state(false)
    let info = $state<GalleryGenerationInfo | null>(null), infoLoading = $state(false), infoError = $state(''), originalChatName = $state('')
    let copiedBlock = $state<number | null>(null), imageError = $state(false)
    let loadVersion = 0, viewerVersion = 0
    let referenceBusy = $state(false), referenceError = $state(''), referenceNotice = $state(''), referencePendingScope = $state('')
    let referenceVersion = 0
    let galleryRoot = $state<HTMLElement | null>(null)
    const currentChat = $derived(bot.chats[bot.chatPage])
    const referenceScope = $derived(`${bot.chaId}\0${currentChat?.id ?? ''}\0${viewer?.id ?? ''}`)
    const currentReference = $derived(currentChat?.bardPainter?.settings.context.referenceAssetId
        || currentChat?.bardPainter?.results?.find(result => result.id === currentChat?.bardPainter?.settings.context.referenceId)?.assetId || '')
    const referenceAssigned = $derived(!!viewer && currentReference === viewer.id)
    const referenceReason = $derived.by(() => {
        if (!currentChat?.id || currentChat._placeholder || !Array.isArray(currentChat.message)) return '참고 삽화를 사용할 챗을 먼저 열어 주세요.'
        if (currentChat.isStreaming) return '메시지 생성을 마친 뒤 참고 삽화를 지정해 주세요.'
        if (disabled) return '진행 중인 작업을 마친 뒤 참고 삽화를 지정해 주세요.'
        if (referenceBusy) return '참고 설정을 저장 중입니다.'
        if (deleting) return '그림을 삭제 중입니다.'
        if (infoLoading) return '그림의 생성 정보를 확인하고 있습니다.'
        if (infoError) return '생성 정보를 불러오지 못해 참고 삽화를 지정할 수 없습니다.'
        if (!info?.blocks.some(block => block.text.trim())) return '생성 정보가 없는 그림은 참고 삽화로 지정할 수 없습니다.'
        return ''
    })
    const all = $derived(filterPainterGallery(items, bot.chaId, bot.chats))
    const byChat = $derived(filterPainterGallery(items, bot.chaId, bot.chats, chatFilter, oldestFirst))
    const filtered = $derived(usage === 'all' ? byChat : usedIds ? byChat.filter(item => usedIds!.has(item.id) === (usage === 'used')) : [])
    const selectedSet = $derived(new Set(selected))
    const selectedItems = $derived(filtered.filter(item => selectedSet.has(item.id)))
    const pageCount = $derived(Math.max(1, Math.ceil(filtered.length / pageSize)))
    const viewerIndex = $derived(filtered.findIndex(item => item.id === viewer?.id))
    const shown = $derived(filtered.slice(page * pageSize, (page + 1) * pageSize))
    const hasDeleted = $derived(all.some(item => !!item.meta?.chatId && !bot.chats.some(chat => chat.id === item.meta?.chatId)))
    const hasUnassigned = $derived(all.some(item => !item.meta?.chatId))
    const chatName = (id: string | undefined) => !id ? '미분류' : bot.chats.find(chat => chat.id === id)?.name || '삭제한 챗'
    const countFor = (id: string) => all.filter(item => item.meta?.chatId === id).length
    const date = (time: number | undefined) => time ? new Date(time).toLocaleString() : '생성 시각 없음'
    const url = (id: string, thumb = false) => `/api/asset/${Buffer.from(`${thumb ? 'inlay_thumb' : 'inlay'}/${id}`, 'utf-8').toString('hex')}`
    function goPage(offset: number) {
        page += offset
        galleryRoot?.scrollIntoView?.({ block: 'start' })
    }

    async function refresh() {
        const version = ++loadVersion, target = bot
        loading = true; loadError = ''
        try {
            // Old painter records migrate only for chats already loaded in memory.
            await preservePainterChatsGallery(target.chats.filter(chat => !chat._placeholder))
            const next = await listInlayExplorerItems(true)
            if (version === loadVersion) { items = next; usedIds = null; if (usage !== 'all') void loadUsage() }
        } catch (error) { if (version === loadVersion) loadError = String(error) }
        finally { if (version === loadVersion) loading = false }
    }

    $effect(() => {
        bot.chaId
        untrack(() => { items = []; chatFilter = ''; page = 0; viewerOpen = false; viewer = null; void refresh() })
        return () => { loadVersion++; viewerVersion++ }
    })
    $effect(() => { chatFilter; oldestFirst; usage; thumbSize; page = 0 })
    $effect(() => { chatFilter; usage; bot.chaId; untrack(() => { selected = []; rangeStart = ''; archiveOpen = false }) })

    async function loadUsage() {
        const version = ++usageVersion, target = bot
        usageLoading = true; usageError = ''
        try { const ids = await usedInlayIds(target); if (version === usageVersion) usedIds = ids }
        catch (error) { if (version === usageVersion) usageError = error instanceof Error ? error.message : String(error) }
        finally { if (version === usageVersion) usageLoading = false }
    }
    function chooseUsage(value: 'all' | 'used' | 'unused') {
        usage = value
        if (value !== 'all' && !usedIds && !usageLoading) void loadUsage()
    }
    function toggle(id: string) { selected = selectedSet.has(id) ? selected.filter(value => value !== id) : [...selected, id]; rangeStart = id }
    function tileClick(event: MouseEvent, item: InlayExplorerItem) {
        if (event.shiftKey && rangeStart) {
            const from = filtered.findIndex(entry => entry.id === rangeStart), to = filtered.findIndex(entry => entry.id === item.id)
            if (from >= 0 && to >= 0) {
                const range = filtered.slice(Math.min(from, to), Math.max(from, to) + 1).map(entry => entry.id)
                selected = [...new Set([...selected, ...range])]
                return
            }
        }
        // Once anything is selected, a plain click keeps selecting instead of opening the viewer.
        if (event.ctrlKey || event.metaKey || event.shiftKey || selected.length) { toggle(item.id); return }
        void openImage(item)
    }
    async function deleteSelected() {
        const targets = selectedItems
        if (!targets.length || disabled || deleting || loading || referenceBusy) return
        if (!await alertConfirm(`선택한 그림 ${targets.length}장을 삭제할까요? 이미지 파일과 생성 기록을 삭제합니다. 본문에 삽입한 그림도 더 이상 표시되지 않으며 되돌릴 수 없습니다.`)) return
        await deleteImages(targets, bot)
    }
    type ArchiveFolder = Parameters<typeof writeArchiveFolder>[0]
    async function archiveSelected() {
        const targets = selectedItems, targetBot = bot
        if (!targets.length || archiving || deleting || disabled) return
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
        archiving = true
        try {
            // Ask for the folder first: the browser allows the picker only right after the click.
            const directory = archiveMode === 'folder' ? await (window as unknown as { showDirectoryPicker(options: { mode: 'readwrite' }): Promise<ArchiveFolder> }).showDirectoryPicker({ mode: 'readwrite' }) : undefined
            const { files, ids, failed } = await readArchiveFiles(targets.map(item => ({ id: item.id, label: `${chatName(item.meta?.chatId)}_${item.meta?.createdAt ? new Date(item.meta.createdAt).toISOString().slice(0, 10) : 'image'}` })))
            if (!files.length) { notifyError('보관할 그림 파일을 읽지 못했습니다.'); return }
            let saved: Set<string>
            if (directory) saved = await writeArchiveFolder(directory, files)
            else {
                await downloadFile(`바드페인터-보관-${targetBot.name || 'bot'}-${stamp}.zip`, zipArchiveFiles(files))
                saved = new Set(ids)
            }
            const kept = targets.filter(item => saved.has(item.id))
            const missing = targets.length - kept.length
            if (archiveRemove && kept.length) {
                const used = usedIds ? kept.filter(item => usedIds!.has(item.id)).length : 0
                const question = `${directory ? '폴더에 저장한' : '내려받은 zip에 담은'} 그림 ${kept.length}장을 앱에서 지울까요?${directory ? '' : ' zip 파일이 저장됐는지 먼저 확인해 주세요.'}${used ? ` 이 중 ${used}장은 본문에 들어가 있어 본문에서도 사라집니다.` : ''}`
                if (await alertConfirm(question)) await deleteImages(kept, targetBot)
                else notifySuccess(`${kept.length}장을 보관했습니다. 앱의 그림은 그대로 둡니다.`)
            } else notifySuccess(`${kept.length}장을 보관했습니다.`)
            if (missing || failed.length) notifyError(`${missing}장은 보관하지 못해 앱에 그대로 둡니다.`)
            archiveOpen = false
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') return
            notifyError(`보관하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`)
        } finally { archiving = false }
    }
    $effect(() => { if (page >= pageCount) page = pageCount - 1 })
    $effect(() => { if (!referenceAssigned) referenceNotice = '' })
    $effect(() => {
        referenceScope; viewerOpen
        untrack(() => { referenceVersion++; referenceError = ''; referenceNotice = '' })
        return () => { referenceVersion++ }
    })

    async function assignReference() {
        if (!viewer || !viewerOpen || referenceReason || referenceAssigned || referenceBusy || !currentChat?.id) return
        // Gallery filtering and image ownership do not change the current chat assignment target.
        const characterId = bot.chaId, chatId = currentChat.id, assetId = viewer.id
        const version = referenceVersion, scope = referenceScope
        referenceBusy = true; referencePendingScope = scope; referenceError = ''; referenceNotice = ''
        try {
            const { getPainterSession } = await import('src/ts/bardPainter/runtime.svelte')
            const session = getPainterSession(characterId, chatId)
            const saved = await session.setReference(assetId)
            if (version !== referenceVersion) return
            if (!saved) { referenceError = session.state.error || '참고 삽화를 지정하지 못했습니다. 다시 시도해 주세요.'; return }
            referenceNotice = '참고 삽화로 지정했습니다.'
        } catch (cause) {
            if (version === referenceVersion) referenceError = cause instanceof Error ? cause.message : String(cause)
        } finally { referenceBusy = false; referencePendingScope = '' }
    }

    async function openImage(item: InlayExplorerItem) {
        const version = ++viewerVersion
        viewer = item; viewerOpen = true; info = null; infoLoading = true; infoError = ''; originalChatName = ''; copiedBlock = null; imageError = false
        try {
            const record = await loadPainterGalleryRecord(item.id)
            let next: GalleryGenerationInfo | null = null
            if (record) next = painterGalleryInfo(record)
            else {
                // Only this opened image is decoded; gallery thumbnails never fetch original bytes.
                const asset = await getInlayAssetBlob(item.id)
                if (asset) next = novelAiGalleryInfo(readPainterImageMetadata(new Uint8Array(await asset.data.arrayBuffer())))
            }
            if (version === viewerVersion) { info = next; originalChatName = record?.chatName ?? '' }
        } catch { if (version === viewerVersion) infoError = '생성 정보를 불러오지 못했습니다. 그림은 그대로 볼 수 있습니다.' }
        finally { if (version === viewerVersion) infoLoading = false }
    }

    async function copy(value: string, index: number) {
        try { await navigator.clipboard.writeText(value); copiedBlock = index }
        catch { notifyError('복사하지 못했습니다. 텍스트를 직접 선택해 복사해 주세요.') }
    }

    async function deleteChatImages() {
        if (!chatFilter || !filtered.length || disabled || deleting || loading || referenceBusy) return
        const targets = [...filtered], targetBot = bot
        const label = chatFilter === PAINTER_GALLERY_DELETED_CHAT ? '삭제한 챗' : chatFilter === PAINTER_GALLERY_UNASSIGNED ? '미분류' : chatName(chatFilter)
        if (!await alertConfirm(`「${label}」의 그림 ${targets.length}장을 모두 삭제할까요? 이미지 파일과 생성 기록을 삭제합니다. 본문에 삽입한 그림도 더 이상 표시되지 않으며 되돌릴 수 없습니다.`)) return
        await deleteImages(targets, targetBot)
    }

    async function deleteImages(targets: InlayExplorerItem[], targetBot: character) {
        if (disabled || deleting || loading || referenceBusy || !targets.length) return
        deleting = true; deletingImageId = targets.length === 1 ? targets[0].id : ''
        const removed = new Set<string>()
        try {
            const { isPainterChatBusy } = await import('src/ts/bardPainter/runtime.svelte')
            const targetIds = new Set(targets.map(item => item.id))
            const ownerIds = new Set(targets.map(item => item.meta?.chatId))
            const affectedChats = targetBot.chats.filter(chat => ownerIds.has(chat.id)
                || targetIds.has(chat.bardPainter?.settings.context.referenceAssetId ?? '')
                || chat.bardPainter?.results?.some(result => targetIds.has(result.assetId)))
            if (targets.some(item => item.meta?.chatId && isPainterChatBusy(targetBot.chaId, item.meta.chatId))
                || affectedChats.some(chat => chat.isStreaming || (chat.id && isPainterChatBusy(targetBot.chaId, chat.id))
                    || chat.bardPainter?.results?.some(result => targetIds.has(result.assetId) && result.compressionPending))) {
                notifyError('바드페인터 작업이나 이미지 저장을 마친 뒤 그림을 삭제해 주세요.')
                return
            }
            for (const item of targets) {
                try { await removeInlayAsset(item.id); removed.add(item.id) } catch { /* Report partial failure below. */ }
            }
            // Retire loaded legacy records so entering the gallery cannot recreate deleted sidecars.
            for (const chat of targetBot.chats) if (chat.bardPainter) {
                const data = chat.bardPainter, context = data.settings.context
                if (removed.has(context.referenceAssetId ?? '')) context.referenceAssetId = ''
                if (data.results?.some(result => result.id === context.referenceId && removed.has(result.assetId))) context.referenceId = ''
                data.results = (data.results ?? []).filter(result => !removed.has(result.assetId))
            }
            if (bot.chaId === targetBot.chaId) {
                items = items.filter(item => !removed.has(item.id))
                selected = selected.filter(id => !removed.has(id))
                if (viewer && removed.has(viewer.id)) { viewerOpen = false; viewer = null; viewerVersion++ }
            }
            if (removed.size) await requestImmediateSave({ flushServer: true, rejectOnFailure: true })
            if (removed.size !== targets.length) notifyError(`${removed.size}장 삭제, ${targets.length - removed.size}장 실패했습니다. 새로고침 후 다시 시도해 주세요.`)
            else notifySuccess(`${removed.size}장을 삭제했습니다.`)
        } catch (error) { notifyError(`그림 정리를 마치지 못했습니다: ${String(error)}`) }
        finally { deleting = false; deletingImageId = '' }
    }
</script>

<section bind:this={galleryRoot} data-painter-gallery class="space-y-3">
    <div class="flex items-center justify-between gap-2">
        <h3 class="font-semibold text-textcolor">그림 갤러리 <span class="text-sm font-normal text-textcolor2">{all.length}장</span></h3>
        <ShButton variant="ghost" size="icon-sm" aria-label="갤러리 새로고침" title="새로고침" disabled={disabled || loading || deleting} onclick={() => void refresh()}><RefreshCw size={16}/></ShButton>
    </div>
    <p class="text-xs leading-relaxed text-textcolor2">챗을 삭제해도 그림은 남습니다. 그림을 누르면 크게 보고 프롬프트를 복사하거나 참고 삽화로 지정할 수 있습니다.</p>
    <label class="block text-sm text-textcolor">챗
        <select aria-label="갤러리 챗" value={chatFilter} onchange={(event) => chatFilter = event.currentTarget.value} disabled={deleting} class="mt-1 w-full rounded-md border border-darkborderc bg-darkbg p-2 text-textcolor">
            <option value="">모두 ({all.length}장)</option>
            {#each bot.chats as chat (chat.id)}<option value={chat.id}>{chat.name || '이름 없는 챗'} ({countFor(chat.id)}장)</option>{/each}
            {#if hasDeleted || chatFilter === PAINTER_GALLERY_DELETED_CHAT}<option value={PAINTER_GALLERY_DELETED_CHAT}>삭제한 챗</option>{/if}
            {#if hasUnassigned || chatFilter === PAINTER_GALLERY_UNASSIGNED}<option value={PAINTER_GALLERY_UNASSIGNED}>미분류</option>{/if}
        </select>
    </label>
    <div class="flex flex-wrap items-center justify-between gap-2">
        <select aria-label="그림 생성 순서" value={oldestFirst ? 'oldest' : 'newest'} onchange={(event) => oldestFirst = event.currentTarget.value === 'oldest'} class="min-h-9 rounded-md border border-darkborderc bg-darkbg px-2 text-sm text-textcolor">
            <option value="newest">최근 생성순</option><option value="oldest">오래된 생성순</option>
        </select>
        {#if chatFilter}<ShButton variant="ghost" size="sm" className="text-draculared" disabled={disabled || deleting || loading || referenceBusy || !filtered.length} onclick={() => void deleteChatImages()}><Trash2 size={14}/>{deleting ? '삭제 중...' : '이 분류 모두 삭제'}</ShButton>{/if}
    </div>
    <div class="grid grid-cols-2 gap-2">
        <label class="text-xs text-textcolor2">본문 사용
            <select aria-label="본문 사용 여부" value={usage} onchange={(event) => chooseUsage(event.currentTarget.value as 'all' | 'used' | 'unused')} disabled={deleting} class="mt-1 min-h-9 w-full rounded-md border border-darkborderc bg-darkbg px-2 text-sm text-textcolor">
                <option value="all">모두</option><option value="used">챗에 들어간 그림</option><option value="unused">챗에 없는 그림</option>
            </select>
        </label>
        <label class="text-xs text-textcolor2">썸네일 크기
            <select aria-label="썸네일 크기" value={thumbSize} onchange={(event) => chooseSize(event.currentTarget.value as ThumbSize)} class="mt-1 min-h-9 w-full rounded-md border border-darkborderc bg-darkbg px-2 text-sm text-textcolor">
                <option value="small">작게</option><option value="medium">보통</option><option value="large">크게</option>
            </select>
        </label>
    </div>
    {#if usage !== 'all'}
        {#if usageLoading}<p role="status" class="flex items-center gap-2 text-xs text-textcolor2"><LoaderCircle size={14} class="animate-spin"/>모든 챗의 본문에서 그림 사용 여부를 확인하는 중...</p>
        {:else if usageError}<p role="alert" class="text-xs text-draculared">{usageError} <button type="button" class="underline" onclick={() => void loadUsage()}>다시 확인</button></p>
        {:else}<p class="text-xs leading-relaxed text-textcolor2">이 봇의 모든 챗 본문과 스와이프, 인사말, 로어북을 확인한 결과입니다.</p>{/if}
    {/if}
    <div data-gallery-selection class="flex flex-wrap items-center gap-2 rounded-md border border-darkborderc px-2 py-1.5">
        {#if selected.length}
            <span class="text-sm text-textcolor">{selectedItems.length}장 선택</span>
            <ShButton variant="ghost" size="sm" aria-label="선택 해제" onclick={() => { selected = []; archiveOpen = false }}><X size={14}/>해제</ShButton>
            <span class="flex-1"></span>
            <ShButton variant="outline" size="sm" aria-expanded={archiveOpen} disabled={disabled || deleting || archiving || !selectedItems.length} onclick={() => archiveOpen = !archiveOpen}><Archive size={14}/>보관하기</ShButton>
            <ShButton variant="ghost" size="sm" className="text-draculared" disabled={disabled || deleting || loading || referenceBusy || !selectedItems.length} onclick={() => void deleteSelected()}><Trash2 size={14}/>삭제</ShButton>
        {:else}
            <span class="text-xs text-textcolor2">Ctrl이나 Shift를 누른 채 클릭하거나 체크박스로 여럿 고릅니다.</span>
            <span class="flex-1"></span>
            <ShButton variant="ghost" size="sm" disabled={!filtered.length || loading} onclick={() => selected = filtered.map(item => item.id)}><Check size={14}/>모두 선택</ShButton>
        {/if}
    </div>
    {#if archiveOpen && selected.length}
        <div data-gallery-archive class="space-y-2 rounded-md border border-darkborderc bg-darkbg p-3 text-sm text-textcolor">
            <p class="text-xs leading-relaxed text-textcolor2">선택한 그림을 앱 밖으로 옮깁니다. 생성 기록이 있으면 같은 이름의 JSON 파일도 함께 저장합니다.</p>
            <label class="flex items-center gap-2"><input type="radio" name="gallery-archive-mode" value="zip" checked={archiveMode === 'zip'} onchange={() => archiveMode = 'zip'} class="accent-primary"/>zip 파일로 내려받기</label>
            <label class="flex items-center gap-2" class:opacity-50={!folderSupported}><input type="radio" name="gallery-archive-mode" value="folder" disabled={!folderSupported} checked={archiveMode === 'folder'} onchange={() => archiveMode = 'folder'} class="accent-primary"/>고른 폴더에 파일 그대로 저장</label>
            {#if !folderSupported}<p class="text-xs text-textcolor2">이 브라우저는 폴더 저장을 지원하지 않습니다. Chrome이나 Edge에서 사용할 수 있습니다.</p>{/if}
            <label class="flex items-center gap-2"><input type="checkbox" bind:checked={archiveRemove} class="accent-primary"/>보관한 뒤 앱에서 지우기 (지우기 전에 한 번 더 묻습니다)</label>
            <div class="flex justify-end gap-2">
                <ShButton variant="ghost" size="sm" onclick={() => archiveOpen = false}>취소</ShButton>
                <ShButton variant="primary" size="sm" disabled={archiving || deleting || !selectedItems.length} onclick={() => void archiveSelected()}>{#if archiving}<LoaderCircle size={14} class="animate-spin"/>보관 중...{:else}<Archive size={14}/>{selectedItems.length}장 보관{/if}</ShButton>
            </div>
        </div>
    {/if}
    {#if loadError}<p role="alert" class="text-sm text-draculared">그림 목록을 불러오지 못했습니다. 새로고침으로 다시 시도해 주세요.</p>{/if}
    {#if loading && !items.length}<p role="status" class="py-8 text-center text-sm text-textcolor2">그림 목록을 불러오는 중...</p>
    {:else if usage !== 'all' && !usedIds}<p role="status" class="py-8 text-center text-sm text-textcolor2">{usageError ? '사용 여부를 확인하지 못했습니다.' : '확인하는 중...'}</p>
    {:else if !filtered.length}<div class="rounded-md border border-dashed border-darkborderc p-6 text-center text-textcolor2"><Images size={28} class="mx-auto mb-2"/><p class="text-sm">이 분류에는 그림이 없습니다.</p></div>
    {:else}
        <div class="grid gap-2" class:grid-cols-3={thumbSize === 'small'} class:grid-cols-2={thumbSize === 'medium'} class:grid-cols-1={thumbSize === 'large'}>
            {#each shown as item (item.id)}
                <div class="relative min-w-0">
                    <button data-gallery-image={item.id} aria-pressed={selectedSet.has(item.id)} class="w-full overflow-hidden rounded-md border bg-darkbg text-left text-textcolor focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50 {selectedSet.has(item.id) ? 'border-primary ring-2 ring-primary' : 'border-darkborderc'}" disabled={disabled} onclick={(event) => tileClick(event, item)} aria-label={`${chatName(item.meta?.chatId)}, ${date(item.meta?.createdAt)} 그림 ${selected.length ? '선택' : '확대'}`}>
                        <img src={url(item.id, true)} alt="" loading="lazy" class="w-full object-cover" class:aspect-square={thumbSize !== 'large'}/>
                        {#if thumbSize !== 'small'}<span class="block truncate px-2 pt-1 text-xs">{chatName(item.meta?.chatId)}</span><span class="block truncate px-2 pb-2 text-[10px] text-textcolor2">{date(item.meta?.createdAt)}</span>{/if}
                    </button>
                    <input type="checkbox" data-gallery-check={item.id} aria-label={`${chatName(item.meta?.chatId)}, ${date(item.meta?.createdAt)} 그림 선택`} checked={selectedSet.has(item.id)} onclick={(event) => { if (event.shiftKey && rangeStart) { event.preventDefault(); tileClick(event, item) } }} onchange={() => toggle(item.id)} class="absolute left-1.5 top-1.5 h-4 w-4 cursor-pointer accent-primary"/>
                    <ShButton data-gallery-delete={item.id} variant="secondary" size="icon-sm" className="absolute right-1.5 top-1.5 text-danger shadow-sm" aria-label={`${chatName(item.meta?.chatId)}, ${date(item.meta?.createdAt)} 그림 삭제`} title="그림 즉시 삭제. 본문에 삽입한 그림도 사라집니다." aria-busy={deletingImageId === item.id} disabled={disabled || deleting || loading || referenceBusy} onclick={() => void deleteImages([item], bot)}>
                        {#if deletingImageId === item.id}<LoaderCircle size={16} class="animate-spin motion-reduce:animate-none"/>{:else}<Trash2 size={16}/>{/if}
                    </ShButton>
                </div>
            {/each}
        </div>
        <nav aria-label="그림 갤러리 페이지" class="flex items-center justify-center gap-2">
            <ShButton variant="outline" size="icon-sm" aria-label="이전 그림 페이지" disabled={page === 0} onclick={() => goPage(-1)}><ChevronLeft size={16}/></ShButton>
            <span class="text-sm text-textcolor2">{page + 1} / {pageCount}</span>
            <ShButton variant="outline" size="icon-sm" aria-label="다음 그림 페이지" disabled={page + 1 >= pageCount} onclick={() => goPage(1)}><ChevronRight size={16}/></ShButton>
        </nav>
    {/if}
</section>

<ShDialog bind:open={viewerOpen} size="xl" closeOnEscape contentClass="max-w-6xl" closeAriaLabel="그림 닫기">
    {#snippet title()}그림 보기{/snippet}
    {#if viewer}
        <div class="grid gap-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <div class="min-w-0">
                {#if imageError}<p class="p-8 text-center text-textcolor2">이미지를 불러올 수 없습니다.</p>{:else}<img src={url(viewer.id)} alt={`${chatName(viewer.meta?.chatId)}의 삽화`} class="max-h-[72vh] w-full rounded-md object-contain" onerror={() => imageError = true}/>{/if}
                <div class="mt-2 flex items-center justify-center gap-2">
                    <ShButton variant="outline" size="icon-sm" aria-label="이전 그림" disabled={viewerIndex <= 0} onclick={() => void openImage(filtered[viewerIndex - 1])}><ChevronLeft size={16}/></ShButton>
                    <span class="text-sm text-textcolor2">{viewerIndex + 1} / {filtered.length}</span>
                    <ShButton variant="outline" size="icon-sm" aria-label="다음 그림" disabled={viewerIndex < 0 || viewerIndex + 1 >= filtered.length} onclick={() => void openImage(filtered[viewerIndex + 1])}><ChevronRight size={16}/></ShButton>
                </div>
            </div>
            <div class="min-w-0 space-y-3 md:max-h-[76vh] md:overflow-y-auto md:pr-1">
                <p class="text-sm text-textcolor">{chatName(viewer.meta?.chatId)}{#if chatName(viewer.meta?.chatId) === '삭제한 챗' && originalChatName} / {originalChatName}{/if}</p>
                <p class="text-xs text-textcolor2">{date(viewer.meta?.createdAt)}{#if viewer.width && viewer.height} / {viewer.width} × {viewer.height}{/if}</p>
                <div class="space-y-2 rounded-md border border-darkborderc p-3">
                    <p class="text-xs text-textcolor2">현재 챗: {currentChat?.name || '열린 챗 없음'}</p>
                    <div class="flex flex-wrap gap-2">
                        <ShButton data-gallery-reference variant="primary" size="sm" disabled={!!referenceReason || referenceAssigned} onclick={() => void assignReference()}><Check size={14}/>{referenceBusy && referencePendingScope === referenceScope ? '지정하는 중...' : referenceAssigned ? '참고 삽화로 지정됨' : '참고 삽화 지정'}</ShButton>
                        <ShButton variant="outline" size="sm" onclick={() => void copy(`{{inlay::${viewer!.id}}}`, -1)}><Copy size={14}/>{copiedBlock === -1 ? '복사됨' : '본문 삽입 코드 복사'}</ShButton>
                    </div>
                    {#if referenceReason}<p class="text-xs text-textcolor2">{referenceReason}</p>{/if}
                    {#if referenceNotice}<p role="status" class="text-xs text-textcolor2">{referenceNotice}</p>{/if}
                    {#if referenceError}<p data-gallery-reference-error role="alert" class="text-sm text-draculared">{referenceError}</p>{/if}
                </div>
                {#if infoLoading}<p role="status" class="text-sm text-textcolor2">생성 정보를 불러오는 중...</p>{:else if infoError}<p role="status" class="text-sm text-textcolor2">{infoError}</p>
                {:else if info}
                    {#each info.blocks as block, index}
                        <section class="rounded-md border border-darkborderc bg-darkbg p-3">
                            <div class="mb-2 flex items-center justify-between gap-2"><h4 class="text-sm font-medium">{block.title}</h4><ShButton variant="ghost" size="sm" aria-label={`${block.title} 복사`} onclick={() => void copy(block.text, index)}><Copy size={14}/>{copiedBlock === index ? '복사됨' : '복사'}</ShButton></div>
                            <p class="select-text whitespace-pre-wrap break-words text-sm leading-relaxed text-textcolor2">{block.text}</p>
                        </section>
                    {/each}
                    <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-textcolor2">{#each info.settings as [label, value]}<dt>{label}</dt><dd class="break-words">{value}</dd>{/each}</dl>
                {:else}<p class="text-sm text-textcolor2">저장된 생성 정보가 없는 그림입니다.</p>{/if}
            </div>
        </div>
    {/if}
</ShDialog>
