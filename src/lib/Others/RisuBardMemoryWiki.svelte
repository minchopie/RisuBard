<script lang="ts">
    import { onMount, tick, untrack } from 'svelte'
    import { resolveDynamicMemorySettings } from 'src/ts/risubard/dynamicMemoryBudget'
    import { summarizeWikiBacklog } from 'src/ts/risubard/wikiBacklog'
    import { painterInsertionRequest } from 'src/ts/bardPainter/selectionState'
    import {
        BookOpenIcon,
        CheckCircle2Icon,
        Clock3Icon,
        LoaderCircleIcon,
        LogsIcon,
        PanelRightCloseIcon,
        NetworkIcon,
        RefreshCwIcon,
        ChevronDownIcon,
        ChevronLeftIcon,
        ChevronRightIcon,
        SquareTerminalIcon,
        MonitorIcon,
        SmartphoneIcon,
        XCircleIcon,
        XIcon,
        Maximize2Icon,
        Minimize2Icon,
    } from '@lucide/svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte'
    import { language } from 'src/lang'
    import { forageStorage, downloadFile } from 'src/ts/globalApi.svelte'
    import ShDropdownMenu from 'src/lib/UI/GUI/ShDropdownMenu.svelte'
    import ShDropdownMenuTrigger from 'src/lib/UI/GUI/ShDropdownMenuTrigger.svelte'
    import ShDropdownMenuContent from 'src/lib/UI/GUI/ShDropdownMenuContent.svelte'
    import ShDropdownMenuItem from 'src/lib/UI/GUI/ShDropdownMenuItem.svelte'
    import RisuBardWikiExportDialog from './RisuBardWikiExportDialog.svelte'
    import { createWikiPackage, serializeWikiPackage, parseWikiPackage, importWikiPackage, startChatWithWiki, WIKI_PACKAGE_MAX_BYTES } from 'src/ts/risubard/wikiTransfer'
    import {
        normalizeMemoryWikiDockRatio,
        normalizeMemoryWikiWorkspaceHeight,
    } from 'src/ts/risubard/memoryWikiLayout'
    import {
        getBardChatUndoStatus,
        loadNarrativeMemoryWikiCatalog,
        loadWikiDocumentBodies,
        loadWikiStorySummaries,
        restoreBardChatUndo,
        searchWikiDocuments,
        warmWikiCatalog,
        type NarrativeMemoryWiki,
        type NarrativeMemoryWikiCatalog,
        type NarrativeMemoryWikiDocument,
        type WikiCatalogDocument,
    } from 'src/ts/risubard/memoryWiki'
    import { findStoryArcDocument } from 'src/ts/risubard/storyArcView'
    import {
        RISUBARD_MEMORY_UPDATED_EVENT,
        type RisuBardMemoryUpdatedDetail,
    } from 'src/ts/risubard/memoryEvents'
    import { DBState } from 'src/ts/stores.svelte'
    import RisuBardWikiEditor from './RisuBardWikiEditor.svelte'
    import RisuBardMemoryActivity from './RisuBardMemoryActivity.svelte'
    import RisuBardStorySoFar from './RisuBardStorySoFar.svelte'
    import RisuBardStoryArcPlot from './RisuBardStoryArcPlot.svelte'
    import RisuBardWikiCommandTerminal from './RisuBardWikiCommandTerminal.svelte'
    import RisuBardMemoryWikiHelp from './RisuBardMemoryWikiHelp.svelte'
    import RisuBardCurrentChatSettings from './RisuBardCurrentChatSettings.svelte'
    import RisuBardOocNotepad from './RisuBardOocNotepad.svelte'
    import SolarChatRoundQuestionMarkBold from 'src/lib/UI/Icons/SolarChatRoundQuestionMarkBold.svelte'
    import SolarPen2Bold from 'src/lib/UI/Icons/SolarPen2Bold.svelte'
    import ManagerResizeHandles from 'src/lib/UI/GUI/ManagerResizeHandles.svelte'
    import SolarBoldIcon from 'src/lib/UI/Icons/SolarBoldIcon.svelte'
    import forceUpdateIdle from 'src/assets/risubard-memory/additional-analysis-idle.png'
    import forceUpdateHover from 'src/assets/risubard-memory/additional-analysis-hover.gif'
    import type {
        DirectWikiCommandResult,
        DirectWikiContextSelection,
    } from 'src/ts/risubard/directWikiCommand'
    import type { StorySourceRef } from 'src/ts/risubard/storySoFar'
    import { alertConfirm, alertError } from 'src/ts/alert'
    import {
        resolveWikiRebootViewChatId,
        type WikiRebootBatchSize,
        type WikiRebootJob,
    } from 'src/ts/risubard/wikiReboot'
    import {
        resolveRisuBardChatSettings,
    } from 'src/ts/risubard/risuBardSettings'
    import { normalizeArcPlotterRuntimeSettings } from 'src/ts/risubard/arcPlotterSettings'
    import { isWikiGenerating, beginWikiGeneration, endWikiGeneration } from 'src/ts/risubard/wikiGenerationState'
    import { isAnyGenerating } from 'src/ts/process/generationState'

    interface Props {
        open?: boolean
        characterId: string
        chatId: string
        onForceWikiUpdate?: () => Promise<boolean>
        onRetryWikiBacklog?: () => Promise<void>
        onSkipWikiBacklogTurn?: (messageId: string) => boolean
        rebootJob?: WikiRebootJob
        onStartWikiReboot?: (
            batchSize: WikiRebootBatchSize,
            startChatIndex: number
        ) => Promise<boolean>
        onStopWikiReboot?: () => Promise<boolean>
        onResumeWikiReboot?: () => Promise<boolean>
        onCancelWikiReboot?: () => Promise<boolean>
        onExecuteWikiCommand?: (
            instruction: string,
            contextSelection: DirectWikiContextSelection
        ) => Promise<DirectWikiCommandResult>
        onNavigateStorySource?: (source: StorySourceRef) => void
        onNavigateOocMessage?: (index: number) => void
    }

    type MemoryWikiLayout = 'desktop' | 'mobile'

    let {
        open = $bindable(false),
        characterId,
        chatId,
        onForceWikiUpdate,
        onRetryWikiBacklog,
        onSkipWikiBacklogTurn,
        rebootJob,
        onStartWikiReboot,
        onStopWikiReboot,
        onResumeWikiReboot,
        onCancelWikiReboot,
        onExecuteWikiCommand,
        onNavigateStorySource,
        onNavigateOocMessage,
    }: Props = $props()
    // The dock loads a table of contents; page bodies, story summaries and
    // export data are fetched only when a view needs them.
    let wiki = $state<NarrativeMemoryWikiCatalog | null>(null)
    let bodies = $state.raw(new Map<string, NarrativeMemoryWikiDocument>())
    const pendingBodies = new Map<string, Promise<void>>()
    let storySummaries = $state.raw<Map<string, string[]> | null>(null)
    let storyLoading = $state(false)
    let loading = $state(false)
    let transferBusy = $state(false)
    let exportOpen = $state(false)
    let exportScope = ''
    let importInput: HTMLInputElement
    let importScope: { characterId: string; chatId: string } | undefined
    let transferStatus = $state('')

    async function startWithWiki() {
        if (transferBlocked) return
        const scope = { characterId, chatId }
        transferBusy = true
        try { await startChatWithWiki(scope) }
        catch (cause) { alertError(cause) }
        finally { transferBusy = false }
    }

    // The dialog lists the catalog right away; only the chosen pages' bodies are fetched on export.
    async function exportWiki(selectedIds: string[]) {
        if (transferBlocked || exportScope !== `${characterId}\u0000${chatId}`) throw new Error('위키가 변경되었습니다. 내보내기 창을 다시 열어 주세요.')
        const chosen: NarrativeMemoryWikiDocument[] = []
        for (let index = 0; index < selectedIds.length; index += 256) {
            chosen.push(...await loadWikiDocumentBodies({ ...wikiScope(), documentIds: selectedIds.slice(index, index + 256) }))
        }
        await downloadFile('wiki.bardwiki.json', serializeWikiPackage(createWikiPackage(chosen, selectedIds)))
        exportOpen = false
    }

    async function importFile(file: File | undefined, scope = { characterId, chatId }) {
        if (!file || transferBlocked) return
        if (file.size > WIKI_PACKAGE_MAX_BYTES) { alertError('위키 파일은 16MB까지 들여올 수 있습니다.'); return }
        if (scope.characterId !== characterId || scope.chatId !== chatId) { alertError('채팅이 변경되었습니다. 파일을 다시 선택해 주세요.'); return }
        transferBusy = true
        transferStatus = ''
        const operationId = `wiki-import:${crypto.randomUUID()}`
        let locked = false
        try {
            const pack = parseWikiPackage(await file.text())
            if (scope.characterId !== characterId || scope.chatId !== chatId || $isWikiGenerating || $isAnyGenerating || forceUpdating || rebootJob || currentChat?.isStreaming) throw new Error('채팅이나 진행 중인 작업이 변경되었습니다. 파일을 다시 선택해 주세요.')
            beginWikiGeneration(operationId)
            locked = true
            const result = await importWikiPackage({ ...scope, package: pack, fetchImpl: fetch, createAuth: () => forageStorage.createAuth() })
            if (scope.characterId === characterId && scope.chatId === chatId) {
                transferStatus = `${result.imported}개 위키 항목을 들여왔습니다.`
                await loadWiki()
            }
        } catch (cause) { alertError(cause) }
        finally {
            if (locked) endWikiGeneration(operationId)
            transferBusy = false
        }
    }
    let error = $state('')
    // Failures of one part (a page body, story summaries) stay inline instead of hiding the dock.
    let inlineError = $state('')
    let inlineRetry = $state.raw<(() => void) | null>(null)
    let forceUpdating = $state(false)
    let forceUpdateStatus = $state<'success' | 'empty' | 'failed' | ''>('')
    let forceUpdateError = $state('')
    let forceUpdateMeta = $state<{ turn: number; completedAt: number } | null>(
        null
    )
    let requestSequence = 0
    let loadAbortController: AbortController | undefined
    let loadedScope = ''
    let dockElement = $state<HTMLElement | null>(null)
    let workspaceSplitElement = $state<HTMLElement | null>(null)
    let activeView = $state<'painter' | 'ooc' | 'workspace' | 'story' | 'arc-plot' | 'log'>('workspace')
    let painterLoadError = $state('')
    let settingsOpen = $state(false)
    let settingsPopoverElement = $state<HTMLElement | null>(null)
    let settingsButtonElement = $state<HTMLButtonElement | null>(null)
    // Leaving the workspace unmounts the editor, so an unsaved draft would be lost.
    let editorDirty = $state(false)

    async function switchView(next: typeof activeView) {
        if (next === activeView) return
        if (activeView === 'workspace' && editorDirty
            && !await alertConfirm('저장하지 않은 편집이 있습니다. 다른 보기로 가면 편집 내용이 사라집니다. 이동할까요?')) return
        editorDirty = false
        activeView = next
        if (next === 'painter') settingsOpen = false
    }

    async function toggleSettings(next: boolean) {
        settingsOpen = next
        await tick()
        if (next) settingsPopoverElement?.querySelector<HTMLElement>('input, select, button, textarea')?.focus()
        else settingsButtonElement?.focus()
    }

    // Close the settings popover when the pointer goes down outside it.
    $effect(() => {
        if (!settingsOpen) return
        const closeOutside = (event: PointerEvent) => {
            const target = event.target as Element | null
            if (!target || settingsPopoverElement?.contains(target) || settingsButtonElement?.contains(target)) return
            if (target.closest?.('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return
            settingsOpen = false
        }
        window.addEventListener('pointerdown', closeOutside, true)
        return () => window.removeEventListener('pointerdown', closeOutside, true)
    })
    let layoutMode = $state<MemoryWikiLayout>('desktop')
    let dockViewsElement = $state<HTMLElement | null>(null)
    let dockViewsOverflow = $state({ start: false, end: false })
    function updateDockViewsOverflow() {
        const element = dockViewsElement
        if (!element) return
        const start = element.scrollLeft > 1
        const end = element.scrollWidth - element.clientWidth - element.scrollLeft > 1
        if (start !== dockViewsOverflow.start || end !== dockViewsOverflow.end) dockViewsOverflow = { start, end }
    }
    function scrollDockViews(direction: -1 | 1) {
        const element = dockViewsElement
        if (!element) return
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        element.scrollBy({ left: direction * element.clientWidth * .7, behavior: reduceMotion ? 'auto' : 'smooth' })
    }
    // 좁은 폭에서 툴바가 가로로 넘치면 양 끝에 화살표를 띄워 숨은 버튼이 있음을 알린다.
    $effect(() => {
        const element = dockViewsElement
        if (!element) return
        let frame = 0
        const schedule = () => {
            cancelAnimationFrame(frame)
            frame = requestAnimationFrame(updateDockViewsOverflow)
        }
        const resizeObserver = new ResizeObserver(schedule)
        resizeObserver.observe(element)
        const mutationObserver = new MutationObserver(schedule)
        mutationObserver.observe(element, { childList: true, subtree: true })
        schedule()
        return () => {
            cancelAnimationFrame(frame)
            resizeObserver.disconnect()
            mutationObserver.disconnect()
        }
    })
    $effect(() => {
        if (layoutMode === 'mobile' && $painterInsertionRequest?.characterId === characterId && $painterInsertionRequest.chatId === chatId) open = false
    })
    let layoutManuallySelected = false
    let dockRatio = $state(normalizeMemoryWikiDockRatio(
        DBState.db.risuBardMemoryDockRatio
    ))
    let workspaceHeight = $state(normalizeMemoryWikiWorkspaceHeight(
        DBState.db.risuBardMemoryWorkspaceHeight
    ))
    let commandExpanded = $state(DBState.db.risuBardMemoryCommandExpanded === true)
    let compactView = $state(DBState.db.risuBardMemoryCompactView === true)
    let editorFieldsExpanded = $state(DBState.db.risuBardMemoryEditorFieldsExpanded === true)
    // 집중 보기는 데스크톱 전용이다. 모바일은 자체 접기 레이아웃을 쓴다.
    let compactActive = $derived(compactView && layoutMode === 'desktop')
    let editorFocus = $state(false)
    let helpOpen = $state(false)
    let selectedMarkdownId = $state('')
    let bardChatUpdatedIds = $state<string[] | null>(null)
    let bardChatUndoAvailable = $state(false)
    let rebootChooserOpen = $state(false)
    let rebootActionBusy = $state(false)
    let rebootStartChatIndex = $state(0)
    let wikiChatId = $derived(resolveWikiRebootViewChatId(chatId, rebootJob))

    let markdownDocuments = $derived<WikiCatalogDocument[]>(
        wiki?.mode === 'markdown'
            ? wiki.documents.map((document) => {
                const body = bodies.get(document.id)
                return body && body.contentHash === document.contentHash
                    ? body : document
            })
            : []
    )
    let selectedMarkdownDocument = $derived(markdownDocuments.find(
        (document) => document.id === selectedMarkdownId
    ) ?? null)
    let activityMessages = $derived(
        DBState.db.characters?.find((character) =>
            character.chaId === characterId
        )?.chats.find((chat) => chat.id === chatId)?.message ?? []
    )
    let currentCharacter = $derived(
        DBState.db.characters?.find((character) =>
            character.chaId === characterId
        )
    )
    let currentChat = $derived(currentCharacter?.chats.find((chat) => chat.id === chatId))
    // Shown only once a waiting turn has actually failed, not while it is being analyzed.
    let wikiBacklog = $derived(currentChat?.message ? summarizeWikiBacklog(currentChat.message) : { count: 0 })
    let wikiBacklogBusy = $state(false)
    async function retryWikiBacklog() {
        if (!onRetryWikiBacklog || wikiBacklogBusy) return
        wikiBacklogBusy = true
        try { await onRetryWikiBacklog() }
        finally { wikiBacklogBusy = false }
    }
    async function skipWikiBacklogTurn() {
        const messageId = wikiBacklog.oldest?.messageId
        if (!messageId || !onSkipWikiBacklogTurn
            || !await alertConfirm(language.risuBardWikiBacklogSkipConfirm, { tier: 'top' })) return
        onSkipWikiBacklogTurn(messageId)
        if (wikiBacklog.count > 0) await retryWikiBacklog()
    }
    let painterChatReady = $derived(!!currentChat && !currentChat._placeholder && Array.isArray(currentChat.message))
    let resolvedChatSettings = $derived(resolveRisuBardChatSettings(
        DBState.db,
        currentChat?.risuBardSettings,
        currentCharacter?.risuBardPinnedSettings,
    ))
    let transferBlocked = $derived(loading || forceUpdating || transferBusy || $isWikiGenerating || $isAnyGenerating || !!rebootJob || !!currentChat?.isStreaming || wiki?.mode !== 'markdown')
    let arcPlotterSettings = $derived(normalizeArcPlotterRuntimeSettings({
        enabled: DBState.db.risuBardArcPlotterEnabled,
        checkpointSize: DBState.db.risuBardArcPlotterCheckpointSize,
        maxArcs: DBState.db.risuBardArcPlotterMaxArcs,
        maxTurningPoints: DBState.db.risuBardArcPlotterMaxTurningPoints,
        maxOpenThreads: DBState.db.risuBardArcPlotterMaxOpenThreads,
        maxCharacters: DBState.db.risuBardArcPlotterMaxCharacters,
    }))
    let bardChatContextSelection = $derived<DirectWikiContextSelection>({
        wiki: resolvedChatSettings.bardChatIncludeWiki,
        chat: resolvedChatSettings.bardChatIncludeChat,
        systemPrompt: resolvedChatSettings.bardChatIncludeSystemPrompt,
        characterDescription:
            resolvedChatSettings.bardChatIncludeCharacterDescription,
        persona: resolvedChatSettings.bardChatIncludePersona,
        characterLorebook:
            resolvedChatSettings.bardChatIncludeCharacterLorebook,
        moduleLorebook: resolvedChatSettings.bardChatIncludeModuleLorebook,
    })
    let rebootLastChatIndex = $derived((currentChat?.message.length ?? 0) - 1)
    let rebootStartChatIndexValid = $derived(
        Number.isInteger(rebootStartChatIndex)
        && rebootStartChatIndex >= 0
        && rebootStartChatIndex <= rebootLastChatIndex
    )
    let rebootAnalysisTokenLimit = $derived(
        resolveDynamicMemorySettings(resolvedChatSettings, currentChat?.message ?? []).risuBardAnalysisTokenLimit
    )
    let rebootButtonLabel = $derived.by(() => {
        if (!rebootJob) return language.risuBardWikiReboot
        if (rebootJob.status === 'paused' || rebootJob.status === 'failed') {
            return language.risuBardWikiRebootResume
        }
        if (rebootJob.status === 'stop-requested') {
            return language.risuBardWikiRebootStopping
        }
        if (rebootJob.status === 'finalizing') {
            return language.risuBardWikiRebootFinalizing
        }
        return language.risuBardWikiRebootStop
    })
    let rebootProgress = $derived.by(() => {
        if (!rebootJob) return undefined
        const total = rebootJob.targetAssistantMessageIds.length
        const completed = Math.min(
            rebootJob.completedAssistantMessageIds.length,
            total
        )
        const percent = total > 0
            ? Math.round((completed / total) * 100)
            : 0
        return { completed, total, percent }
    })

    onMount(() => {
        const media = window.matchMedia?.('(max-width: 840px)')
        const syncLayout = () => {
            if (layoutManuallySelected) return
            layoutMode = (media?.matches ?? window.innerWidth <= 840)
                ? 'mobile'
                : 'desktop'
        }
        syncLayout()
        media?.addEventListener('change', syncLayout)
        return () => media?.removeEventListener('change', syncLayout)
    })

    function setCommandExpanded(value: boolean) {
        commandExpanded = value
        DBState.db.risuBardMemoryCommandExpanded = value
    }

    function setEditorFieldsExpanded(value: boolean) {
        editorFieldsExpanded = value
        DBState.db.risuBardMemoryEditorFieldsExpanded = value
    }

    function toggleCompactView() {
        compactView = !compactView
        DBState.db.risuBardMemoryCompactView = compactView
        if (!compactView) return
        setCommandExpanded(false)
        setEditorFieldsExpanded(false)
    }

    function toggleLayout() {
        layoutManuallySelected = true
        layoutMode = layoutMode === 'mobile' ? 'desktop' : 'mobile'
    }

    async function handleRebootAction() {
        if (rebootActionBusy) return
        if (!rebootJob) {
            if (!await alertConfirm(language.risuBardWikiRebootWarning, { tier: 'top' })) return
            rebootChooserOpen = true
            return
        }
        rebootActionBusy = true
        try {
            if (rebootJob.status === 'running') {
                await onStopWikiReboot?.()
            }
            else if (rebootJob.status === 'paused'
                || rebootJob.status === 'failed') {
                const operation = onResumeWikiReboot?.()
                rebootActionBusy = false
                void operation?.catch((cause) => alertError(cause))
            }
        }
        catch (cause) {
            alertError(cause)
        }
        finally {
            rebootActionBusy = false
        }
    }

    function startReboot(batchSize: WikiRebootBatchSize) {
        if (!rebootStartChatIndexValid) return
        rebootChooserOpen = false
        rebootActionBusy = true
        const operation = onStartWikiReboot?.(batchSize, rebootStartChatIndex)
        rebootActionBusy = false
        void operation?.catch((cause) => {
            alertError(cause)
        })
    }

    async function cancelReboot() {
        if (!await alertConfirm(language.risuBardWikiRebootCancelWarning, { tier: 'top' })) return
        rebootActionBusy = true
        try {
            await onCancelWikiReboot?.()
        }
        catch (cause) {
            alertError(cause)
        }
        finally {
            rebootActionBusy = false
        }
    }

    async function loadWiki() {
        loadAbortController?.abort()
        const controller = new AbortController()
        loadAbortController = controller
        const sequence = ++requestSequence
        const scope = `${characterId}\u0000${wikiChatId}`
        const refreshingCurrentScope = loadedScope === scope
        if (!refreshingCurrentScope) {
            wiki = null
            selectedMarkdownId = ''
            transferStatus = ''
            forceUpdateStatus = ''
            settingsOpen = false
            inlineError = ''
            exportOpen = false
            bodies = new Map()
            pendingBodies.clear()
        }
        storySummaries = null
        loading = true
        error = ''
        try {
            const loaded = await loadNarrativeMemoryWikiCatalog({
                characterId,
                chatId: wikiChatId,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
                signal: controller.signal,
            })
            if (sequence === requestSequence) {
                wiki = loaded
                loadedScope = scope
            }
            if (sequence === requestSequence && loaded.mode === 'markdown'
                && !loaded.documents.some((document) =>
                    document.id === selectedMarkdownId
                )) {
                selectedMarkdownId = loaded.documents[0]?.id ?? ''
            }
        }
        catch (cause) {
            if (sequence === requestSequence) {
                wiki = null
                error = cause instanceof Error
                    ? cause.message
                    : String(cause)
            }
        }
        finally {
            if (loadAbortController === controller) {
                loadAbortController = undefined
            }
            if (sequence === requestSequence) loading = false
        }
    }

    function wikiScope() {
        return {
            characterId,
            chatId: wikiChatId,
            fetchImpl: fetch,
            createAuth: () => forageStorage.createAuth(),
        }
    }

    function hasCurrentBody(documentId: string): boolean {
        const entry = wiki?.mode === 'markdown'
            ? wiki.documents.find((document) => document.id === documentId)
            : undefined
        const body = bodies.get(documentId)
        return !!entry && !!body && body.contentHash === entry.contentHash
    }

    async function requestBodies(documentIds: readonly string[]): Promise<void> {
        const scope = loadedScope
        const waiting: Promise<void>[] = []
        const wanted: string[] = []
        for (const id of new Set(documentIds)) {
            const pending = pendingBodies.get(id)
            if (pending) waiting.push(pending)
            else if (!hasCurrentBody(id)) wanted.push(id)
        }
        if (wanted.length > 0) {
            const load = loadWikiDocumentBodies({ ...wikiScope(), documentIds: wanted })
                .then((loaded) => {
                    if (scope !== loadedScope) return
                    const next = new Map(bodies)
                    for (const document of loaded) next.set(document.id, document)
                    bodies = next
                })
                .finally(() => {
                    for (const id of wanted) pendingBodies.delete(id)
                })
            for (const id of wanted) pendingBodies.set(id, load)
            waiting.push(load)
        }
        await Promise.all(waiting)
    }

    async function loadDocumentBody(documentId: string): Promise<NarrativeMemoryWikiDocument> {
        await requestBodies([documentId])
        const body = bodies.get(documentId)
        if (!body) throw new Error('위키 문서를 찾을 수 없습니다. 위키를 새로고침해 주세요.')
        return body
    }

    async function searchDocumentIds(query: string): Promise<Set<string>> {
        return new Set(await searchWikiDocuments({ ...wikiScope(), query }))
    }

    async function loadStorySummaries() {
        const scope = loadedScope
        storyLoading = true
        try {
            const loaded = await loadWikiStorySummaries(wikiScope())
            if (scope === loadedScope) storySummaries = loaded
        }
        catch (cause) {
            if (scope === loadedScope) {
                showInlineError(cause, () => { storySummaries = null })
                // An empty result stops the view from retrying in a loop; the banner retries.
                storySummaries = new Map()
            }
        }
        finally {
            storyLoading = false
        }
    }

    function showInlineError(cause: unknown, retry: (() => void) | null = null) {
        inlineError = cause instanceof Error ? cause.message : String(cause)
        inlineRetry = retry
    }

    function retryInline() {
        const retry = inlineRetry
        inlineError = ''
        inlineRetry = null
        retry?.()
    }

    function cancelWikiLoad() {
        requestSequence += 1
        loadAbortController?.abort()
        loadAbortController = undefined
        loading = false
    }

    async function forceWikiUpdate() {
        if (transferBlocked) return
        const targetTurn = currentChat?.message.filter((message) =>
            message.role === 'char'
            && !message.isComment
            && !message.disabled
            && typeof message.chatId === 'string'
            && message.chatId.trim().length > 0
        ).length ?? 0
        forceUpdating = true
        forceUpdateStatus = ''
        forceUpdateError = ''
        forceUpdateMeta = null
        try {
            const updated = await onForceWikiUpdate?.()
            forceUpdateStatus = updated ? 'success' : 'empty'
            if (updated && targetTurn > 0) {
                forceUpdateMeta = {
                    turn: targetTurn,
                    completedAt: Date.now(),
                }
            }
        }
        catch (cause) {
            forceUpdateStatus = 'failed'
            forceUpdateError = (cause instanceof Error
                ? cause.message
                : String(cause)).trim().slice(0, 512)
        }
        finally {
            forceUpdating = false
        }
    }

    function selectMarkdownPath(path: string) {
        const document = markdownDocuments.find((item) =>
            item.relativePath === path
        )
        if (document) selectedMarkdownId = document.id
    }

    function editStoryEntry(documentId: string) {
        selectedMarkdownId = documentId
        activeView = 'workspace'
    }

    async function executeWikiCommand(
        instruction: string,
        contextSelection: DirectWikiContextSelection
    ): Promise<DirectWikiCommandResult> {
        if (!onExecuteWikiCommand) {
            throw new Error('현재 채팅에서 위키 관리자 명령을 실행할 수 없습니다.')
        }
        const result = await onExecuteWikiCommand(
            instruction,
            contextSelection
        )
        bardChatUpdatedIds = result.applied.map((item) => item.documentId)
        await loadWiki()
        await refreshBardChatUndoStatus()
        return result
    }

    async function refreshBardChatUndoStatus() {
        const scope = `${characterId}\u0000${wikiChatId}`
        try {
            const status = await getBardChatUndoStatus({
                characterId,
                chatId: wikiChatId,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            if (scope === `${characterId}\u0000${wikiChatId}`) {
                bardChatUndoAvailable = status.available
            }
        }
        catch {
            if (scope === `${characterId}\u0000${wikiChatId}`) {
                bardChatUndoAvailable = false
            }
        }
    }

    async function restoreLastBardChatChange() {
        await restoreBardChatUndo({
            characterId,
            chatId: wikiChatId,
            fetchImpl: fetch,
            createAuth: () => forageStorage.createAuth(),
        })
        bardChatUndoAvailable = false
        bardChatUpdatedIds = []
        await loadWiki()
    }

    function setBardChatContextSelection(
        selection: DirectWikiContextSelection
    ) {
        if (!currentChat) return
        const target = currentCharacter?.risuBardPinnedSettings ?? (currentChat.risuBardSettings ??= {})
        Object.assign(target, {
            bardChatIncludeWiki: selection.wiki,
            bardChatIncludeChat: selection.chat,
            bardChatIncludeSystemPrompt: selection.systemPrompt,
            bardChatIncludeCharacterDescription:
                selection.characterDescription,
            bardChatIncludePersona: selection.persona,
            bardChatIncludeCharacterLorebook: selection.characterLorebook,
            bardChatIncludeModuleLorebook: selection.moduleLorebook,
        })
    }


    // Keep chat callbacks/state in their owner, but dock outside theme width limits.
    function dockOutsideTheme(node: HTMLElement) {
        const workspace = node.closest<HTMLElement>('[data-chat-dock-workspace]')
        if (!workspace) return
        workspace.appendChild(node)
        return { destroy: () => node.remove() }
    }

    function setDockRatio(value: number) {
        dockRatio = normalizeMemoryWikiDockRatio(value)
        DBState.db.risuBardMemoryDockRatio = dockRatio
    }

    function resizeDock(event: PointerEvent) {
        event.preventDefault()
        const container = dockElement?.parentElement
        if (!container) return
        const update = (move: PointerEvent) => {
            const bounds = container.getBoundingClientRect()
            if (bounds.width <= 0) return
            setDockRatio((bounds.right - move.clientX) / bounds.width)
        }
        const stop = () => {
            window.removeEventListener('pointermove', update)
            window.removeEventListener('pointerup', stop)
        }
        window.addEventListener('pointermove', update)
        window.addEventListener('pointerup', stop, { once: true })
    }

    function resizeDockByKeyboard(event: KeyboardEvent) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        setDockRatio(dockRatio + (event.key === 'ArrowLeft' ? 0.05 : -0.05))
    }

    function availableWorkspaceHeight(): number {
        const height = workspaceSplitElement?.clientHeight ?? 0
        return height > 0 ? height : 10_000
    }

    function setWorkspaceHeight(
        value: number,
        availableHeight = availableWorkspaceHeight()
    ) {
        workspaceHeight = normalizeMemoryWikiWorkspaceHeight(
            value,
            availableHeight
        )
        DBState.db.risuBardMemoryWorkspaceHeight = workspaceHeight
    }

    function resizeWorkspace(event: PointerEvent) {
        event.preventDefault()
        if (!workspaceSplitElement) return
        const bounds = workspaceSplitElement.getBoundingClientRect()
        if (bounds.height <= 0) return
        const update = (move: PointerEvent) => {
            setWorkspaceHeight(move.clientY - bounds.top, bounds.height)
        }
        const stop = () => {
            window.removeEventListener('pointermove', update)
            window.removeEventListener('pointerup', stop)
        }
        window.addEventListener('pointermove', update)
        window.addEventListener('pointerup', stop, { once: true })
    }

    function resizeWorkspaceByKeyboard(event: KeyboardEvent) {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        setWorkspaceHeight(
            workspaceHeight + (event.key === 'ArrowDown' ? 24 : -24)
        )
    }

    // Only whether a wiki is needed and for which chat decide a reload; moving
    // between wiki views must not refetch the catalog or clear BARDCHAT marks.
    const needsWiki = $derived(open && activeView !== 'painter' && !!characterId && !!wikiChatId)

    $effect(() => {
        if (!needsWiki) {
            untrack(cancelWikiLoad)
            return
        }
        void characterId
        void wikiChatId
        untrack(() => void loadWiki())
        return cancelWikiLoad
    })

    $effect(() => {
        if (!needsWiki || !onExecuteWikiCommand) return
        void characterId
        void wikiChatId
        untrack(() => {
            bardChatUpdatedIds = null
            bardChatUndoAvailable = false
            void refreshBardChatUndoStatus()
        })
    })

    $effect(() => {
        if (activeView !== 'workspace') editorFocus = false
    })

    // While the dock is closed, let the server parse this chat's wiki in the
    // background so the first open does not pay the cold read.
    $effect(() => {
        if (open || !characterId || !wikiChatId) return
        const scope = { characterId, chatId: wikiChatId }
        const timer = setTimeout(() => {
            void warmWikiCatalog({ ...scope, fetchImpl: fetch, createAuth: () => forageStorage.createAuth() })
                .catch(() => undefined)
        }, 1_500)
        return () => clearTimeout(timer)
    })

    $effect(() => {
        if (activeView === 'story' && wiki?.mode === 'markdown'
            && storySummaries === null && !storyLoading) void loadStorySummaries()
    })

    $effect(() => {
        if (activeView !== 'arc-plot') return
        const arc = findStoryArcDocument(markdownDocuments)
        if (arc && arc.content === undefined) void requestBodies([arc.id]).catch(() => undefined)
    })

    $effect(() => {
        const refreshCompletedAnalysis = (event: Event) => {
            const detail = (event as CustomEvent<
                RisuBardMemoryUpdatedDetail
            >).detail
            if (!open || activeView === 'painter' || detail?.characterId !== characterId
                || detail.chatId !== wikiChatId) return
            void loadWiki()
        }
        window.addEventListener(
            RISUBARD_MEMORY_UPDATED_EVENT,
            refreshCompletedAnalysis
        )
        return () => window.removeEventListener(
            RISUBARD_MEMORY_UPDATED_EVENT,
            refreshCompletedAnalysis
        )
    })

</script>

<aside
    use:dockOutsideTheme
    class="memory-wiki-dock"
    class:closed={!open}
    class:editor-focus={editorFocus}
    class:compact-view={compactActive}
    class:settings-open={settingsOpen}
    class:mobile-layout={layoutMode === 'mobile'}
    class:desktop-layout={layoutMode === 'desktop'}
    data-memory-wiki-dock
    data-memory-layout={layoutMode}
    data-open={open}
    data-editor-focus={editorFocus}
    data-memory-compact-view={compactActive}
    bind:this={dockElement}
    style:flex-basis={`${dockRatio * 100}%`}
    aria-label={language.risuBardMemoryWiki}
    aria-hidden={!open}
    inert={!open}
    ondragover={(event) => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = transferBlocked ? 'none' : 'copy' } }}
    ondrop={(event) => { if (!event.dataTransfer?.files.length) return; event.preventDefault(); event.stopPropagation(); if (event.dataTransfer.files.length !== 1) { alertError('위키 파일을 하나씩 들여와 주세요.'); return }; void importFile(event.dataTransfer.files[0]) }}
>
    <button
        type="button"
        class="dock-resizer"
        aria-label="BardWiki 폭 조절"
        onpointerdown={resizeDock}
        onkeydown={resizeDockByKeyboard}
    ></button>
    <header class="dock-header">
        <div class="dock-titlebar">
            <div class="dock-identity">
            <span class="dock-mark"><BookOpenIcon size={17} /></span>
            <div class="dock-title-row">
                <strong>{language.risuBardMemoryWiki}</strong>
                <button
                    type="button"
                    class="dock-help"
                    data-memory-help
                    aria-label="사용 가이드"
                    title="BardWiki 사용 가이드"
                    onclick={() => helpOpen = true}
                >사용 가이드</button>
                <button
                    type="button"
                    class="dock-layout-toggle"
                    data-memory-layout-toggle
                    aria-label={`${layoutMode === 'mobile' ? '데스크톱' : '모바일'} 레이아웃으로 전환`}
                    title={`${layoutMode === 'mobile' ? '데스크톱' : '모바일'} 레이아웃으로 전환`}
                    onclick={toggleLayout}
                >
                    {#if layoutMode === 'mobile'}
                        <MonitorIcon size={15} />
                        <span>데스크톱</span>
                    {:else}
                        <SmartphoneIcon size={15} />
                        <span>모바일</span>
                    {/if}
                </button>
            </div>
            </div>
            {#if !compactActive}{@render dockWindowActions()}{/if}
        </div>
        <div class="dock-views-shell">
        <nav class="dock-views" aria-label="BardWiki 보기" bind:this={dockViewsElement} onscroll={updateDockViewsOverflow}>
            {#if wiki?.mode === 'markdown' && activeView !== 'painter'}
                <button
                    type="button"
                    class="force-update-button"
                    class:running={forceUpdating}
                    data-risubard-force-wiki-update
                    title={language.risuBardMemoryForceUpdate}
                    aria-label={language.risuBardMemoryForceUpdate}
                    aria-busy={forceUpdating}
                    onclick={forceWikiUpdate}
                    disabled={transferBlocked
                        || !onForceWikiUpdate}
                >
                    <img class="force-update-idle" src={forceUpdateIdle} alt="" />
                    <img class="force-update-hover" src={forceUpdateHover} alt="" />
                    <span>{forceUpdating
                        ? language.risuBardMemoryForceUpdating
                        : language.risuBardMemoryForceUpdate}</span>
                </button>
                <ShDropdownMenu>
                    <ShDropdownMenuTrigger>
                        {#snippet child({ props })}
                            <button {...props} type="button" class="wiki-tools-button" data-wiki-tools aria-label="위키 도구">
                                <span>위키 도구</span><ChevronDownIcon size={14} />
                            </button>
                        {/snippet}
                    </ShDropdownMenuTrigger>
                    <ShDropdownMenuContent side="bottom" align="start">
                        <ShDropdownMenuItem data-risubard-wiki-reboot onclick={handleRebootAction}
                            disabled={rebootActionBusy || transferBusy || forceUpdating || loading || (!rebootJob && ($isWikiGenerating || $isAnyGenerating || !!currentChat?.isStreaming)) || rebootJob?.status === 'stop-requested' || rebootJob?.status === 'finalizing' || (!rebootJob && !onStartWikiReboot)}>
                            {rebootButtonLabel}
                        </ShDropdownMenuItem>
                        <ShDropdownMenuItem data-wiki-new-chat disabled={transferBlocked} onclick={startWithWiki}>이 위키로 새 챗 시작</ShDropdownMenuItem>
                        <ShDropdownMenuItem data-wiki-export disabled={transferBlocked} onclick={() => { exportScope = `${characterId}\u0000${chatId}`; exportOpen = true }}>위키 내보내기</ShDropdownMenuItem>
                        <ShDropdownMenuItem data-wiki-import disabled={transferBlocked} onclick={() => { importScope = { characterId, chatId }; importInput?.click() }}>위키 들여오기</ShDropdownMenuItem>
                        {#if rebootJob && (rebootJob.status === 'paused' || rebootJob.status === 'failed')}
                            <ShDropdownMenuItem onclick={cancelReboot} disabled={rebootActionBusy}>{language.risuBardWikiRebootCancel}</ShDropdownMenuItem>
                        {/if}
                    </ShDropdownMenuContent>
                </ShDropdownMenu>
            {/if}
            <div class="dock-view-actions" role="group" aria-label="보기" data-memory-view-group>
                <button type="button" class:active={activeView === 'painter'} data-memory-view="painter"
                    title="바드페인터" aria-label="바드페인터" aria-pressed={activeView === 'painter'}
                    onclick={() => void switchView('painter')}>
                    <SolarPen2Bold size={22} /><span>바드페인터</span>
                </button>
                <button
                    type="button"
                    class:active={activeView === 'ooc'}
                    data-memory-view="ooc"
                    title="OOC 메모장"
                    aria-label="OOC 메모장"
                    aria-pressed={activeView === 'ooc'}
                    onclick={() => void switchView('ooc')}
                ><SolarChatRoundQuestionMarkBold size={22} /><span>OOC 메모장</span></button>
                <button
                    type="button"
                    class:active={activeView === 'workspace'}
                    data-memory-view="workspace"
                    title="작업 공간"
                    aria-pressed={activeView === 'workspace'}
                    onclick={() => void switchView('workspace')}
                ><SolarBoldIcon name="notebook" size={22} /><span>작업 공간</span></button>
                {#if wiki?.mode === 'markdown'}
                    <button
                        type="button"
                        class:active={activeView === 'story'}
                        data-memory-view="story"
                        title="이야기"
                        aria-pressed={activeView === 'story'}
                        onclick={() => void switchView('story')}
                    >
                        <svg data-memory-icon="scroll" viewBox="0 0 24 24" aria-hidden="true">
                            <path d="m22.5 17c-.17-.339-.621-.5-1-.5h-12.5c-.553 0-1 .448-1 1v1.5c0 .015-.012 1.5-1 1.5-.505 0-.931.376-.992.878-.062.501.26.97.75 1.092 2.119.53 5.094.53 8.242.53 4.858 0 6.163-.463 6.447-.605.159-.08 1.553-.85 1.553-3.395 0-1.688-.438-1.876-.5-2z" />
                            <path d="m3 1.88c-.246.093-.425.191-.555.285-.58.343-1.441 1.262-1.445 2.833-.005 2.183.555 2.974.796 3.213.188.186.44.29.704.29h.5z" />
                            <path d="m20.122 2.787c-.09-.283-.301-.511-.575-.623-.116-.047-2.904-1.164-7.547-1.164-3.557 0-6.31.383-7 .488v17.779c.289-.259.628-.463 1-.595v-1.171c0-1.654 1.346-3 3-3h11.925c.046-.856.07-1.692.07-2.5 0-6.398-.838-9.102-.873-9.213z" />
                        </svg>
                        <span>이야기</span>
                    </button>
                    <button
                        type="button"
                        class:active={activeView === 'arc-plot'}
                        data-memory-view="arc-plot"
                        title="아크 플롯"
                        aria-pressed={activeView === 'arc-plot'}
                        onclick={() => void switchView('arc-plot')}
                    ><NetworkIcon size={20} /><span>아크 플롯</span></button>
                {/if}
                <button
                    type="button"
                    class:active={activeView === 'log'}
                    data-memory-view="log"
                    title="요청 기록: 답변마다 들어간 기억과 토큰"
                    aria-pressed={activeView === 'log'}
                    onclick={() => void switchView('log')}
                ><LogsIcon size={20} /><span>요청 기록</span></button>
                {#if wiki?.mode === 'markdown' && activeView !== 'painter'}
                    <button
                        type="button"
                        class="dock-settings"
                        class:active={settingsOpen}
                        data-memory-settings
                        title="설정"
                        aria-haspopup="dialog"
                        aria-expanded={settingsOpen}
                        bind:this={settingsButtonElement}
                        onclick={() => toggleSettings(!settingsOpen)}
                    ><SolarBoldIcon name="settings" size={22} /><span>설정</span></button>
                {/if}
            </div>
            {#if rebootJob && rebootProgress}
                <div
                    class="reboot-progress"
                    class:running={rebootJob.status === 'running'}
                    data-risubard-wiki-reboot-progress
                    role="progressbar"
                    aria-live="polite"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    aria-valuenow={rebootProgress.percent}
                    aria-valuetext={language.risuBardWikiRebootProgress(
                        rebootProgress.completed,
                        rebootProgress.total,
                        rebootProgress.percent
                    )}
                >
                    <div class="reboot-progress-copy">
                        <span>{language.risuBardWikiReboot}</span>
                        <strong>{language.risuBardWikiRebootProgress(
                            rebootProgress.completed,
                            rebootProgress.total,
                            rebootProgress.percent
                        )}</strong>
                    </div>
                    <div class="reboot-progress-track" aria-hidden="true">
                        <span
                            class="reboot-progress-fill"
                            data-risubard-wiki-reboot-progress-fill
                            style:width={`${rebootProgress.percent}%`}
                        ></span>
                    </div>
                </div>
            {/if}
        </nav>
            {#if dockViewsOverflow.start}
                <button type="button" class="dock-views-scroll start" tabindex="-1" aria-label="툴바 왼쪽으로 넘기기"
                    data-dock-views-scroll="start" onclick={() => scrollDockViews(-1)}>
                    <ChevronLeftIcon size={18} />
                </button>
            {/if}
            {#if dockViewsOverflow.end}
                <button type="button" class="dock-views-scroll end" tabindex="-1" aria-label="툴바 오른쪽으로 넘기기"
                    data-dock-views-scroll="end" onclick={() => scrollDockViews(1)}>
                    <ChevronRightIcon size={18} />
                </button>
            {/if}
        </div>
        {#if compactActive}
            <div class="dock-compact-actions">{@render dockWindowActions()}</div>
        {/if}
        {#if wiki?.mode === 'markdown'}
            <div
                class="settings-popover"
                data-memory-settings-popover
                aria-label="BardWiki 현재 챗 설정"
                role="dialog"
                tabindex="-1"
                hidden={!settingsOpen}
                bind:this={settingsPopoverElement}
                onkeydown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); void toggleSettings(false) } }}
            >
                <RisuBardCurrentChatSettings chat={currentChat} character={currentCharacter} global={DBState.db} />
                <ManagerResizeHandles
                    target={settingsPopoverElement}
                    rightAnchored
                    shadowPreview
                    resizeStorageKey="bardwiki-current-chat-settings"
                />
            </div>
        {/if}
    </header>

    {#if transferStatus}
        <div class="force-update-status" role="status">
            <span>{transferStatus}</span>
            <button type="button" class="status-dismiss" data-dismiss-transfer aria-label="알림 닫기" onclick={() => transferStatus = ''}><XIcon size={14} /></button>
        </div>
    {/if}
    {#if inlineError}
        <div class="force-update-status failed" role="alert" data-memory-inline-error>
            <span>{inlineError}</span>
            {#if inlineRetry}<button type="button" class="status-action" onclick={retryInline}>다시 시도</button>{/if}
            <button type="button" class="status-dismiss" data-dismiss aria-label="알림 닫기" onclick={() => { inlineError = ''; inlineRetry = null }}><XIcon size={14} /></button>
        </div>
    {/if}
    {#if wikiBacklog.oldest?.reason}
        <div class="force-update-status failed" role="alert" data-wiki-backlog>
            <span class="wiki-backlog-copy">
                <strong>{language.risuBardWikiBacklogStalled(wikiBacklog.count, wikiBacklog.oldest.responseNumber)}</strong>
                <span data-wiki-backlog-reason>{wikiBacklog.oldest.reason}</span>
            </span>
            <span class="wiki-backlog-actions">
                {#if onNavigateOocMessage}
                    <button type="button" class="status-action" data-wiki-backlog-view
                        onclick={() => onNavigateOocMessage(wikiBacklog.oldest!.index)}>{language.risuBardWikiBacklogView}</button>
                {/if}
                <button type="button" class="status-action" data-wiki-backlog-retry
                    disabled={wikiBacklogBusy || $isWikiGenerating || $isAnyGenerating || !!rebootJob || !onRetryWikiBacklog}
                    onclick={retryWikiBacklog}>{language.risuBardWikiBacklogRetry}</button>
                <button type="button" class="status-action" data-wiki-backlog-skip
                    disabled={wikiBacklogBusy || $isWikiGenerating || !!rebootJob || !onSkipWikiBacklogTurn}
                    onclick={skipWikiBacklogTurn}>{language.risuBardWikiBacklogSkip}</button>
            </span>
        </div>
    {/if}
    <div class="memory-ledger min-h-0">
        {#if forceUpdateStatus}
            <div
                class="force-update-status"
                class:failed={forceUpdateStatus === 'failed'}
                data-force-update-status={forceUpdateStatus}
                aria-live="polite"
            >
                <span>
                    {forceUpdateStatus === 'failed' && forceUpdateError
                        ? forceUpdateError
                        : forceUpdateStatus === 'success'
                        ? language.risuBardMemoryForceUpdateDone
                        : forceUpdateStatus === 'empty'
                            ? language.risuBardMemoryForceUpdateEmpty
                            : language.risuBardMemoryForceUpdateFailed}
                </span>
                {#if forceUpdateStatus === 'success' && forceUpdateMeta}
                    <span class="force-update-meta" data-force-update-meta>
                        {language.risuBardMemoryForceUpdateMeta(
                            forceUpdateMeta.turn,
                            new Intl.DateTimeFormat(undefined, {
                                hour: '2-digit',
                                minute: '2-digit',
                                hour12: false,
                            }).format(forceUpdateMeta.completedAt)
                        )}
                    </span>
                {/if}
                <button type="button" class="status-dismiss" data-dismiss-force-update aria-label="알림 닫기" onclick={() => forceUpdateStatus = ''}><XIcon size={14} /></button>
            </div>
        {/if}

        {#if activeView === 'painter'}
            {#if painterLoadError}<p role="alert">{painterLoadError}</p>{/if}
            {#if open && !painterChatReady}
                <div class="ledger-state" role="status"><LoaderCircleIcon class="animate-spin" size={24} /><span>채팅을 불러오는 중...</span></div>
            {:else if open}
                {#await import('./BardPainter.svelte')}
                    <div class="ledger-state"><LoaderCircleIcon class="animate-spin" size={24} /><span>바드페인터를 여는 중...</span></div>
                {:then painter}
                    {#key `${characterId}:${chatId}`}
                        <painter.default {characterId} {chatId} visible={open} />
                    {/key}
                {:catch cause}
                    <div class="ledger-state" role="alert">바드페인터를 열지 못했습니다. 앱을 새로고침해 주세요. {String(cause)}</div>
                {/await}
            {/if}
        {:else if activeView === 'ooc'}
            {#key `${characterId}:${chatId}`}
                <RisuBardOocNotepad
                    messages={activityMessages}
                    hideOoc={DBState.db.risuBardHideOocTurns === true}
                    onHideChange={(value) => DBState.db.risuBardHideOocTurns = value}
                    onNavigate={onNavigateOocMessage}
                />
            {/key}
        {:else if loading && !wiki}
            <div class="ledger-state">
                <LoaderCircleIcon size={24} class="animate-spin" />
                <span>{language.loading}</span>
            </div>
        {:else if error}
            <div class="ledger-state ledger-error">
                <XCircleIcon size={24} />
                <span>{language.risuBardMemoryLoadFailed}</span>
                <small>{error}</small>
                <ShButton size="sm" variant="outline" data-memory-retry onclick={() => void loadWiki()}>
                    <RefreshCwIcon size={15} /> 다시 시도
                </ShButton>
            </div>
        {:else if wiki?.mode === 'markdown'}
            <div
                class="markdown-wiki"
                class:workspace-split={activeView === 'workspace'
                    && !!onExecuteWikiCommand && !rebootJob}
                class:command-collapsed={!commandExpanded}
                class:editor-focus={editorFocus}
                class:activity-view={activeView === 'log'}
                data-memory-view-mode="markdown"
                data-wiki-workspace-split={activeView === 'workspace' ? '' : undefined}
                bind:this={workspaceSplitElement}
                style:--wiki-workspace-height={`${workspaceHeight}px`}
            >
                {#if activeView === 'workspace'}
                    <div class="wiki-editor-region">
                        <RisuBardWikiEditor
                            {characterId}
                            messages={activityMessages}
                            chatId={wikiChatId}
                            locked={Boolean(rebootJob)}
                            documents={markdownDocuments}
                            health={wiki.health}
                            bind:selectedId={selectedMarkdownId}
                            onChanged={loadWiki}
                            onRequestBody={(documentId) => void requestBodies([documentId]).catch((cause) => showInlineError(cause, () => void requestBodies([documentId]).catch((next) => showInlineError(next))))}
                            onSearch={searchDocumentIds}
                            onFocusModeChange={(focused) => editorFocus = focused}
                            onNavigateSource={onNavigateStorySource}
                            highlightedDocumentIds={bardChatUpdatedIds}
                            mobileLayout={layoutMode === 'mobile'}
                            compact={compactActive}
                            fieldsExpanded={editorFieldsExpanded}
                            onFieldsExpandedChange={setEditorFieldsExpanded}
                            onDirtyChange={(dirty) => editorDirty = dirty}
                        />
                    </div>
                    {#if onExecuteWikiCommand && !rebootJob}
                        <button
                            type="button"
                            class="workspace-resizer"
                            data-wiki-workspace-resizer
                            aria-label="위키 편집 영역 높이 조절"
                            title="드래그하거나 위·아래 방향키로 편집 영역 높이 조절"
                            onpointerdown={resizeWorkspace}
                            onkeydown={resizeWorkspaceByKeyboard}
                        ><span aria-hidden="true"></span></button>
                        <article
                            class="markdown-command-pane"
                            class:collapsed={!commandExpanded}
                            data-wiki-command-pane
                            data-command-expanded={commandExpanded}
                        >
                            <header class="portrait-command-header">
                                <button
                                    type="button"
                                    data-wiki-toggle-command
                                    aria-expanded={commandExpanded}
                                    aria-controls="risubard-wiki-command-terminal"
                                    onclick={() => setCommandExpanded(!commandExpanded)}
                                >
                                    <SquareTerminalIcon size={17} />
                                    <strong>BARDCHAT</strong>
                                    <ChevronDownIcon size={18} class={commandExpanded ? '' : 'collapsed'} />
                                </button>
                            </header>
                            <div id="risubard-wiki-command-terminal" class="command-terminal-region">
                                <RisuBardWikiCommandTerminal
                                    onExecute={executeWikiCommand}
                                    contextSelection={bardChatContextSelection}
                                    onContextSelectionChange={setBardChatContextSelection}
                                    targetDocumentTitleOrId={selectedMarkdownDocument?.title ?? ''}
                                    canRestore={bardChatUndoAvailable}
                                    onRestore={restoreLastBardChatChange}
                                    mobileLayout={layoutMode === 'mobile'}
                                />
                            </div>
                        </article>
                    {/if}
                {:else if activeView === 'story'}
                    <RisuBardStorySoFar
                        documents={markdownDocuments}
                        summaries={storySummaries ?? undefined}
                        loading={storyLoading || storySummaries === null}
                        messages={activityMessages}
                        onNavigate={onNavigateStorySource}
                        onEdit={editStoryEntry}
                    />
                {:else if activeView === 'arc-plot'}
                    <RisuBardStoryArcPlot
                        documents={markdownDocuments}
                        messages={activityMessages}
                        checkpointSize={arcPlotterSettings.checkpointSize}
                        enabled={arcPlotterSettings.enabled}
                        onOpenDocument={editStoryEntry}
                    />
                {:else}
                    <div class="activity-log-scroll" data-memory-activity-scroll>
                        <RisuBardMemoryActivity
                            {characterId}
                            {chatId}
                            messages={activityMessages}
                            onSelectPath={(path) => {
                                selectMarkdownPath(path)
                                activeView = 'workspace'
                            }}
                        />
                    </div>
                {/if}
            </div>
        {/if}
    </div>
</aside>
<input bind:this={importInput} type="file" accept=".bardwiki.json,application/json" hidden onchange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void importFile(file, importScope) }} />
{#if exportOpen}
    <RisuBardWikiExportDialog bind:open={exportOpen} documents={markdownDocuments} onExport={exportWiki} disabled={transferBlocked} />
{/if}

{#if rebootChooserOpen}
    <ShDialog
        open={true}
        onOpenChange={(value) => { if (!value) rebootChooserOpen = false }}
        size="default"
        tier="top"
        footer={rebootChooserFooter}
    >
        {#snippet title()}{language.risuBardWikiRebootChooseTitle}{/snippet}
        <p class="reboot-choice-intro">
            {language.risuBardWikiRebootChooseDescription}
        </p>
        <div
            class="reboot-start-index"
            data-risubard-wiki-reboot-start-index
        >
            <label for="risubard-wiki-reboot-start-index">
                {language.risuBardWikiRebootStartChatIndex}
            </label>
            <input
                id="risubard-wiki-reboot-start-index"
                type="number"
                min="0"
                max={rebootLastChatIndex}
                step="1"
                bind:value={rebootStartChatIndex}
                aria-invalid={!rebootStartChatIndexValid}
                aria-describedby="risubard-wiki-reboot-start-index-hint"
            />
            <small id="risubard-wiki-reboot-start-index-hint">
                {language.risuBardWikiRebootStartChatIndexHint(
                    rebootLastChatIndex
                )}
            </small>
        </div>
        <p
            class="reboot-token-budget"
            data-risubard-wiki-reboot-token-budget
        >
            {language.risuBardWikiRebootTokenBudget(rebootAnalysisTokenLimit)}
        </p>
        <div class="reboot-choices" data-risubard-wiki-reboot-choices>
            <button
                type="button"
                class="reboot-choice"
                title={language.risuBardWikiRebootOneTurnTooltip}
                onclick={() => startReboot(1)}
                disabled={!rebootStartChatIndexValid}
            >
                <strong>{language.risuBardWikiRebootOneTurn}</strong>
                <span>{language.risuBardWikiRebootOneTurnSummary}</span>
            </button>
            <button
                type="button"
                class="reboot-choice"
                title={language.risuBardWikiRebootTwoTurnTooltip}
                onclick={() => startReboot(2)}
                disabled={!rebootStartChatIndexValid}
            >
                <strong>{language.risuBardWikiRebootTwoTurn}</strong>
                <span>{language.risuBardWikiRebootTwoTurnSummary}</span>
            </button>
        </div>
    </ShDialog>
{/if}

{#snippet rebootChooserFooter()}
    <div class="reboot-choice-footer">
        <ShButton variant="outline" onclick={() => rebootChooserOpen = false}>
            {language.cancel}
        </ShButton>
    </div>
{/snippet}

{#snippet dockWindowActions()}
    {#if layoutMode === 'desktop'}
        <button
            type="button"
            class="dock-close dock-compact-toggle"
            data-memory-compact-toggle
            aria-pressed={compactActive}
            aria-label={compactActive ? '집중 보기 끄기' : '집중 보기'}
            title={compactActive ? '집중 보기 끄기: 헤더, 편집 바, BardChat 펼치기' : '집중 보기: 헤더, 편집 바, BardChat을 한 줄로 접기'}
            onclick={toggleCompactView}
        >
            {#if compactActive}<Minimize2Icon size={17} />{:else}<Maximize2Icon size={17} />{/if}
        </button>
    {/if}
    <button class="dock-close" type="button" aria-label="BardWiki 닫기" onclick={() => open = false}>
        <PanelRightCloseIcon size={18} />
    </button>
{/snippet}

<RisuBardMemoryWikiHelp bind:open={helpOpen} />

<style>
    .dock-views .wiki-tools-button { width: auto; min-width: max-content; gap: .35rem; padding-inline: .65rem; }
    .dock-views .wiki-tools-button span { position: static; width: auto; height: auto; overflow: visible; clip-path: none; }
    .memory-wiki-dock {
        position: relative;
        z-index: 30;
        display: flex;
        flex: 0 0 auto;
        flex-direction: column;
        min-width: min(28rem, 100%);
        max-width: 75%;
        height: 100%;
        min-height: 0;
        overflow: hidden;
        border-left: 1px solid color-mix(in srgb, var(--risu-theme-primary) 28%, var(--risu-theme-darkborderc));
        background: var(--risu-theme-darkbg);
        box-shadow: -.8rem 0 2.4rem color-mix(in srgb, var(--color-shadow) 18%, transparent);
        animation: dock-enter .18s ease-out;
        container-type: inline-size;
    }
    .memory-wiki-dock.closed { display: none; }
    .memory-wiki-dock.settings-open { overflow: visible; }
    .memory-wiki-dock.editor-focus > .dock-header, .memory-wiki-dock.editor-focus .force-update-status { display: none; }
    .dock-resizer {
        position: absolute;
        z-index: 5;
        inset: 0 auto 0 -.3rem;
        width: .6rem;
        padding: 0;
        border: 0;
        background: transparent;
        cursor: col-resize;
        touch-action: none;
    }
    .dock-resizer::after {
        content: '';
        position: absolute;
        inset: 0 auto 0 .27rem;
        width: 1px;
        background: transparent;
        transition: width .15s ease, background .15s ease;
    }
    .dock-resizer:hover::after,
    .dock-resizer:focus-visible::after {
        width: 3px;
        outline: 0;
        background: var(--risu-theme-primary);
    }
    .dock-header {
        position: relative;
        z-index: 10;
        display: flex;
        flex-direction: column;
        gap: .3rem;
        padding: .4rem .5rem .45rem .65rem;
        border-bottom: 1px solid var(--risu-theme-darkborderc);
        background: color-mix(in srgb, var(--risu-theme-darkbg) 91%, var(--color-bgcolor));
    }
    .dock-titlebar { display: flex; width: 100%; min-width: 0; align-items: center; gap: .65rem; }
    .dock-identity {
        display: flex;
        flex: 1 1 8rem;
        min-width: 0;
        align-items: center;
        gap: .55rem;
    }
    .dock-title-row { display: flex; flex-wrap: wrap; min-width: 0; align-items: center; gap: .35rem .5rem; }
    .dock-identity strong { font-family: var(--risu-font-family); font-size: .84rem; font-weight: 700; line-height: 1.1; letter-spacing: -.02em; white-space: nowrap; }
    .dock-help,
    .dock-layout-toggle {
        display: inline-flex;
        flex: 0 0 auto;
        min-height: 1.75rem;
        align-items: center;
        justify-content: center;
        gap: .3rem;
        padding: .2rem .55rem;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: .35rem;
        color: var(--risu-theme-textcolor);
        background: color-mix(in srgb, var(--risu-theme-primary) 8%, var(--risu-theme-darkbg));
        font-size: .75rem;
        font-weight: 600;
        line-height: 1.2;
        white-space: nowrap;
        cursor: pointer;
    }
    .dock-help:hover,
    .dock-help:focus-visible,
    .dock-layout-toggle:hover,
    .dock-layout-toggle:focus-visible {
        border-color: color-mix(in srgb, var(--risu-theme-primary) 35%, var(--risu-theme-darkborderc));
        outline: 0;
        color: var(--risu-theme-textcolor);
        background: color-mix(in srgb, var(--risu-theme-primary) 12%, transparent);
    }
    .dock-mark {
        display: grid;
        flex: 0 0 auto;
        width: 1.8rem;
        height: 1.8rem;
        place-items: center;
        border: 1px solid color-mix(in srgb, var(--risu-theme-primary) 38%, var(--risu-theme-darkborderc));
        border-radius: .4rem;
        color: var(--risu-theme-primary);
        background: color-mix(in srgb, var(--risu-theme-primary) 9%, transparent);
    }
    .dock-views-shell { position: relative; width: 100%; min-width: 0; }
    .dock-views-scroll {
        position: absolute;
        top: 0;
        bottom: 0;
        z-index: 1;
        display: flex;
        width: 2.6rem;
        align-items: center;
        padding: 0 .3rem;
        border: 0;
        color: var(--risu-theme-textcolor2);
        cursor: pointer;
    }
    .dock-views-scroll.start {
        left: 0;
        justify-content: flex-start;
        border-radius: .48rem 0 0 .48rem;
        background:
            linear-gradient(270deg, transparent, color-mix(in srgb, var(--risu-theme-darkbg) 78%, var(--risu-theme-textcolor2) 8%) 55%),
            linear-gradient(270deg, transparent, color-mix(in srgb, var(--risu-theme-darkbg) 91%, var(--color-bgcolor)) 55%);
    }
    .dock-views-scroll.end {
        right: 0;
        justify-content: flex-end;
        border-radius: 0 .48rem .48rem 0;
        background:
            linear-gradient(90deg, transparent, color-mix(in srgb, var(--risu-theme-darkbg) 78%, var(--risu-theme-textcolor2) 8%) 55%),
            linear-gradient(90deg, transparent, color-mix(in srgb, var(--risu-theme-darkbg) 91%, var(--color-bgcolor)) 55%);
    }
    .dock-views-scroll:hover { color: var(--risu-theme-textcolor); }
    .dock-views { position: relative; display: flex; flex-wrap: wrap; width: 100%; min-height: 44px; align-items: center; gap: .3rem; padding: .3rem .35rem; border-radius: .48rem; background: color-mix(in srgb, var(--risu-theme-darkbg) 78%, var(--risu-theme-textcolor2) 8%); }
    .dock-view-actions { display: flex; align-items: center; justify-content: flex-end; gap: .25rem; margin-left: auto; }
    .reboot-progress {
        flex: 1 0 100%;
        display: grid;
        gap: .28rem;
        padding: .38rem .18rem .08rem;
        border-top: 1px solid color-mix(in srgb, var(--risu-theme-primary) 18%, var(--risu-theme-darkborderc));
    }
    .reboot-progress-copy {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: .75rem;
        color: var(--risu-theme-textcolor2);
        font-size: .68rem;
        line-height: 1;
    }
    .reboot-progress-copy strong {
        color: var(--risu-theme-textcolor);
        font-size: .7rem;
        font-variant-numeric: tabular-nums;
        letter-spacing: .015em;
    }
    .reboot-progress-track {
        height: .34rem;
        overflow: hidden;
        border: 1px solid color-mix(in srgb, var(--risu-theme-primary) 20%, transparent);
        border-radius: 999px;
        background: color-mix(in srgb, var(--risu-theme-darkbg) 82%, var(--risu-theme-textcolor2) 8%);
    }
    .reboot-progress-fill {
        position: relative;
        display: block;
        height: 100%;
        overflow: hidden;
        border-radius: inherit;
        background: var(--risu-theme-primary);
        transition: width 280ms ease-out;
    }
    .reboot-progress.running .reboot-progress-fill::after {
        position: absolute;
        inset: 0;
        content: '';
        background: linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--color-accenttext) 38%, transparent) 50%, transparent 100%);
        transform: translateX(-100%);
        animation: reboot-progress-sheen 1.4s ease-in-out infinite;
    }
    @keyframes reboot-progress-sheen {
        to { transform: translateX(100%); }
    }
    @media (prefers-reduced-motion: reduce) {
        .reboot-progress-fill { transition: none; }
        .reboot-progress.running .reboot-progress-fill::after {
            animation: none;
        }
    }
    .dock-views button, .dock-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: .32rem;
        min-height: 1.85rem;
        padding: .28rem .48rem;
        border: 1px solid transparent;
        border-radius: .34rem;
        color: var(--risu-theme-textcolor2);
        background: transparent;
        font-size: .68rem;
        white-space: nowrap;
        cursor: pointer;
        list-style: none;
    }
    .dock-views button { width: 2.35rem; min-height: 2.25rem; padding: .35rem; }
    .dock-views .force-update-button,
    .dock-views .find-replace-button,
    .dock-views .reboot-button,
    .dock-views .reboot-cancel-button {
        flex: 0 0 auto;
        width: auto;
        min-width: 5.7rem;
        height: 2.25rem;
        padding-inline: .72rem;
        font-size: .75rem;
        border-color: color-mix(in srgb, var(--risu-theme-primary) 32%, var(--risu-theme-darkborderc));
    }
    .dock-views .force-update-button { justify-content: flex-start; gap: .4rem; color: var(--risu-theme-textcolor); background: color-mix(in srgb, var(--risu-theme-primary) 13%, var(--risu-theme-darkbg)); }
    .dock-views .reboot-cancel-button {
        min-width: auto;
        color: var(--risu-theme-draculared);
    }
    .force-update-button img { display: block; flex: 0 0 auto; width: 24px; height: 24px; object-fit: contain; image-rendering: auto; }
    .force-update-hover { display: none !important; }
    .force-update-button:hover:not(:disabled) .force-update-idle,
    .force-update-button.running .force-update-idle { display: none; }
    .force-update-button:hover:not(:disabled) .force-update-hover,
    .force-update-button.running .force-update-hover { display: block !important; }
    .dock-view-actions svg { display: block; width: 22px; height: 22px; fill: currentColor; }
    .status-dismiss, .status-action { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; min-height: 1.6rem; padding: 0 .4rem; border-radius: .3rem; color: inherit; }
    .status-dismiss:hover, .status-action:hover { background: color-mix(in srgb, currentColor 12%, transparent); }
    .status-action { text-decoration: underline; }
    .status-action:disabled { opacity: .5; cursor: not-allowed; text-decoration: none; }
    .wiki-backlog-copy { display: flex; flex-direction: column; gap: .15rem; min-width: 0; flex: 1 1 16rem; }
    .wiki-backlog-copy > span { color: color-mix(in srgb, currentColor 80%, transparent); overflow-wrap: anywhere; }
    .wiki-backlog-actions { display: flex; flex-wrap: wrap; gap: .25rem; }
    .dock-views button span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .dock-views .force-update-button span,
    .dock-views .find-replace-button span,
    .dock-views .reboot-button span,
    .dock-views .reboot-cancel-button span {
        position: static;
        width: auto;
        height: auto;
        overflow: visible;
        clip-path: none;
    }
    .dock-views button:hover, .dock-views button.active,
    .dock-close:hover {
        color: var(--risu-theme-textcolor);
        border-color: color-mix(in srgb, var(--risu-theme-primary) 24%, var(--risu-theme-darkborderc));
        background: color-mix(in srgb, var(--risu-theme-primary) 12%, transparent);
    }
    .dock-views button.active { color: var(--color-accenttext); border-color: color-mix(in srgb, var(--risu-theme-primary) 72%, transparent); background: var(--risu-theme-primary); }
    .dock-views button:disabled { opacity: .48; cursor: default; }
    .settings-popover {
        position: absolute;
        z-index: 50;
        top: calc(100% + .22rem);
        right: .5rem;
        display: grid;
        width: var(--manager-width, 58rem);
        height: var(--manager-height, auto);
        max-width: calc(100vw - 1rem);
        max-height: calc(100dvh - 7rem);
        overflow-y: auto;
        padding: .55rem;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: .42rem;
        background: var(--risu-theme-bgcolor);
        box-shadow: 0 .6rem 1.5rem color-mix(in srgb, var(--color-shadow) 28%, transparent);
    }
    .settings-popover[hidden] { display: none; }
    .find-replace-overlay {
        position: absolute;
        z-index: 60;
        inset: 0;
        display: grid;
        place-items: start center;
        padding: clamp(4rem, 12vh, 7rem) 1rem 1rem;
        background: color-mix(in srgb, var(--color-overlay) 58%, transparent);
        backdrop-filter: blur(4px);
    }
    .find-replace-dialog {
        width: min(27rem, 100%);
        max-height: calc(100% - 1rem);
        overflow: hidden;
        border: 1px solid var(--color-darkborderc);
        border-radius: 1rem;
        background: var(--color-darkbg);
        box-shadow: 0 1.5rem 4rem color-mix(in srgb, var(--color-shadow) 32%, transparent);
        background: var(--risu-theme-bgcolor);
        box-shadow: 0 1rem 2.8rem color-mix(in srgb, var(--color-shadow) 38%, transparent);
    }
    .dock-close { flex: 0 0 auto; padding-inline: .38rem; }
    .dock-compact-toggle[aria-pressed='true'] { color: var(--risu-theme-textcolor); }
    .memory-wiki-dock.compact-view .dock-header {
        flex-direction: row;
        align-items: center;
        gap: .35rem;
        padding: .3rem .5rem .3rem .55rem;
    }
    .memory-wiki-dock.compact-view .dock-titlebar { display: none; }
    .memory-wiki-dock.compact-view .dock-views-shell { flex: 1 1 auto; }
    .memory-wiki-dock.compact-view .dock-views { min-height: 2.5rem; padding-block: .15rem; }
    .dock-compact-actions { display: flex; flex: 0 0 auto; align-items: center; gap: .15rem; }
    .reboot-choice-intro {
        margin: 0 0 .65rem;
        color: var(--risu-theme-textcolor2);
        font-size: .82rem;
        line-height: 1.55;
        text-align: center;
    }
    .reboot-start-index {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 7rem;
        align-items: center;
        gap: .4rem .85rem;
        margin: 0 0 .8rem;
        padding: .8rem .9rem;
        border: 1px solid color-mix(in srgb, var(--risu-theme-primary) 52%, var(--risu-theme-darkborderc));
        border-radius: .6rem;
        background: color-mix(in srgb, var(--risu-theme-primary) 11%, var(--risu-theme-darkbg));
    }
    .reboot-start-index label {
        color: var(--risu-theme-textcolor);
        font-size: 1rem;
        font-weight: 750;
        line-height: 1.35;
    }
    .reboot-start-index input {
        width: 100%;
        min-width: 0;
        padding: .5rem .65rem;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: .42rem;
        color: var(--risu-theme-textcolor);
        background: var(--risu-theme-bgcolor);
        font-size: 1.1rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        text-align: center;
    }
    .reboot-start-index input:focus-visible {
        border-color: var(--risu-theme-primary);
        outline: 2px solid color-mix(in srgb, var(--risu-theme-primary) 42%, transparent);
        outline-offset: 2px;
    }
    .reboot-start-index input[aria-invalid="true"] {
        border-color: var(--risu-theme-draculared);
    }
    .reboot-start-index small {
        grid-column: 1 / -1;
        color: var(--risu-theme-textcolor2);
        font-size: .72rem;
        line-height: 1.4;
    }
    .reboot-token-budget {
        margin: 0 0 1rem;
        padding: .65rem .75rem;
        border: 1px solid color-mix(in srgb, var(--risu-theme-primary) 24%, var(--risu-theme-darkborderc));
        border-radius: .5rem;
        color: var(--risu-theme-textcolor2);
        background: color-mix(in srgb, var(--risu-theme-primary) 6%, transparent);
        font-size: .74rem;
        line-height: 1.5;
        text-align: center;
    }
    .reboot-choices {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: .85rem;
    }
    .reboot-choice {
        aspect-ratio: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: .7rem;
        min-width: 0;
        padding: 1rem;
        border: 1px solid color-mix(in srgb, var(--risu-theme-primary) 35%, var(--risu-theme-darkborderc));
        border-radius: .7rem;
        color: var(--risu-theme-textcolor);
        background: color-mix(in srgb, var(--risu-theme-primary) 8%, var(--risu-theme-darkbg));
        cursor: pointer;
    }
    .reboot-choice:hover {
        border-color: var(--risu-theme-primary);
        background: color-mix(in srgb, var(--risu-theme-primary) 17%, var(--risu-theme-darkbg));
    }
    .reboot-choice:disabled {
        opacity: .45;
        cursor: not-allowed;
    }
    .reboot-choice strong { font-size: 1rem; }
    .reboot-choice span {
        color: var(--risu-theme-textcolor2);
        font-size: .72rem;
        line-height: 1.45;
        text-align: center;
    }
    .reboot-choice-footer { display: flex; width: 100%; justify-content: center; }
    .memory-ledger {
        display: flex;
        flex: 1;
        flex-direction: column;
        height: auto;
        min-height: 0;
        background:
            linear-gradient(90deg, color-mix(in srgb, var(--risu-theme-primary) 7%, transparent) 1px, transparent 1px),
            linear-gradient(color-mix(in srgb, var(--risu-theme-primary) 5%, transparent) 1px, transparent 1px);
        background-size: 28px 28px;
    }
    .force-update-status {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: .25rem 1rem;
        padding: .42rem 1rem;
        border-bottom: 1px solid color-mix(in srgb, var(--risu-theme-success) 28%, var(--risu-theme-darkborderc));
        color: color-mix(in srgb, var(--risu-theme-success) 78%, var(--risu-theme-textcolor));
        background: color-mix(in srgb, var(--risu-theme-success) 8%, var(--risu-theme-darkbg));
        font-size: .7rem;
    }
    .force-update-meta {
        margin-left: auto;
        white-space: nowrap;
        color: color-mix(in srgb, currentColor 78%, transparent);
    }
    .force-update-status.failed {
        border-bottom-color: color-mix(in srgb, var(--risu-theme-draculared) 35%, var(--risu-theme-darkborderc));
        color: var(--risu-theme-draculared);
        background: color-mix(in srgb, var(--risu-theme-draculared) 7%, var(--risu-theme-darkbg));
    }
    .markdown-wiki {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
    }
    .markdown-wiki.activity-view { overflow: hidden; }
    .activity-log-scroll {
        height: 100%;
        min-height: 0;
        overflow-y: scroll;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
    }
    .activity-log-scroll :global(.activity-console) { height: auto; min-height: 100%; overflow: visible; }
    .activity-log-scroll :global(.activity-stream) { overflow: visible; }
    .markdown-wiki.workspace-split {
        display: grid;
        grid-template-rows:
            minmax(0, min(
                var(--wiki-workspace-height),
                calc(100% - 13.75rem)
            ))
            .75rem
            minmax(13rem, 1fr);
        overflow: hidden;
    }
    .workspace-split > .wiki-editor-region { grid-row: 1; }
    .workspace-split > .workspace-resizer { grid-row: 2; }
    .workspace-split > .markdown-command-pane { grid-row: 3; }
    .markdown-wiki.workspace-split.editor-focus {
        grid-template-rows: minmax(0, 1fr);
    }
    .workspace-split.editor-focus > .workspace-resizer,
    .workspace-split.editor-focus > .markdown-command-pane { display: none; }
    .wiki-editor-region {
        min-height: 0;
        overflow: hidden;
    }
    .workspace-split .wiki-editor-region :global(.wiki-editor) {
        height: 100%;
        min-height: 0;
        border-bottom: 0;
    }
    .workspace-split .wiki-editor-region :global(.editor-pane) {
        min-height: 0;
    }
    .workspace-split .wiki-editor-region :global(.markdown-editor),
    .workspace-split .wiki-editor-region :global(.markdown-preview) {
        min-height: 0;
    }
    .workspace-resizer {
        position: relative;
        z-index: 4;
        width: 100%;
        min-height: .75rem;
        padding: 0;
        border: 0;
        border-block: 1px solid var(--risu-theme-darkborderc);
        outline: 0;
        background: color-mix(in srgb, var(--risu-theme-darkbg) 90%, transparent);
        cursor: row-resize;
        touch-action: none;
    }
    .workspace-resizer::before {
        position: absolute;
        z-index: 2;
        inset: -1.9rem 0 0;
        content: '';
    }
    .workspace-resizer span,
    .workspace-resizer::after {
        position: absolute;
        left: 50%;
        width: 2.6rem;
        content: '';
        transform: translateX(-50%);
    }
    .workspace-resizer span {
        top: 50%;
        height: .18rem;
        border-radius: 999px;
        background: color-mix(in srgb, var(--risu-theme-textcolor2) 48%, transparent);
        transform: translate(-50%, -50%);
    }
    .workspace-resizer::after {
        inset-block: -.28rem;
        width: 5rem;
        border-radius: .35rem;
        background: transparent;
        transition: background .14s ease;
    }
    .workspace-resizer:hover,
    .workspace-resizer:focus-visible {
        border-color: color-mix(in srgb, var(--risu-theme-primary) 55%, var(--risu-theme-darkborderc));
        background: color-mix(in srgb, var(--risu-theme-primary) 10%, var(--risu-theme-darkbg));
    }
    .workspace-resizer:hover::after,
    .workspace-resizer:focus-visible::after {
        background: color-mix(in srgb, var(--risu-theme-primary) 9%, transparent);
    }
    .markdown-command-pane {
        position: relative;
        z-index: 6;
        min-height: 0;
        overflow: hidden;
        padding: .65rem .75rem .75rem;
    }
    .portrait-command-header { display: none; }
    .command-terminal-region { height: 100%; min-height: 0; }

    .memory-wiki-dock.mobile-layout .markdown-wiki.workspace-split {
        grid-template-rows: minmax(0, 1fr) 0 minmax(12rem, 42%);
    }
    .memory-wiki-dock.mobile-layout .markdown-wiki.workspace-split.command-collapsed {
        grid-template-rows: minmax(0, 1fr) 0 3rem;
    }
    .memory-wiki-dock.mobile-layout .workspace-resizer { display: none; }
    .memory-wiki-dock.mobile-layout .markdown-command-pane {
        display: grid;
        grid-template-rows: 3rem minmax(0, 1fr);
        padding: 0;
        border-top: 1px solid var(--risu-theme-darkborderc);
        background: color-mix(in srgb, var(--risu-theme-darkbg) 94%, var(--color-bgcolor));
        box-shadow: 0 -.6rem 1.8rem color-mix(in srgb, var(--color-shadow) 16%, transparent);
    }
    .memory-wiki-dock.compact-view .portrait-command-header,
    .memory-wiki-dock.mobile-layout .portrait-command-header {
        display: block;
        min-width: 0;
        border-bottom: 1px solid var(--risu-theme-darkborderc);
    }
    .memory-wiki-dock.compact-view .portrait-command-header > button,
    .memory-wiki-dock.mobile-layout .portrait-command-header > button {
        display: flex;
        width: 100%;
        min-height: 3rem;
        align-items: center;
        gap: .6rem;
        padding: .35rem .75rem;
        border: 0;
        color: var(--risu-theme-textcolor);
        background: transparent;
        text-align: left;
        touch-action: manipulation;
    }
    .memory-wiki-dock.mobile-layout .portrait-command-header > button:active {
        background: color-mix(in srgb, var(--risu-theme-primary) 13%, transparent);
    }
    .memory-wiki-dock.compact-view .portrait-command-header > button:focus-visible,
    .memory-wiki-dock.mobile-layout .portrait-command-header > button:focus-visible {
        outline: 2px solid var(--risu-theme-primary);
        outline-offset: -2px;
    }
    .memory-wiki-dock.compact-view .portrait-command-header strong,
    .memory-wiki-dock.mobile-layout .portrait-command-header strong {
        flex: 1;
        min-width: 0;
        font-size: .78rem;
    }
    .memory-wiki-dock.compact-view .portrait-command-header :global(svg:last-child),
    .memory-wiki-dock.mobile-layout .portrait-command-header :global(svg:last-child) {
        flex: 0 0 auto;
        transition: transform .18s ease-out;
    }
    .memory-wiki-dock.compact-view .portrait-command-header :global(svg:last-child.collapsed),
    .memory-wiki-dock.mobile-layout .portrait-command-header :global(svg:last-child.collapsed) {
        transform: rotate(-90deg);
    }
    .memory-wiki-dock.mobile-layout .command-terminal-region { padding: .45rem .55rem .55rem; }
    .memory-wiki-dock.compact-view .markdown-wiki.workspace-split.command-collapsed {
        grid-template-rows: minmax(0, 1fr) 0 2.5rem;
    }
    .memory-wiki-dock.compact-view .command-collapsed > .workspace-resizer { display: none; }
    .memory-wiki-dock.compact-view .markdown-command-pane {
        display: grid;
        grid-template-rows: 2.5rem minmax(0, 1fr);
        padding: 0;
        border-top: 1px solid var(--risu-theme-darkborderc);
    }
    .memory-wiki-dock.compact-view .markdown-command-pane.collapsed .portrait-command-header { border-bottom: 0; }
    .memory-wiki-dock.compact-view .portrait-command-header > button { min-height: 2.5rem; padding-block: .25rem; cursor: pointer; }
    .memory-wiki-dock.compact-view .portrait-command-header > button:hover {
        background: color-mix(in srgb, var(--risu-theme-primary) 9%, transparent);
    }
    .memory-wiki-dock.compact-view .command-terminal-region { padding: .4rem .75rem .65rem; }
    .memory-wiki-dock.compact-view .markdown-command-pane.collapsed .command-terminal-region { display: none; }
    .memory-wiki-dock.compact-view .markdown-command-pane :global(.terminal-title) { display: none; }
    .memory-wiki-dock.mobile-layout .markdown-command-pane.collapsed .command-terminal-region { display: none; }
    .memory-wiki-dock.mobile-layout .markdown-wiki.workspace-split.editor-focus {
        grid-template-rows: minmax(0, 1fr);
    }

    @keyframes dock-enter {
        from { opacity: .5; transform: translateX(1rem); }
        to { opacity: 1; transform: translateX(0); }
    }

    .memory-wiki-dock.mobile-layout .dock-views {
        flex-wrap: nowrap;
        overflow-x: auto;
        overscroll-behavior-inline: contain;
        scrollbar-width: thin;
    }
    .memory-wiki-dock.mobile-layout .dock-views button {
        width: 2.75rem;
        min-height: 2.75rem;
        padding-inline: .45rem;
    }
    .memory-wiki-dock.mobile-layout .dock-views .force-update-button,
    .memory-wiki-dock.mobile-layout .dock-views .find-replace-button {
        width: 2.75rem;
        min-width: 2.75rem;
        height: 2.75rem;
        justify-content: center;
        padding-inline: 0;
    }
    .memory-wiki-dock.mobile-layout .dock-views .force-update-button span,
    .memory-wiki-dock.mobile-layout .dock-views .find-replace-button span {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
    }
    .memory-wiki-dock.mobile-layout .dock-views .reboot-button,
    .memory-wiki-dock.mobile-layout .dock-views .reboot-cancel-button {
        min-width: auto;
        height: 2.75rem;
        padding-inline: .6rem;
    }
    .memory-wiki-dock.mobile-layout .dock-view-actions {
        flex: 0 0 auto;
        margin-left: auto;
    }
    .memory-wiki-dock.mobile-layout {
        position: absolute;
        inset: 0;
        width: 100% !important;
        max-width: none;
        min-width: 0;
    }
    .memory-wiki-dock.mobile-layout .dock-resizer { display: none; }
    .memory-wiki-dock.mobile-layout .dock-identity { min-width: 0; }

    .ledger-state {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: .75rem;
        padding: 2rem;
        color: var(--risu-theme-textcolor2);
        text-align: center;
    }
    .ledger-error {
        color: var(--risu-theme-draculared);
    }
    .ledger-error small {
        max-width: 36rem;
        color: var(--risu-theme-textcolor2);
    }
    @media (max-width: 640px) {
    }

    @media (prefers-reduced-motion: reduce) {
        .memory-wiki-dock { animation: none; }
        .portrait-command-header :global(svg:last-child) { transition: none; }
    }
    /* A wide dock names each view under its icon; a narrow one keeps icons and tooltips. */
    @container (min-width: 36rem) {
        .dock-view-actions button {
            width: auto;
            min-width: 3.4rem;
            flex-direction: column;
            gap: .12rem;
            padding: .25rem .3rem;
        }
        .dock-view-actions button span {
            position: static;
            width: auto;
            height: auto;
            overflow: visible;
            clip-path: none;
            font-size: .75rem;
            line-height: 1.1;
        }
    }
</style>
