<script lang="ts">
    import {
        CheckIcon,
        CopyIcon,
        FileTextIcon,
        LoaderCircleIcon,
        PanelLeftCloseIcon,
        PanelLeftOpenIcon,
        SparklesIcon,
    } from '@lucide/svelte'
    import { mount, tick, unmount } from 'svelte'
    import { language } from 'src/lang'
    import { exportArcaHtml, resolveArcaImageSource } from 'src/ts/arcaExport'
    import { renderArcaComplexBlock } from 'src/ts/arcaSnapshot'
    import {
        normalizeArcaChatFontSizePx,
        normalizeArcaChatDialogSize,
        normalizeArcaChatIncludeUserMessages,
        normalizeArcaChatImageWidthPercent,
        normalizeArcaChatParagraphSpacingPercent,
    } from 'src/ts/arcaChatSaverSettings'
    import {
        buildArcaLogClipboardHtml,
        buildArcaLogPlainText,
        getArcaLogTurnCount,
        hasVisibleArcaLogContent,
        selectArcaLogMessages,
        summarizeArcaLogMessages,
        type ArcaLogRenderedMessage,
    } from 'src/ts/arcaChatLog'
    import { getChatPageCount, normalizeChatPageSize } from 'src/ts/chatPagination'
    import { getCharImage } from 'src/ts/characters'
    import { getFileSrc } from 'src/ts/globalApi.svelte'
    import { ColorSchemeTypeStore } from 'src/ts/gui/colorscheme'
    import { getModelInfo } from 'src/ts/model/modellist'
    import type { Chat as ChatData, Message, character as Character } from 'src/ts/storage/database.svelte'
    import { createSimpleCharacter, DBState } from 'src/ts/stores.svelte'
    import { capitalize } from 'src/ts/util'
    import { notifyError, notifySuccess } from 'src/ts/alert'
    import ShButton from '../UI/GUI/ShButton.svelte'
    import ShDialog from '../UI/GUI/ShDialog.svelte'
    import ManagerResizeHandles from '../UI/GUI/ManagerResizeHandles.svelte'
    import Chat from './Chat.svelte'

    interface Props {
        open: boolean
        character: Character
        chat: ChatData
        currentUsername: string
        userIcon: string
        onOpenChange(open: boolean): void
    }

    interface LogSource extends Message {
        sourceIndex: number
        firstMessage?: boolean
    }

    let { open, character, chat, currentUsername, userIcon, onOpenChange }: Props = $props()
    let mode = $state<'all' | 'page' | 'turn'>('all')
    let rangeStart = $state(1)
    let rangeEnd = $state(1)
    let includeUserMessages = $state(true)
    let sidebarOpen = $state(true)
    let draftFontSizePx = $state(18)
    let draftParagraphSpacingPercent = $state(100)
    let draftImageWidthPercent = $state(60)
    let draftShowProfileImages = $state(true)
    let previewHtml = $state('')
    let previewPlainText = $state('')
    let preparedKey = $state('')
    let busy = $state(false)
    let copied = $state(false)
    let error = $state('')
    let progress = $state(0)
    let stageRoot = $state<HTMLElement | null>(null)
    let contentElement = $state<HTMLElement | null>(null)
    let wasOpen = false
    let generationToken = 0

    const sourceMessages = $derived.by((): LogSource[] => {
        const greetingIndex = Number.isFinite(chat.fmIndex) ? chat.fmIndex! : -1
        const greeting = greetingIndex === -1
            ? character.firstMessage
            : character.alternateGreetings[greetingIndex] ?? character.firstMessage
        return [
            {
                role: 'char',
                data: greeting,
                disabled: chat.firstMessageDisabled === true,
                sourceIndex: -1,
                firstMessage: true,
            },
            ...chat.message.map((message, sourceIndex) => ({ ...message, sourceIndex })),
        ]
    })
    const selectionOptions = $derived({ includeUserMessages })
    const pageSize = $derived(normalizeChatPageSize(DBState.db.chatPageSize))
    const pageCount = $derived(getChatPageCount(chat.message.length, pageSize))
    const turnCount = $derived(Math.max(1, getArcaLogTurnCount(sourceMessages)))
    const rangeMaximum = $derived(mode === 'page' ? pageCount : mode === 'turn' ? turnCount : 1)
    const rangeUnit = $derived(mode === 'turn' ? language.arcaChatLog.turnUnit : language.arcaChatLog.pageUnit)
    const activeMessages = $derived(selectArcaLogMessages(sourceMessages, { mode: 'all' }, selectionOptions))
    const selectedMessages = $derived(selectArcaLogMessages(
        sourceMessages,
        mode === 'all'
            ? { mode: 'all' }
            : mode === 'page'
                ? { mode: 'page', start: rangeStart, end: rangeEnd, pageSize }
                : { mode: 'turn', start: rangeStart, end: rangeEnd },
        selectionOptions,
    ))
    const selectionSummary = $derived(summarizeArcaLogMessages(selectedMessages.map(({ message }) => message)))
    const selectionKey = $derived([
        chat.id ?? chat.name,
        sourceMessages.length,
        mode,
        mode === 'all' ? 'all' : `${rangeStart}-${rangeEnd}-${pageSize}`,
        includeUserMessages,
        DBState.db.risuBardArcaChatFontSizePx,
        DBState.db.risuBardArcaChatParagraphSpacingPercent,
        DBState.db.risuBardArcaChatImageWidthPercent,
        DBState.db.risuBardArcaChatShowTitleImage,
    ].join(':'))
    const previewReady = $derived(Boolean(previewHtml) && preparedKey === selectionKey)
    const appearanceDirty = $derived(
        draftFontSizePx !== DBState.db.risuBardArcaChatFontSizePx
        || draftParagraphSpacingPercent !== DBState.db.risuBardArcaChatParagraphSpacingPercent
        || draftImageWidthPercent !== DBState.db.risuBardArcaChatImageWidthPercent
        || draftShowProfileImages !== (DBState.db.risuBardArcaChatShowTitleImage !== false),
    )
    const savedDialogSize = $derived(normalizeArcaChatDialogSize(DBState.db.risuBardArcaChatDialogSize))
    const dialogContentStyle = $derived([
        `--manager-width:${savedDialogSize ? `${savedDialogSize.width}px` : 'min(calc(100vw - 2rem),72rem)'}`,
        `--manager-height:${savedDialogSize ? `${savedDialogSize.height}px` : 'min(88vh,860px)'}`,
        'width:var(--manager-width)',
        'height:var(--manager-height)',
        'max-width:calc(100vw - 1rem)',
        'max-height:calc(100vh - 1rem)',
    ].join(';'))

    const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

    function themeColors() {
        const root = document.documentElement
        const style = getComputedStyle(root)
        const color = (property: string, fallback: string) =>
            style.getPropertyValue(property).trim() || root.style.getPropertyValue(property).trim() || fallback
        return {
            background: color('--risu-theme-bgcolor', '#292d3e'),
            panel: color('--risu-theme-darkbg', '#202331'),
            text: color('--risu-theme-textcolor', '#f7f8fc'),
            mutedText: color('--risu-theme-textcolor2', '#aeb6cc'),
            border: color('--risu-theme-darkborderc', '#454b61'),
        }
    }

    async function resolveIcon(reference: string | undefined): Promise<string> {
        if (!reference) return ''
        try {
            const source = await getFileSrc(reference)
            return source ? await resolveArcaImageSource(source) : ''
        }
        catch (cause) {
            console.warn('Arca log profile image skipped:', cause)
            return ''
        }
    }

    async function waitForRenderedBody(host: HTMLElement, allowEmpty: boolean): Promise<HTMLElement> {
        let previous = ''
        let stable = 0
        for (let attempt = 0; attempt < 120; attempt++) {
            await tick()
            await delay(25)
            const body = host.querySelector<HTMLElement>('.chattext')
            if (!body) continue
            const current = body.innerHTML
            if (current === previous && (allowEmpty || hasVisibleArcaLogContent(body))) stable += 1
            else stable = 0
            if (stable >= 2) return body
            previous = current
        }
        const body = host.querySelector<HTMLElement>('.chattext')
        if (!body) throw new Error(language.arcaChatLog.renderFailed)
        return body
    }

    function resetAppearanceDraft(): void {
        draftFontSizePx = normalizeArcaChatFontSizePx(DBState.db.risuBardArcaChatFontSizePx)
        draftParagraphSpacingPercent = normalizeArcaChatParagraphSpacingPercent(
            DBState.db.risuBardArcaChatParagraphSpacingPercent,
        )
        draftImageWidthPercent = normalizeArcaChatImageWidthPercent(DBState.db.risuBardArcaChatImageWidthPercent)
        draftShowProfileImages = DBState.db.risuBardArcaChatShowTitleImage !== false
    }

    function updateNumberDraft(
        event: Event,
        setting: 'font-size' | 'paragraph-spacing' | 'image-width',
    ): void {
        const input = event.currentTarget as HTMLInputElement
        const value = Number(input.value)
        if (setting === 'font-size') {
            draftFontSizePx = normalizeArcaChatFontSizePx(value)
            input.value = String(draftFontSizePx)
        }
        else if (setting === 'paragraph-spacing') {
            draftParagraphSpacingPercent = normalizeArcaChatParagraphSpacingPercent(value)
            input.value = String(draftParagraphSpacingPercent)
        }
        else {
            draftImageWidthPercent = normalizeArcaChatImageWidthPercent(value)
            input.value = String(draftImageWidthPercent)
        }
    }

    function updateProfileImagesDraft(event: Event): void {
        draftShowProfileImages = (event.currentTarget as HTMLInputElement).checked
    }

    function applyAppearanceSettings(): void {
        DBState.db.risuBardArcaChatFontSizePx = normalizeArcaChatFontSizePx(draftFontSizePx)
        DBState.db.risuBardArcaChatParagraphSpacingPercent = normalizeArcaChatParagraphSpacingPercent(
            draftParagraphSpacingPercent,
        )
        DBState.db.risuBardArcaChatImageWidthPercent = normalizeArcaChatImageWidthPercent(draftImageWidthPercent)
        DBState.db.risuBardArcaChatShowTitleImage = draftShowProfileImages
        copied = false
        preparedKey = ''
        void tick().then(() => generatePreview())
    }

    function cancelAppearanceSettings(): void {
        resetAppearanceDraft()
    }

    function toggleUserMessages(): void {
        includeUserMessages = !includeUserMessages
        DBState.db.risuBardArcaChatIncludeUserMessages = includeUserMessages
        copied = false
        preparedKey = ''
    }

    function selectRangeMode(nextMode: 'all' | 'page' | 'turn'): void {
        mode = nextMode
        rangeStart = 1
        rangeEnd = nextMode === 'page' ? pageCount : nextMode === 'turn' ? turnCount : 1
        copied = false
        preparedKey = ''
    }

    function persistDialogSize(target: HTMLElement): void {
        const { width, height } = target.getBoundingClientRect()
        DBState.db.risuBardArcaChatDialogSize = normalizeArcaChatDialogSize({ width, height })
    }

    async function generatePreview(): Promise<void> {
        if (busy || !stageRoot || selectedMessages.length === 0) return
        const token = ++generationToken
        const selection = [...selectedMessages]
        const requestedKey = selectionKey
        busy = true
        copied = false
        error = ''
        progress = 0
        preparedKey = ''

        try {
            const simpleCharacter = createSimpleCharacter(character)
            const [characterIcon, personaIcon, characterImage, personaImage] = await Promise.all([
                resolveIcon(character.image),
                resolveIcon(userIcon),
                getCharImage(character.image ?? '', 'css'),
                getCharImage(userIcon ?? '', 'css'),
            ])
            const rendered: ArcaLogRenderedMessage[] = []

            for (let index = 0; index < selection.length; index++) {
                if (token !== generationToken) return
                const selected = selection[index]
                const source = selected.message
                const host = document.createElement('div')
                stageRoot.replaceChildren(host)
                const instance = mount(Chat, {
                    target: host,
                    props: {
                        message: source.data,
                        name: source.role === 'user' ? currentUsername : character.name,
                        isLastMemory: false,
                        img: source.role === 'user' ? personaImage : characterImage,
                        idx: source.sourceIndex,
                        totalLength: chat.message.length,
                        messageGenerationInfo: source.generationInfo,
                        role: source.role,
                        character: simpleCharacter,
                        firstMessage: source.firstMessage === true,
                        largePortrait: source.role === 'user' ? false : character.largePortrait,
                    },
                })

                try {
                    const body = await waitForRenderedBody(host, !source.data.trim())
                    const bodyHtml = await exportArcaHtml(body, {
                        imageWidthPercent: DBState.db.risuBardArcaChatImageWidthPercent,
                        paragraphSpacingPercent: DBState.db.risuBardArcaChatParagraphSpacingPercent,
                        semanticPalette: $ColorSchemeTypeStore,
                        renderComplexBlock: renderArcaComplexBlock,
                    })
                    const plainText = body.innerText.trim() || body.textContent?.trim() || source.data
                    const isUser = source.role === 'user'
                    rendered.push({
                        number: selected.number,
                        role: source.role,
                        displayName: isUser ? currentUsername : character.name,
                        badge: isUser
                            ? undefined
                            : (source.generationInfo
                                ? capitalize(getModelInfo(source.generationInfo.model).shortName)
                                : 'AI'),
                        iconDataUrl: isUser ? personaIcon : characterIcon,
                        bodyHtml,
                        plainText,
                    })
                }
                finally {
                    await unmount(instance)
                    stageRoot.replaceChildren()
                }
                progress = index + 1
            }

            if (token !== generationToken) return
            const title = chat.name.trim() || character.name
            previewHtml = buildArcaLogClipboardHtml({
                title,
                messages: rendered,
                fontSizePx: DBState.db.risuBardArcaChatFontSizePx,
                showTitleImage: DBState.db.risuBardArcaChatShowTitleImage,
                colors: themeColors(),
            })
            previewPlainText = buildArcaLogPlainText(title, rendered)
            preparedKey = requestedKey
        }
        catch (cause) {
            console.error('Arca chat log generation failed:', cause)
            error = cause instanceof Error ? cause.message : String(cause)
        }
        finally {
            if (token === generationToken) busy = false
        }
    }

    async function copyPreparedLog(): Promise<void> {
        if (!previewReady) {
            await generatePreview()
            return
        }
        if (!window.navigator.clipboard.write || typeof ClipboardItem === 'undefined') {
            notifyError(language.arcaChatLog.clipboardUnsupported)
            return
        }
        try {
            await window.navigator.clipboard.write([
                new ClipboardItem({
                    'text/html': new Blob([previewHtml], { type: 'text/html' }),
                    'text/plain': new Blob([previewPlainText], { type: 'text/plain' }),
                }),
            ])
            copied = true
            notifySuccess(language.arcaChatLog.copied)
        }
        catch (cause) {
            console.error('Arca chat log copy failed:', cause)
            notifyError(language.arcaChatLog.copyFailed)
        }
    }

    function close(next: boolean): void {
        if (!next) {
            generationToken += 1
            busy = false
            stageRoot?.replaceChildren()
        }
        onOpenChange(next)
    }

    $effect(() => {
        if (open && !wasOpen) {
            wasOpen = true
            mode = 'all'
            includeUserMessages = normalizeArcaChatIncludeUserMessages(
                DBState.db.risuBardArcaChatIncludeUserMessages,
            )
            sidebarOpen = true
            resetAppearanceDraft()
            rangeStart = 1
            rangeEnd = 1
            previewHtml = ''
            previewPlainText = ''
            preparedKey = ''
            error = ''
            copied = false
            void tick().then(() => generatePreview())
        }
        else if (!open) {
            wasOpen = false
        }
    })
</script>

<ShDialog {open} onOpenChange={close} size="xl" tier="base"
    closeOnEscape={!busy} closeOnOutsideClick={true}
    bind:contentElement
    contentClass="overflow-hidden gap-3"
    contentStyle={dialogContentStyle}
    bodyClass="min-h-0 flex-1 overflow-hidden" closeAriaLabel={language.close}>
    {#snippet title()}
        <span class="flex items-center gap-2"><FileTextIcon size={20} />{language.arcaChatLog.title}</span>
    {/snippet}
    {#snippet description()}{chat.name || character.name} · {activeMessages.length}{language.arcaChatLog.messages}{/snippet}

    <ManagerResizeHandles target={contentElement} centered onResizeEnd={persistDialogSize} />

    <div class="arca-log-workspace" class:sidebar-collapsed={!sidebarOpen}>
        {#if sidebarOpen}
        <aside class="arca-log-settings" aria-label={language.arcaChatLog.rangeHeading}>
            <div class="arca-log-settings-heading">
                <div>
                    <h3>{language.arcaChatLog.rangeHeading}</h3>
                    <p>{language.arcaChatLog.rangeHelp}</p>
                </div>
                <button type="button" class="arca-log-sidebar-toggle" data-arca-log-sidebar-toggle
                    aria-label={language.arcaChatLog.collapseSidebar} aria-expanded="true"
                    onclick={() => { sidebarOpen = false }}>
                    <PanelLeftCloseIcon size={20} />
                </button>
            </div>

            <div class="arca-log-mode-grid">
                <button type="button" data-arca-log-mode="all" class:active={mode === 'all'} disabled={busy}
                    aria-pressed={mode === 'all'} onclick={() => selectRangeMode('all')}>
                    <strong>{language.arcaChatLog.wholeChat}</strong>
                    <span>{activeMessages.length}{language.arcaChatLog.messages}</span>
                </button>
                <button type="button" data-arca-log-mode="page" class:active={mode === 'page'} disabled={busy}
                    aria-pressed={mode === 'page'} onclick={() => selectRangeMode('page')}>
                    <strong>{language.arcaChatLog.pageRange}</strong>
                    <span>{pageCount}{language.arcaChatLog.pages}</span>
                </button>
                <button type="button" data-arca-log-mode="turn" class:active={mode === 'turn'} disabled={busy}
                    aria-pressed={mode === 'turn'} onclick={() => selectRangeMode('turn')}>
                    <strong>{language.arcaChatLog.turnRange}</strong>
                    <span>{turnCount}{language.arcaChatLog.turns}</span>
                </button>
            </div>

            <div class="arca-log-range-row">
                {#if mode === 'all'}
                    <div class="arca-log-range-placeholder">{language.arcaChatLog.wholeChatSelected}</div>
                {:else}
                    <div class="arca-log-range">
                        <label>{language.arcaChatLog.from} {rangeUnit}
                            <input data-arca-log-range-start type="number" min="1" max={rangeMaximum}
                                bind:value={rangeStart} disabled={busy} />
                        </label>
                        <span aria-hidden="true">—</span>
                        <label>{language.arcaChatLog.to} {rangeUnit}
                            <input data-arca-log-range-end type="number" min="1" max={rangeMaximum}
                                bind:value={rangeEnd} disabled={busy} />
                        </label>
                    </div>
                {/if}
                <button type="button" class="arca-log-user-toggle" data-arca-log-user-messages
                    class:active={includeUserMessages} disabled={busy}
                    aria-pressed={includeUserMessages} onclick={toggleUserMessages}>
                    <strong>{includeUserMessages
                        ? language.arcaChatLog.includeUserMessages
                        : language.arcaChatLog.excludeUserMessages}</strong>
                    <span>{language.arcaChatLog.userMessages}</span>
                </button>
            </div>

            <div class="arca-log-selection-summary" aria-live="polite">
                <span>{language.arcaChatLog.total} <strong>{selectionSummary.characters}</strong>{language.arcaChatLog.charactersUnit},
                    {language.arcaChatLog.imagesLabel} <strong>{selectionSummary.images}</strong>{language.arcaChatLog.countUnit}</span>
            </div>

            <div class="arca-log-output-settings">
                <div>
                    <span class="arca-log-kicker">{language.arcaChatLog.outputSettings}</span>
                    <h3>{language.arcaChatLog.appearance}</h3>
                    <p>{language.arcaChatLog.settingsHelp}</p>
                </div>
                <div class="arca-log-setting-list">
                    <label>
                        <span>{language.arcaChatLog.fontSize}</span>
                        <input data-arca-log-setting="font-size" type="number" min="10" max="32" step="1"
                            value={draftFontSizePx} disabled={busy}
                            onchange={(event) => updateNumberDraft(event, 'font-size')} />
                    </label>
                    <label>
                        <span>{language.arcaChatLog.paragraphSpacing}</span>
                        <input data-arca-log-setting="paragraph-spacing" type="number" min="0" max="300" step="10"
                            value={draftParagraphSpacingPercent} disabled={busy}
                            onchange={(event) => updateNumberDraft(event, 'paragraph-spacing')} />
                    </label>
                    <label>
                        <span>{language.arcaChatLog.imageWidth}</span>
                        <input data-arca-log-setting="image-width" type="number" min="10" max="100" step="1"
                            value={draftImageWidthPercent} disabled={busy}
                            onchange={(event) => updateNumberDraft(event, 'image-width')} />
                    </label>
                    <label class="arca-log-check">
                        <span>{language.arcaChatLog.profileImages}</span>
                        <input data-arca-log-setting="profile-images" type="checkbox"
                            checked={draftShowProfileImages} disabled={busy}
                            onchange={updateProfileImagesDraft} />
                    </label>
                </div>
                <div class="arca-log-setting-actions">
                    <ShButton variant="ghost" data-arca-log-settings-cancel disabled={busy || !appearanceDirty}
                        onclick={cancelAppearanceSettings}>{language.arcaChatLog.cancelSettings}</ShButton>
                    <ShButton variant="primary" data-arca-log-settings-apply disabled={busy || !appearanceDirty}
                        onclick={applyAppearanceSettings}>{language.arcaChatLog.applySettings}</ShButton>
                </div>
                <p class="arca-log-layout-note">{language.arcaChatLog.complexLayoutHelp}</p>
            </div>
            <p class="arca-log-note">{language.arcaChatLog.exclusionNote}</p>
        </aside>
        {/if}

        <section class="arca-log-preview-panel" aria-label={language.arcaChatLog.preview}>
            <header>
                <div class="arca-log-preview-heading">
                    {#if !sidebarOpen}
                        <button type="button" class="arca-log-sidebar-toggle" data-arca-log-sidebar-toggle
                            aria-label={language.arcaChatLog.openSidebar} aria-expanded="false"
                            onclick={() => { sidebarOpen = true }}>
                            <PanelLeftOpenIcon size={20} />
                        </button>
                    {/if}
                    <h3>{language.arcaChatLog.preview}</h3>
                </div>
                {#if previewReady}
                    <span class="arca-log-ready"><CheckIcon size={14} />{language.arcaChatLog.ready}</span>
                {/if}
            </header>

            <div class="arca-log-preview" data-arca-log-preview>
                {#if busy}
                    <div class="arca-log-state" role="status">
                        <LoaderCircleIcon size={30} class="animate-spin" />
                        <strong>{language.arcaChatLog.generating}</strong>
                        <span>{progress} / {selectedMessages.length}</span>
                        <div class="arca-log-progress"><span style:width={`${selectedMessages.length ? progress / selectedMessages.length * 100 : 0}%`}></span></div>
                    </div>
                {:else if error}
                    <div class="arca-log-state arca-log-error" role="alert">
                        <strong>{language.arcaChatLog.failed}</strong><span>{error}</span>
                    </div>
                {:else if previewHtml}
                    <div class="arca-log-paper">{@html previewHtml}</div>
                {:else}
                    <div class="arca-log-state"><SparklesIcon size={30} /><span>{language.arcaChatLog.emptyPreview}</span></div>
                {/if}
            </div>
        </section>
    </div>

    <div class="arca-log-export-stage" aria-hidden="true" bind:this={stageRoot}></div>

    {#snippet footer()}
        <ShButton variant="ghost" disabled={busy} onclick={() => close(false)}>{language.cancel}</ShButton>
        <ShButton variant="primary" data-arca-log-submit disabled={busy || selectedMessages.length === 0}
            onclick={() => void copyPreparedLog()}>
            {#if busy}
                <LoaderCircleIcon size={16} class="animate-spin" />{language.arcaChatLog.generating}
            {:else if previewReady}
                {#if copied}<CheckIcon size={16} />{language.arcaChatLog.copiedShort}{:else}<CopyIcon size={16} />{language.arcaChatLog.copy}{/if}
            {:else}
                <SparklesIcon size={16} />{language.arcaChatLog.createPreview}
            {/if}
        </ShButton>
    {/snippet}
</ShDialog>

<style>
    .arca-log-workspace { height: 100%; min-height: 0; display: grid; grid-template-columns: minmax(230px, .34fr) minmax(0, 1fr); gap: .875rem; }
    .arca-log-workspace.sidebar-collapsed { grid-template-columns: minmax(0, 1fr); }
    .arca-log-settings, .arca-log-preview-panel { min-height: 0; border: 1px solid var(--color-darkborderc); border-radius: .875rem; background: var(--color-darkbg); }
    .arca-log-settings { display: flex; flex-direction: column; gap: 1rem; padding: 1rem; overflow-y: auto; }
    .arca-log-settings-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: .75rem; }
    .arca-log-settings-heading > div { min-width: 0; }
    .arca-log-settings h3, .arca-log-preview-panel h3 { margin: 0; overflow: hidden; color: var(--color-textcolor); font-size: 1.25rem; font-weight: 700; white-space: nowrap; text-overflow: ellipsis; }
    .arca-log-settings p { margin-top: .3rem; color: var(--color-textcolor2); font-size: .75rem; line-height: 1.55; }
    .arca-log-kicker { color: var(--color-borderc); font-size: .625rem; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
    .arca-log-sidebar-toggle { width: 2.75rem; height: 2.75rem; display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; border: 1px solid var(--color-darkborderc); border-radius: .7rem; background: var(--color-bgcolor); color: var(--color-textcolor2); transition: border-color .15s ease, background .15s ease, color .15s ease; }
    .arca-log-sidebar-toggle:hover { border-color: var(--color-borderc); background: var(--color-selected); color: var(--color-textcolor); }
    .arca-log-sidebar-toggle:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
    .arca-log-mode-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .5rem; }
    .arca-log-mode-grid button { min-width: 0; padding: .7rem .6rem; border: 1px solid var(--color-darkborderc); border-radius: .75rem; background: var(--color-bgcolor); color: var(--color-textcolor); text-align: left; transition: border-color .15s ease, background .15s ease, transform .15s ease; }
    .arca-log-mode-grid button:hover { transform: translateY(-1px); border-color: var(--color-borderc); }
    .arca-log-mode-grid button:disabled { cursor: wait; opacity: .58; transform: none; }
    .arca-log-mode-grid button.active { border-color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 12%, var(--color-bgcolor)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-primary) 35%, transparent); }
    .arca-log-mode-grid strong, .arca-log-mode-grid span { display: block; }
    .arca-log-mode-grid strong { font-size: .8125rem; }
    .arca-log-mode-grid span { margin-top: .3rem; overflow: hidden; color: var(--color-textcolor2); font-size: .6875rem; white-space: nowrap; text-overflow: ellipsis; }
    .arca-log-range-row { display: flex; flex-wrap: wrap; align-items: stretch; gap: .5rem; }
    .arca-log-range, .arca-log-range-placeholder { flex: 1 1 11rem; min-width: 0; }
    .arca-log-range { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: end; gap: .5rem; }
    .arca-log-range label { color: var(--color-textcolor2); font-size: .6875rem; }
    .arca-log-range input { width: 100%; height: 2.5rem; margin-top: .35rem; padding: 0 .65rem; border: 1px solid var(--color-darkborderc); border-radius: .625rem; background: var(--color-bgcolor); color: var(--color-textcolor); font-variant-numeric: tabular-nums; }
    .arca-log-range input:focus-visible { outline: 2px solid var(--color-borderc); outline-offset: 2px; }
    .arca-log-range > span { padding-bottom: .7rem; color: var(--color-textcolor2); }
    .arca-log-range-placeholder { display: flex; align-items: center; min-height: 3.5rem; padding: 0 .75rem; border: 1px solid var(--color-darkborderc); border-radius: .75rem; background: var(--color-bgcolor); color: var(--color-textcolor2); font-size: .75rem; }
    .arca-log-user-toggle { flex: 1 0 7.5rem; min-width: 0; padding: .65rem .7rem; border: 1px solid var(--color-darkborderc); border-radius: .75rem; background: var(--color-bgcolor); color: var(--color-textcolor); text-align: left; transition: border-color .15s ease, background .15s ease; }
    .arca-log-user-toggle:hover { border-color: var(--color-borderc); }
    .arca-log-user-toggle:disabled { cursor: wait; opacity: .58; }
    .arca-log-user-toggle.active { border-color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 12%, var(--color-bgcolor)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-primary) 35%, transparent); }
    .arca-log-user-toggle strong, .arca-log-user-toggle span { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .arca-log-user-toggle strong { font-size: .8125rem; }
    .arca-log-user-toggle span { margin-top: .3rem; color: var(--color-textcolor2); font-size: .6875rem; }
    .arca-log-selection-summary { display: flex; align-items: center; padding: .75rem; border-radius: .75rem; background: var(--color-selected); font-size: .75rem; }
    .arca-log-selection-summary span { color: var(--color-textcolor2); }
    .arca-log-selection-summary strong { color: var(--color-textcolor); font-variant-numeric: tabular-nums; }
    .arca-log-output-settings { display: flex; flex-direction: column; gap: .75rem; padding-top: .875rem; border-top: 1px solid var(--color-darkborderc); }
    .arca-log-setting-list { overflow: hidden; border: 1px solid var(--color-darkborderc); border-radius: .75rem; background: var(--color-bgcolor); }
    .arca-log-setting-list label { min-height: 2.75rem; display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding: .5rem .65rem; color: var(--color-textcolor); font-size: .72rem; }
    .arca-log-setting-list label + label { border-top: 1px solid var(--color-darkborderc); }
    .arca-log-setting-list input[type='number'] { width: 4.75rem; height: 2rem; padding: 0 .45rem; border: 1px solid var(--color-darkborderc); border-radius: .5rem; background: var(--color-darkbg); color: var(--color-textcolor); text-align: right; font-variant-numeric: tabular-nums; }
    .arca-log-setting-list input[type='checkbox'] { width: 1.05rem; height: 1.05rem; accent-color: var(--color-primary); }
    .arca-log-setting-list input:focus-visible { outline: 2px solid var(--color-borderc); outline-offset: 2px; }
    .arca-log-setting-list input:disabled { cursor: wait; opacity: .58; }
    .arca-log-setting-actions { display: flex; justify-content: flex-end; gap: .5rem; }
    .arca-log-layout-note { margin: 0 !important; padding: .6rem .7rem; border-radius: .625rem; background: color-mix(in srgb, var(--color-primary) 8%, var(--color-bgcolor)); }
    .arca-log-note { margin-top: auto !important; padding-top: .75rem; border-top: 1px solid var(--color-darkborderc); }
    .arca-log-preview-panel { display: flex; flex-direction: column; overflow: hidden; }
    .arca-log-preview-panel > header { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; min-height: 3rem; gap: .75rem; padding: .45rem .75rem; border-bottom: 1px solid var(--color-darkborderc); }
    .arca-log-preview-heading { min-width: 0; display: flex; align-items: center; gap: .65rem; }
    .arca-log-ready { display: inline-flex; align-items: center; gap: .25rem; padding: .25rem .5rem; border: 1px solid var(--color-success-border); border-radius: 999px; background: var(--color-success-bg); color: var(--color-success); font-size: .6875rem; }
    .arca-log-preview { min-height: 0; flex: 1; overflow: auto; padding: 1rem; background: color-mix(in srgb, var(--color-bgcolor) 78%, var(--color-shadow)); scrollbar-gutter: stable; }
    .arca-log-paper { width: min(100%, 760px); margin: 0 auto; filter: drop-shadow(0 18px 30px color-mix(in srgb, var(--color-shadow) 22%, transparent)); }
    .arca-log-state { min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .65rem; color: var(--color-textcolor2); text-align: center; }
    .arca-log-state strong { color: var(--color-textcolor); }
    .arca-log-state span { font-size: .75rem; }
    .arca-log-error { color: var(--color-danger); }
    .arca-log-progress { width: min(15rem, 70%); height: .25rem; overflow: hidden; border-radius: 999px; background: var(--color-selected); }
    .arca-log-progress span { display: block; height: 100%; border-radius: inherit; background: var(--color-primary); transition: width .2s ease; }
    .arca-log-export-stage { position: fixed; left: -100000px; top: 0; width: 760px; pointer-events: none; }

    @media (max-width: 640px) {
        .arca-log-workspace { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(18rem, 1fr); overflow-y: auto; }
        .arca-log-workspace.sidebar-collapsed { grid-template-rows: minmax(18rem, 1fr); }
        .arca-log-settings { overflow: visible; }
        .arca-log-mode-grid { grid-template-columns: repeat(3, minmax(5.25rem, 1fr)); overflow-x: auto; padding-bottom: .2rem; }
        .arca-log-preview-panel { min-height: 22rem; }
        .arca-log-note { margin-top: 0 !important; }
    }
</style>
