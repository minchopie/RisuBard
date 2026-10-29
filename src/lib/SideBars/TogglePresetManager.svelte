<script lang="ts">
    import {
        ArrowDownIcon,
        ArrowUpIcon,
        CheckIcon,
        CopyIcon,
        DownloadIcon,
        EllipsisVerticalIcon,
        GripVerticalIcon,
        MinusIcon,
        PencilIcon,
        PlusIcon,
        SaveIcon,
        SearchIcon,
        StarIcon,
        TrashIcon,
        UploadIcon,
        XIcon,
    } from '@lucide/svelte'
    import Sortable from 'sortablejs'
    import { untrack } from 'svelte'
    import { language } from 'src/lang'
    import { alertConfirm, alertError, alertInput, notifySuccess } from 'src/ts/alert'
    import { downloadFile } from 'src/ts/globalApi.svelte'
    import {
        applyTogglePresetToChat,
        getCurrentChat,
        setNewChatTogglePreset,
        setPinnedTogglePresetBaseline,
        snapshotCurrentToggleValues,
        type TogglePreset,
    } from 'src/ts/storage/database.svelte'
    import { DBState } from 'src/ts/stores.svelte'
    import { selectSingleFile } from 'src/ts/util'
    import ManagerResizeHandles from '../UI/GUI/ManagerResizeHandles.svelte'
    import ShButton from '../UI/GUI/ShButton.svelte'
    import ShDialog from '../UI/GUI/ShDialog.svelte'
    import ShDropdownMenu from '../UI/GUI/ShDropdownMenu.svelte'
    import ShDropdownMenuContent from '../UI/GUI/ShDropdownMenuContent.svelte'
    import ShDropdownMenuItem from '../UI/GUI/ShDropdownMenuItem.svelte'
    import ShDropdownMenuSeparator from '../UI/GUI/ShDropdownMenuSeparator.svelte'
    import ShDropdownMenuTrigger from '../UI/GUI/ShDropdownMenuTrigger.svelte'
    import ShInput from '../UI/GUI/ShInput.svelte'
    import ShSwitch from '../UI/GUI/ShSwitch.svelte'

    interface Props {
        open: boolean
        onOpenChange: (open: boolean) => void
    }

    interface Entry { preset: TogglePreset }
    interface Group { key: string; label: string; current: boolean; entries: Entry[] }
    type CheckState = 'on' | 'off' | 'mixed'

    let { open, onOpenChange }: Props = $props()
    let showAll = $state(false)
    let search = $state('')
    let selected = $state.raw(new Set<TogglePreset>())
    let anchor: TogglePreset | null = null
    let dialogElement = $state<HTMLElement | null>(null)

    // This component stays mounted from app start, before the database has loaded.
    const currentPromptPresetName = $derived(DBState.db?.botPresets?.[DBState.db.botPresetsId]?.name)
    const query = $derived(search.trim().toLocaleLowerCase())
    const groups = $derived.by(() => {
        if (!open) return []
        const map = new Map<string, Group>()
        for (const preset of DBState.db?.togglePresets ?? []) {
            const current = preset.promptPresetName === currentPromptPresetName
            if (!showAll && !current) continue
            if (query && !preset.name.toLocaleLowerCase().includes(query)) continue
            const key = preset.promptPresetName ?? '\u0000'
            let group = map.get(key)
            if (!group) {
                group = { key, label: preset.promptPresetName ?? language.togglePresetNoPromptPreset, current, entries: [] }
                map.set(key, group)
            }
            group.entries.push({ preset })
        }
        // The prompt preset in use comes first; the rest keep their saved order.
        return [...map.values()].sort((a, b) => Number(b.current) - Number(a.current))
    })
    const visible = $derived(groups.flatMap(group => group.entries.map(entry => entry.preset)))
    const selectedVisible = $derived(visible.filter(preset => selected.has(preset)))

    // Selection only ever covers what is on screen, so bulk delete never
    // reaches presets hidden by the search or the prompt preset filter.
    $effect(() => {
        const shown = new Set(visible)
        const current = untrack(() => selected)
        if ([...current].some(preset => !shown.has(preset))) {
            selected = new Set([...current].filter(preset => shown.has(preset)))
        }
        if (anchor && !shown.has(anchor)) anchor = null
    })

    $effect(() => {
        if (open) return
        untrack(() => {
            selected = new Set()
            anchor = null
            search = ''
        })
    })

    function checkState(presets: TogglePreset[]): CheckState {
        const count = presets.filter(preset => selected.has(preset)).length
        return count === 0 ? 'off' : count === presets.length ? 'on' : 'mixed'
    }

    function toggleItem(preset: TogglePreset, shift: boolean) {
        const next = new Set(selected)
        const target = !selected.has(preset)
        const from = shift && anchor ? visible.indexOf(anchor) : -1
        const to = visible.indexOf(preset)
        if (from >= 0 && to >= 0) {
            for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
                if (target) next.add(visible[i])
                else next.delete(visible[i])
            }
        } else if (target) next.add(preset)
        else next.delete(preset)
        selected = next
        anchor = preset
    }

    function toggleMany(presets: TogglePreset[]) {
        const next = new Set(selected)
        const target = checkState(presets) !== 'on'
        for (const preset of presets) {
            if (target) next.add(preset)
            else next.delete(preset)
        }
        selected = next
    }

    function commit(next = DBState.db.togglePresets ?? []) {
        DBState.db.togglePresets = [...next]
    }

    function indexOfPreset(preset: TogglePreset) {
        return DBState.db.togglePresets?.indexOf(preset) ?? -1
    }

    // Reorders inside one section: the section's presets trade places among
    // the array slots they already occupy, so other sections keep their order.
    function reorderGroup(group: Group, from: number, to: number) {
        const list = DBState.db.togglePresets
        if (!list || from === to || to < 0 || to >= group.entries.length) return
        const slots = group.entries.map(entry => list.indexOf(entry.preset)).sort((a, b) => a - b)
        if (slots.some(slot => slot < 0)) return
        const ordered = group.entries.map(entry => entry.preset)
        const [moved] = ordered.splice(from, 1)
        ordered.splice(to, 0, moved)
        const next = [...list]
        slots.forEach((slot, i) => { next[slot] = ordered[i] })
        commit(next)
    }

    function sortableSection(node: HTMLElement, params: { onReorder: (from: number, to: number) => void }) {
        let current = params
        let originalNext: Node | null = null
        const sortable = Sortable.create(node, {
            handle: '.toggle-preset-drag-handle',
            draggable: '.toggle-preset-row',
            animation: 150,
            ghostClass: 'toggle-preset-row-ghost',
            onStart: (event) => { originalNext = event.item.nextSibling },
            onEnd: (event) => {
                const { oldIndex, newIndex, item, from } = event
                if (oldIndex === undefined || newIndex === undefined || oldIndex === newIndex) return
                // Svelte owns these rows (and the list's end anchor): put the moved node
                // back exactly where it was and let the data drive the order.
                from.insertBefore(item, originalNext)
                current.onReorder(oldIndex, newIndex)
            },
        })
        return {
            update(next: typeof params) { current = next },
            destroy() { sortable.destroy() },
        }
    }

    async function applyPreset(preset: TogglePreset) {
        const mismatch = preset.promptPresetName !== currentPromptPresetName
        if (!await alertConfirm(mismatch ? language.togglePresetMismatchConfirm : language.togglePresetApplyConfirm)) return
        applyTogglePresetToChat(preset)
        notifySuccess((language.togglePresetApplied as any)(preset.name))
        onOpenChange(false)
    }

    async function overwritePreset(preset: TogglePreset) {
        const presetName = preset.name
        if (!await alertConfirm((language.togglePresetOverwriteConfirm as any)(presetName))) return
        const index = indexOfPreset(preset)
        if (index < 0) return
        const values = snapshotCurrentToggleValues()
        DBState.db.togglePresets![index].values = values
        DBState.db.togglePresets![index].promptPresetName = currentPromptPresetName
        commit()
        setPinnedTogglePresetBaseline(getCurrentChat(), values, presetName)
        notifySuccess((language.togglePresetOverwritten as any)(presetName))
    }

    async function renamePreset(preset: TogglePreset) {
        const oldName = preset.name
        const name = await alertInput(language.togglePresetRename, [], oldName)
        const index = indexOfPreset(preset)
        if (!name || name === oldName || index < 0) return
        DBState.db.togglePresets![index].name = name
        commit()
        notifySuccess((language.togglePresetRenamed as any)(oldName, name))
    }

    function duplicatePreset(preset: TogglePreset) {
        const index = indexOfPreset(preset)
        if (index < 0) return
        const copy = $state.snapshot(preset)
        copy.name = `${preset.name} (Copy)`
        delete copy.applyToNewChats
        const next = [...DBState.db.togglePresets!]
        next.splice(index + 1, 0, copy)
        commit(next)
        notifySuccess((language.togglePresetDuplicated as any)(copy.name))
    }

    function exportPreset(preset: TogglePreset) {
        const data = { name: preset.name, values: preset.values, promptPresetName: preset.promptPresetName }
        downloadFile(`${preset.name}_toggle.json`, Buffer.from(JSON.stringify(data, null, 2), 'utf-8'))
        notifySuccess((language.togglePresetExported as any)(preset.name))
    }

    function toggleNewChatPreset(preset: TogglePreset) {
        if (preset.applyToNewChats) {
            setNewChatTogglePreset(null)
            notifySuccess(language.togglePresetAutoApplyOff)
        } else {
            setNewChatTogglePreset(preset)
            notifySuccess((language.togglePresetAutoApplyOn as any)(preset.name))
        }
    }

    async function deletePreset(preset: TogglePreset) {
        const name = preset.name
        if (!await alertConfirm((language.togglePresetDeleteConfirm as any)(name))) return
        commit((DBState.db.togglePresets ?? []).filter(item => item !== preset))
        notifySuccess((language.togglePresetDeleted as any)(name))
    }

    async function deleteSelected() {
        const targets = selectedVisible
        if (!targets.length) return
        const shown = targets.slice(0, 10).map(preset => `- ${preset.name}`)
        if (targets.length > shown.length) shown.push((language.togglePresetMoreNames as any)(targets.length - shown.length))
        if (!await alertConfirm((language.togglePresetDeleteSelectedConfirm as any)(targets.length, shown.join('\n')))) return
        const removed = new Set(targets)
        commit((DBState.db.togglePresets ?? []).filter(preset => !removed.has(preset)))
        selected = new Set()
        anchor = null
        notifySuccess((language.togglePresetDeletedMany as any)(targets.length))
    }

    async function saveNewPreset() {
        const name = await alertInput(language.togglePresetNamePrompt)
        if (!name) return
        commit([...(DBState.db.togglePresets ?? []), { name, values: snapshotCurrentToggleValues(), promptPresetName: currentPromptPresetName }])
        notifySuccess((language.togglePresetSaved as any)(name))
    }

    async function importPreset() {
        let file: { name: string, data: Uint8Array } | undefined
        try {
            file = await selectSingleFile(['json'])
        }
        catch {
            return
        }
        if (!file) return

        try {
            const data = JSON.parse(Buffer.from(file.data).toString('utf-8'))
            if (typeof data.name !== 'string' || !data.values || typeof data.values !== 'object' || Array.isArray(data.values)) {
                alertError(language.togglePresetImportError)
                return
            }
            const values: Record<string, string> = {}
            for (const [key, value] of Object.entries(data.values)) {
                if (typeof key === 'string' && typeof value === 'string') values[key] = value
            }
            commit([...(DBState.db.togglePresets ?? []), {
                name: data.name,
                values,
                promptPresetName: typeof data.promptPresetName === 'string' ? data.promptPresetName : undefined,
            }])
            notifySuccess((language.togglePresetImported as any)(data.name))
        }
        catch {
            alertError(language.togglePresetImportError)
        }
    }

    const rowActions = [
        { icon: SaveIcon, label: () => language.togglePresetMenuOverwrite, run: overwritePreset },
        { icon: PencilIcon, label: () => language.togglePresetMenuRename, run: renamePreset },
        { icon: CopyIcon, label: () => language.togglePresetMenuDuplicate, run: duplicatePreset },
        { icon: DownloadIcon, label: () => language.togglePresetMenuExport, run: exportPreset },
    ]
</script>

{#snippet checkbox(state: CheckState, label: string, onToggle: (shift: boolean) => void, title?: string)}
    <button
        type="button"
        role="checkbox"
        aria-checked={state === 'mixed' ? 'mixed' : state === 'on'}
        aria-label={label}
        {title}
        class="toggle-preset-check shrink-0 size-7 grid place-items-center rounded-md cursor-pointer hover:bg-selected/30 focus-visible:outline-2 focus-visible:outline-borderc"
        onmousedown={(event) => { if (event.shiftKey) event.preventDefault() }}
        onclick={(event) => onToggle(event.shiftKey)}
    >
        <span class="size-4 rounded border-2 grid place-items-center transition-colors {state === 'off' ? 'border-darkborderc bg-darkbutton' : 'border-primary bg-primary text-accenttext'}">
            {#if state === 'on'}<CheckIcon size={12} strokeWidth={3} />{:else if state === 'mixed'}<MinusIcon size={12} strokeWidth={3} />{/if}
        </span>
    </button>
{/snippet}

<ShDialog
    {open}
    onOpenChange={(next) => { if (!next) onOpenChange(false) }}
    tier="base"
    bind:contentElement={dialogElement}
    contentClass="toggle-preset-dialog"
    bodyClass="toggle-preset-body"
>
    {#snippet title()}{language.togglePresetSelectTitle}{/snippet}

    {#if open}
        <div class="flex flex-col gap-3 flex-1 min-h-0">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div class="relative flex-1 min-w-0">
                    <SearchIcon size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-textcolor2 pointer-events-none" />
                    <ShInput
                        bind:value={search}
                        placeholder={language.togglePresetSearchPlaceholder}
                        aria-label={language.togglePresetSearchPlaceholder}
                        className="pl-9 pr-9"
                    />
                    {#if search}
                        <button
                            type="button"
                            class="absolute right-2 top-1/2 -translate-y-1/2 size-7 grid place-items-center rounded-md text-textcolor2 hover:text-textcolor hover:bg-selected/30 cursor-pointer"
                            aria-label={language.togglePresetSearchClear}
                            title={language.togglePresetSearchClear}
                            onclick={() => { search = '' }}
                        ><XIcon size={14} /></button>
                    {/if}
                </div>
                <label class="flex items-center gap-2 text-sm text-textcolor2 shrink-0 cursor-pointer select-none">
                    <ShSwitch bind:checked={showAll} />
                    {language.togglePresetFilterShowAll}
                </label>
            </div>

            <div class="@container flex-1 min-h-0 overflow-y-auto pr-1 -mr-1">
                {#if !DBState.db?.togglePresets?.length}
                    <p class="text-textcolor2 text-sm py-2">{language.togglePresetEmpty}</p>
                {:else if groups.length === 0}
                    <p class="text-textcolor2 text-sm py-2">
                        {query ? (language.togglePresetSearchEmpty as any)(search.trim()) : language.togglePresetEmptyFiltered}
                    </p>
                {:else}
                    {#each groups as group (group.key)}
                        {@const groupPresets = group.entries.map(entry => entry.preset)}
                        <section class="mb-2 last:mb-0" aria-label={group.label}>
                            <div class="sticky top-0 z-[1] flex items-center gap-1 bg-darkbg py-1">
                                {@render checkbox(checkState(groupPresets), (language.togglePresetSelectGroup as any)(group.label), () => toggleMany(groupPresets))}
                                <span class="min-w-0 truncate text-sm font-medium text-textcolor2" title={group.label}>{group.label}</span>
                                {#if group.current}
                                    <span class="shrink-0 rounded px-1.5 py-0.5 text-[0.6875rem] leading-none bg-binding text-binding-text border border-binding-border">{language.togglePresetCurrentGroup}</span>
                                {/if}
                                <span class="ml-auto shrink-0 pr-2 text-xs text-textcolor2">{group.entries.length}</span>
                            </div>
                            <div class="flex flex-col gap-1" use:sortableSection={{ onReorder: (from, to) => reorderGroup(group, from, to) }}>
                                {#each group.entries as { preset }, i (preset)}
                                    {@const isSelected = selected.has(preset)}
                                    <div class="toggle-preset-row flex items-center gap-0.5 rounded-md border px-1 transition-colors {isSelected ? 'border-borderc bg-selected/20' : 'border-darkborderc hover:border-borderc/60'}">
                                        <span
                                            class="toggle-preset-drag-handle hidden pointer-fine:grid shrink-0 w-4 h-7 place-items-center text-textcolor2 cursor-grab active:cursor-grabbing"
                                            title={language.togglePresetDragHandle}
                                            aria-hidden="true"
                                        ><GripVerticalIcon size={14} /></span>
                                        {@render checkbox(isSelected ? 'on' : 'off', (language.togglePresetSelectItem as any)(preset.name), (shift) => toggleItem(preset, shift), language.togglePresetShiftHint)}
                                        <button
                                            type="button"
                                            class="flex-1 min-w-0 py-2 px-1 text-left cursor-pointer text-textcolor truncate rounded-md hover:bg-selected/30 transition-colors"
                                            title={preset.name}
                                            onclick={() => applyPreset(preset)}
                                        >{preset.name}</button>
                                        <div class="flex items-center shrink-0 gap-0.5">
                                            <ShButton
                                                variant="ghost"
                                                size="icon-xs"
                                                className={preset.applyToNewChats ? 'text-primary hover:text-primary' : 'text-textcolor2'}
                                                title={preset.applyToNewChats ? language.togglePresetAutoApplyActive : language.togglePresetAutoApply}
                                                aria-label={language.togglePresetAutoApply}
                                                aria-pressed={!!preset.applyToNewChats}
                                                onclick={() => toggleNewChatPreset(preset)}
                                            ><StarIcon fill={preset.applyToNewChats ? 'currentColor' : 'none'} /></ShButton>
                                            {#if group.entries.length > 1}
                                                <div class="hidden pointer-coarse:flex items-center gap-0.5">
                                                    <ShButton variant="ghost" size="icon-xs" disabled={i === 0} title={language.togglePresetMoveUp} aria-label={language.togglePresetMoveUp} onclick={() => reorderGroup(group, i, i - 1)}><ArrowUpIcon /></ShButton>
                                                    <ShButton variant="ghost" size="icon-xs" disabled={i === group.entries.length - 1} title={language.togglePresetMoveDown} aria-label={language.togglePresetMoveDown} onclick={() => reorderGroup(group, i, i + 1)}><ArrowDownIcon /></ShButton>
                                                </div>
                                            {/if}
                                            <div class="hidden @min-[26rem]:flex items-center gap-0.5">
                                                {#each rowActions as action}
                                                    <ShButton variant="ghost" size="icon-xs" title={action.label()} aria-label={action.label()} onclick={() => action.run(preset)}><action.icon /></ShButton>
                                                {/each}
                                                <ShButton variant="ghost" size="icon-xs" className="text-danger hover:text-danger" title={language.togglePresetMenuDelete} aria-label={language.togglePresetMenuDelete} onclick={() => deletePreset(preset)}><TrashIcon /></ShButton>
                                            </div>
                                            <div class="@min-[26rem]:hidden">
                                                <ShDropdownMenu>
                                                    <ShDropdownMenuTrigger>
                                                        {#snippet child({ props })}
                                                            <ShButton {...props} variant="ghost" size="icon-xs" title={language.togglePresetMoreActions} aria-label={language.togglePresetMoreActions}><EllipsisVerticalIcon /></ShButton>
                                                        {/snippet}
                                                    </ShDropdownMenuTrigger>
                                                    <ShDropdownMenuContent class="min-w-40" align="end">
                                                        {#each rowActions as action}
                                                            <ShDropdownMenuItem onSelect={() => action.run(preset)}><action.icon size={14} />{action.label()}</ShDropdownMenuItem>
                                                        {/each}
                                                        <ShDropdownMenuSeparator />
                                                        <ShDropdownMenuItem variant="destructive" onSelect={() => deletePreset(preset)}><TrashIcon size={14} />{language.togglePresetMenuDelete}</ShDropdownMenuItem>
                                                    </ShDropdownMenuContent>
                                                </ShDropdownMenu>
                                            </div>
                                        </div>
                                    </div>
                                {/each}
                            </div>
                        </section>
                    {/each}
                {/if}
            </div>

            <div class="flex items-center gap-1 border-t border-darkborderc pt-3">
                {#if visible.length}
                    {@render checkbox(checkState(visible), language.togglePresetSelectAll, () => toggleMany(visible))}
                {/if}
                <span class="min-w-0 truncate text-sm text-textcolor2">
                    {selectedVisible.length ? (language.togglePresetSelectedCount as any)(selectedVisible.length) : (language.togglePresetVisibleCount as any)(visible.length)}
                </span>
                <div class="ml-auto flex items-center gap-1 shrink-0">
                    <ShButton variant="outline" size="icon-sm" title={language.togglePresetSaveNew} aria-label={language.togglePresetSaveNew} onclick={saveNewPreset}><PlusIcon size={16} /></ShButton>
                    <ShButton variant="outline" size="icon-sm" title={language.togglePresetImport} aria-label={language.togglePresetImport} onclick={importPreset}><UploadIcon size={16} /></ShButton>
                    <ShButton variant="outline" size="icon-sm" className="text-danger hover:text-danger" disabled={!selectedVisible.length} title={language.togglePresetDeleteSelected} aria-label={language.togglePresetDeleteSelected} onclick={deleteSelected}><TrashIcon size={16} /></ShButton>
                </div>
            </div>
        </div>
        <ManagerResizeHandles target={dialogElement} centered resizeStorageKey="toggle-preset-dialog" />
    {/if}
</ShDialog>

<style>
    :global(.toggle-preset-dialog) {
        width: min(var(--manager-width, 32rem), calc(100vw - 2rem));
        max-width: calc(100vw - 2rem);
        /* A fixed default height keeps the search box still while results shrink. */
        height: var(--manager-height, 40rem);
        max-height: min(90dvh, calc(100dvh - 2rem));
        min-height: min(20rem, calc(100dvh - 2rem));
        overflow: hidden;
    }
    :global(.toggle-preset-body) {
        flex: 1 1 auto;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }
    :global(.toggle-preset-row-ghost) {
        opacity: 0.4;
    }
</style>
