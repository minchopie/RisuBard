import { v4 } from 'uuid'
import { unzip } from 'fflate'
import { DBState, ReloadChatPointer } from '../stores.svelte'
import { downloadFile, forageStorage, globalFetch, requestImmediateSave } from '../globalApi.svelte'
import { requestChatData } from '../process/request/request'
import { collectLoreBuilderSources, matchLoreBuilderCharacterLorebook } from '../loreBuilder'
import { loadNarrativeMemoryWiki } from '../risubard/memoryWiki'
import { getInlayAssetBlob, setInlayAsset } from '../process/files/inlays'
import { buildPainterMessages, buildPainterRepairMessages, parsePainterDraft, buildPainterImageRequest } from './prompt'
import { PAINTER_STYLES } from './styles'
import { applyPainterPresets, capturePainterOutfit, promotePainterOutfit, reconcilePainterSubjects } from './state'
import { insertPainterReference, shiftPainterAnchor } from './selection'
import { createPainterChatData, type PainterAnchor, type PainterContextSource, type PainterIdentity, type PainterOutfit, type PainterResult, type PainterStyle } from './types'
import { savePainterGalleryRecord } from './gallery'
import { migrateLegacyDraft } from './subjectPrompt'
import { painterSelection, painterInsertionRequest } from './selectionState'
import { get } from 'svelte/store'
import { ensureChatHydrated } from '../storage/chatStorage'
import { resolvePersonaById } from '../personaScopes'
import { createPainterSettings, painterGenerationSettings, painterImageSize, painterSizeMode, type PainterSettings } from './types'
import { painterImageToggleScope, painterPromptDatabase, painterPromptPreset } from './imagePreset'
import type { PainterContext, PainterDraft, PainterFragment, PainterSubject } from './types'
import type { PainterLibraryData } from './types'
import { painterSubjectLimit } from './types'
import type { loreBook } from '../storage/database.svelte'
import { blankPainterIdentityIds, botOutfitCatalog, copyPainterIdentity, copyPainterOutfit, getPainterLoreIdentity, globalIdentityForSubject, outfitsForIdentity, painterNameKey, unreflectedGlobalIdentities, withPainterLoreIdentity } from './library'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
const persist = () => requestImmediateSave({ flushServer: 'canonical-background', rejectOnFailure: true })
type PresetWrite = <T, K extends keyof T>(owner: T, key: K, value: T[K]) => void
let presetMutationInProgress = false
const normalizedName = (name: string) => name.trim().toLocaleLowerCase()
function uniquePresetName(name: string, items: Array<{ id: string; name: string }>, id: string) {
    if (!name.trim()) throw new Error('프리셋 이름을 입력해 주세요.')
    if (items.some(item => item.id !== id && normalizedName(item.name) === normalizedName(name))) throw new Error('같은 이름의 프리셋이 있습니다. 다른 이름을 입력해 주세요.')
}
function movedPreset<T extends { id: string }>(items: T[], id: string, direction: -1 | 1, sameGroup: (item: T) => boolean = () => true): T[] | undefined {
    if (direction !== -1 && direction !== 1) return
    const index = items.findIndex(item => item.id === id)
    if (index < 0) return
    let target = index + direction
    while (target >= 0 && target < items.length && !sameGroup(items[target])) target += direction
    if (target < 0 || target >= items.length) return
    const next = [...items]
    ;[next[index], next[target]] = [next[target], next[index]]
    return next
}

export class PainterSession {
    readonly characterId: string
    readonly chatId: string
    state = $state({
        status: 'idle' as 'idle' | 'prompt' | 'image' | 'saving', error: '', notice: '',
        wikiDocs: [] as Array<{ id: string; title: string; content: string }>,
        loadingWiki: false, pendingImage: false, sources: [] as PainterContextSource[],
    })
    private controller: AbortController | null = null
    /** Presets connected through lore entries matched for the latest prompt request. */
    private loreIdentityIds = new Set<string>()
    private pending: {
        png: Uint8Array
        result: PainterResult
        compressed?: { data: Uint8Array; width: number; height: number; mime: 'image/webp' }
        assetSaved?: boolean
    } | null = null
    private wikiPromise: Promise<boolean> | null = null
    private readonly loreKeys = new WeakMap<object, string>()

    constructor(characterId: string, chatId: string) {
        this.characterId = characterId; this.chatId = chatId
        this.state.pendingImage = this.data.results.some((item) => item.compressionPending)
        // Imported chat drafts may arrive before any bot-wide identity registry exists.
        // Initialize it here, before subject components read it in derived expressions.
        this.character.bardPainter ??= { identities: [], outfits: [] }
        // The next save stores the converted fields; an unsaved migration only repeats.
        migrateLegacyDraft(this.data.draft)
        migrateLegacyDraft(this.data.previousDraft)
    }
    get character() {
        const character = DBState.db.characters.find((item) => item.chaId === this.characterId)
        if (!character) throw new Error('이 봇을 사용할 수 없습니다.')
        return character
    }
    get chat() {
        const chat = this.character.chats.find((item) => item.id === this.chatId)
        if (!chat || chat._placeholder || !Array.isArray(chat.message)) throw new Error('이 챗을 먼저 열어 주세요.')
        return chat
    }
    get data() { return this.chat.bardPainter ??= createPainterChatData(this.defaultStyle.id) }
    get bot() { return this.character.bardPainter ??= { identities: [], outfits: [] } }
    get globalLibrary(): PainterLibraryData { return DBState.db.bardPainterLibrary ?? { identities: [], outfits: [] } }
    /** Bot-only outfits plus the global outfits selected for this bot. */
    get botCatalog(): PainterLibraryData { return botOutfitCatalog(this.bot, this.globalLibrary) }
    async setBotGlobalOutfits(ids: string[]): Promise<boolean> {
        return (await this.presetAction('이 봇에서 쓸 글로벌 의상을 저장했습니다.', write => {
            const unique = [...new Set(ids)]
            if (unique.some(id => !this.globalLibrary.outfits.some(item => item.id === id && !item.subjectId))) throw new Error('글로벌 의상 목록이 바뀌었습니다. 다시 선택해 주세요.')
            const previous = new Map((this.bot.globalOutfits ?? []).map(ref => [ref.id, ref]))
            // Unselected outfits stay linked to characters but are hidden until selected again.
            write(this.bot, 'globalOutfits', unique.map(id => previous.get(id) ?? { id }))
            return true
        })) === true
    }
    async setGlobalOutfitAttachment(id: string, attached: boolean): Promise<boolean> {
        return (await this.presetAction(attached ? '글로벌 의상을 이 봇의 카드 첨부로 저장했습니다.' : '글로벌 의상의 카드 첨부를 해제했습니다.', write => {
            const refs = this.bot.globalOutfits ?? []
            if (!refs.some(ref => ref.id === id)) throw new Error('이 봇에서 쓰는 글로벌 의상이 아닙니다.')
            write(this.bot, 'globalOutfits', refs.map(ref => ref.id === id ? (attached ? { id, attachToCard: true } : { id }) : ref))
            return true
        })) === true
    }
    private libraryForWrite(global: boolean, write: PresetWrite): PainterLibraryData {
        if (!global) return this.bot
        if (!DBState.db.bardPainterLibrary) write(DBState.db, 'bardPainterLibrary', { identities: [], outfits: [] })
        return DBState.db.bardPainterLibrary!
    }
    private loreKey(entry: loreBook): string {
        if (entry.id) return entry.id
        let key = this.loreKeys.get(entry)
        if (!key) { key = `temporary:${v4()}`; this.loreKeys.set(entry, key) }
        return key
    }
    get loreEntries() {
        return (this.character.globalLore ?? []).filter(entry => entry.mode !== 'folder' && entry.mode !== 'child')
            .map(entry => ({ id: this.loreKey(entry), title: entry.comment || entry.key || '이름 없는 로어', content: entry.content,
                identityId: getPainterLoreIdentity(entry) }))
    }
    async setLoreIdentity(loreId: string, identityId?: string): Promise<boolean> {
        return (await this.presetAction(identityId ? '로어에 캐릭터 프리셋을 연결했습니다.' : '로어 연결을 해제했습니다.', write => {
            if (identityId && !this.bot.identities.some(item => item.id === identityId)) throw new Error('연결할 캐릭터 프리셋을 다시 선택해 주세요.')
            const entries = this.character.globalLore ?? []
            const matches = entries.filter(entry => this.loreKey(entry) === loreId && entry.mode !== 'folder' && entry.mode !== 'child')
            if (matches.length !== 1) throw new Error('로어 항목이 바뀌었습니다. 목록에서 다시 선택해 주세요.')
            const entry = matches[0]
            const next = withPainterLoreIdentity(entry, identityId)
            write(this.character, 'globalLore', entries.map(item => item === entry ? { ...next, id: entry.id || v4() } : item))
            return true
        })) === true
    }
    async setIdentityOutfits(identityId: string, outfitIds: string[], defaultOutfitId?: string, global = false): Promise<boolean> {
        return (await this.presetAction('캐릭터의 의상 목록과 기본 의상을 저장했습니다.', write => {
            const catalog = global ? this.globalLibrary : this.bot
            const visible = global ? catalog : this.botCatalog
            if (!catalog.identities.some(item => item.id === identityId)) throw new Error('의상을 연결할 캐릭터를 다시 선택해 주세요.')
            const ids = [...new Set(outfitIds)]
            if (ids.some(id => !visible.outfits.some(item => item.id === id)) || (defaultOutfitId && !ids.includes(defaultOutfitId))) {
                throw new Error('의상 목록과 기본 의상을 다시 선택해 주세요.')
            }
            // Convert only explicitly managed legacy outfits; keep their original owner's association.
            const converted = catalog.outfits.filter(item => item.subjectId && (item.subjectId === identityId || ids.includes(item.id)))
            const identities = catalog.identities.map(item => {
                const next = { ...item, outfitIds: [...new Set([...(item.outfitIds ?? []), ...converted.filter(outfit => outfit.subjectId === item.id).map(outfit => outfit.id)])] }
                if (item.id === identityId) {
                    const hidden = (id?: string) => !!id && !visible.outfits.some(outfit => outfit.id === id)
                    next.outfitIds = [...new Set([...ids, ...(item.outfitIds ?? []).filter(id => hidden(id))])]
                    if (defaultOutfitId) next.defaultOutfitId = defaultOutfitId
                    else if (!hidden(item.defaultOutfitId)) delete next.defaultOutfitId
                }
                return next
            })
            const names = new Set(catalog.outfits.filter(item => !item.subjectId).map(item => normalizedName(item.name)))
            const outfits = catalog.outfits.map(item => {
                if (!converted.includes(item)) return item
                const base = item.name.trim()
                let name = base, suffix = 2
                while (names.has(normalizedName(name))) name = `${base} (${suffix++})`
                names.add(normalizedName(name))
                const next = { ...item, name, subjectId: '' }
                // Sharing changes the export boundary; require an explicit attachment choice again.
                delete next.attachToCard
                return next
            })
            write(catalog, 'outfits', outfits)
            write(catalog, 'identities', identities)
            return true
        })) === true
    }
    async copyIdentityToGlobal(id: string): Promise<string | undefined> {
        return this.presetAction('캐릭터와 의상을 글로벌 라이브러리에 복사했습니다.', write => {
            const copied = copyPainterIdentity(this.botCatalog, id, this.globalLibrary, new Set(this.globalLibrary.outfits.map(item => item.id)))
            const target = this.libraryForWrite(true, write)
            write(target, 'identities', [...target.identities, copied.identity])
            write(target, 'outfits', [...target.outfits, ...copied.outfits])
            return copied.identity.id
        })
    }
    async importGlobalIdentity(id: string): Promise<string | undefined> {
        return this.presetAction('캐릭터와 의상을 현재 봇에 반영했습니다.', write => this.reflectGlobalIdentity(id, write))
    }
    /** Global characters this bot cannot use yet; the planner only reads bot presets. */
    get unreflectedGlobalIdentities() { return unreflectedGlobalIdentities(this.bot, this.globalLibrary) }
    /** Blank bot identities judged from loaded chats only; pruning rechecks every chat. */
    get blankIdentityIds() { return blankPainterIdentityIds(this.bot, this.character.chats.flatMap(chat => chat.bardPainter?.outfits ?? []), this.character.globalLore ?? []) }
    globalMatchFor(subject: Pick<PainterSubject, 'name' | 'aliases' | 'kind' | 'id'>) {
        if (subject.kind !== 'character' || this.bot.identities.some(item => item.id === subject.id && item.appearance.trim())) return
        return globalIdentityForSubject(subject, this.bot, this.globalLibrary)
    }
    /**
     * Copy a global character into this bot. A same-named blank entry is filled in place so
     * its chat outfits and lore links stay attached; an existing reflection is reused.
     */
    private reflectGlobalIdentity(id: string, write: PresetWrite): string {
        const source = this.globalLibrary.identities.find(item => item.id === id)
        if (!source) throw new Error('글로벌 캐릭터를 다시 선택해 주세요.')
        const reflected = this.bot.identities.find(item => item.sourceId === id && item.appearance.trim())
        if (reflected) return reflected.id
        const copied = copyPainterIdentity(this.globalLibrary, id, this.bot, new Set(this.globalLibrary.outfits.map(item => item.id)))
        const blank = this.bot.identities.find(item => !item.appearance.trim() && (item.sourceId === id || painterNameKey(item.name) === painterNameKey(source.name)))
        const identity: PainterIdentity = blank ? {
            ...blank, appearance: copied.identity.appearance, sourceId: id,
            aliases: [...new Set([...blank.aliases, ...copied.identity.aliases])],
            ...(blank.note?.trim() || copied.identity.note ? { note: blank.note?.trim() || copied.identity.note } : {}),
            outfitIds: [...new Set([...(blank.outfitIds ?? []), ...(copied.identity.outfitIds ?? [])])],
            ...(blank.defaultOutfitId ?? copied.identity.defaultOutfitId ? { defaultOutfitId: blank.defaultOutfitId ?? copied.identity.defaultOutfitId } : {}),
        } : { ...copied.identity, sourceId: id }
        const refs = this.bot.globalOutfits ?? []
        write(this.bot, 'identities', blank ? this.bot.identities.map(item => item === blank ? identity : item) : [...this.bot.identities, identity])
        write(this.bot, 'outfits', [...this.bot.outfits, ...copied.outfits])
        write(this.bot, 'globalOutfits', [...refs, ...copied.linkedIds.filter(item => !refs.some(ref => ref.id === item)).map(item => ({ id: item }))])
        return identity.id
    }
    async copyOutfitToGlobal(id: string, shared: boolean): Promise<string | undefined> {
        return this.presetAction('의상을 글로벌 라이브러리에 복사했습니다.', write => {
            const source = (shared ? this.bot : this.data).outfits.find(item => item.id === id)
            if (!source) throw new Error('복사할 의상을 다시 선택해 주세요.')
            const copied = copyPainterOutfit(source, this.globalLibrary.outfits)
            const target = this.libraryForWrite(true, write)
            write(target, 'outfits', [...target.outfits, copied])
            return copied.id
        })
    }
    async importGlobalOutfit(id: string): Promise<string | undefined> {
        return this.presetAction('의상을 현재 봇으로 가져왔습니다.', write => {
            const source = this.globalLibrary.outfits.find(item => item.id === id)
            if (!source) throw new Error('가져올 의상을 다시 선택해 주세요.')
            const copied = copyPainterOutfit(source, this.bot.outfits)
            write(this.bot, 'outfits', [...this.bot.outfits, copied])
            return copied.id
        })
    }
    get styles() { return [...PAINTER_STYLES, ...(DBState.db.bardPainterStyles ?? [])] }
    get fragments() { return DBState.db.bardPainterFragments ?? [] }
    get defaultStyle() { return this.styles.find(item => item.id === DBState.db.bardPainterDefaultStyleId) ?? PAINTER_STYLES[0] }
    get style() { return this.styles.find((item) => item.id === this.data.settings.styleId) ?? this.defaultStyle }
    get promptPreset() { return painterPromptPreset(DBState.db, this.chat) }
    get imagePresets() {
        const prompt = this.promptPreset
        return prompt ? (DBState.db.togglePresets ?? []).map((preset, index) => ({ preset, index }))
            .filter(({ preset }) => preset.promptPresetName === prompt.name) : []
    }
    get imagePreset() {
        const applied = this.data.imagePreset
        return applied && applied.promptPresetId === this.promptPreset?.id ? applied : undefined
    }
    async applyImagePreset(index: number | null): Promise<boolean> {
        if (this.state.status !== 'idle' || this.state.pendingImage) return false
        this.state.status = 'saving'
        try {
            return await this.action(async () => {
                const preset = index === null ? undefined : this.imagePresets.find(item => item.index === index)?.preset
                if (index !== null && (!preset || !this.promptPreset?.id)) throw new Error('현재 프롬프트의 이미지 프리셋을 다시 선택해 주세요.')
                const data = this.data, previous = data.imagePreset
                data.imagePreset = preset ? { promptPresetId: this.promptPreset.id, name: preset.name, values: clone(preset.values) } : undefined
                try { await persist() } catch (cause) { data.imagePreset = previous; throw cause }
                this.state.notice = preset ? `이미지 프리셋 '${preset.name}'을 적용했습니다. 다음 프롬프트 작성과 개선에 사용합니다.` : '이미지 프리셋을 해제했습니다.'
            })
        } finally { this.state.status = 'idle' }
    }

    get generationSettingsPinned() { return this.bot.settings !== undefined }
    get hasGenerationOverrides() { return this.generationSettingsPinned || this.data.settingsScope !== 'global' }
    get settings(): PainterSettings {
        const local = this.data.settings
        const shared = this.bot.settings ?? (this.data.settingsScope === 'global' ? DBState.db.bardPainterSettings : undefined)
        const merged = { ...local, ...shared, context: { ...local.context, ...shared?.context } }
        // Legacy shared settings decide their own size mode instead of inheriting a newer local default.
        if (shared && shared.sizeMode === undefined) merged.sizeMode = painterSizeMode(shared)
        return merged
    }
    async updateGenerationSettings(settings: PainterSettings) {
        const shared = painterGenerationSettings(settings)
        if (this.generationSettingsPinned) this.bot.settings = shared
        else {
            this.data.settings = { ...this.data.settings, ...shared, context: { ...this.data.settings.context, ...shared.context } }
            this.data.settingsScope = 'chat'
        }
        return this.persist()
    }
    async pinGenerationSettings(pinned: boolean) {
        const current = this.settings
        if (pinned) this.bot.settings = painterGenerationSettings(current)
        else {
            delete this.bot.settings
            this.data.settings = current
            this.data.settingsScope = 'chat'
        }
        return this.persist()
    }
    async applyGenerationSettingsToGlobal() {
        DBState.db.bardPainterSettings = painterGenerationSettings(this.settings)
        this.data.settingsScope = 'global'
        return this.persist()
    }
    async useGlobalGenerationSettings() {
        if (this.generationSettingsPinned) this.bot.settings = painterGenerationSettings({
            ...createPainterSettings(), ...DBState.db.bardPainterSettings,
            context: { ...createPainterSettings().context, ...DBState.db.bardPainterSettings?.context },
        })
        this.data.settingsScope = 'global'
        // With no saved global defaults, reset only reusable options to factory defaults.
        const defaults = painterGenerationSettings(createPainterSettings())
        this.data.settings = { ...this.data.settings, ...defaults, context: { ...this.data.settings.context, ...defaults.context } }
        return this.persist()
    }

    private async action(work: () => void | Promise<void>) {
        this.state.error = ''; this.state.notice = ''
        try { await work(); return true } catch (cause) { this.state.error = errorText(cause); return false }
    }
    async persist() { return await this.action(persist) }

    async resetWorkspace(): Promise<boolean> {
        if (this.state.status !== 'idle' || this.state.pendingImage) return false
        this.state.status = 'saving'
        try {
            return await this.action(async () => {
                const chat = this.chat
                if (chat.isStreaming) throw new Error('메시지 작성이 끝난 뒤 리셋해 주세요.')
                const previous = this.data
                if (previous.results.some(result => result.compressionPending)) throw new Error('이미지 저장을 마친 뒤 리셋해 주세요.')
                // Gallery metadata must survive even for old images without a separate record.
                for (const result of previous.results) await savePainterGalleryRecord(result, chat.name ?? '')
                if (chat.isStreaming) throw new Error('메시지 작성이 끝난 뒤 리셋해 주세요.')
                const cleared = {
                    ...previous, anchor: undefined, draft: undefined, previousDraft: undefined, conversation: [], results: [],
                    settings: { ...previous.settings, instruction: '', context: { ...previous.settings.context, referenceId: '', referenceAssetId: '' } },
                }
                chat.bardPainter = cleared
                const active = chat.bardPainter
                try { await persist() }
                catch (cause) { if (chat.bardPainter === active) chat.bardPainter = previous; throw cause }
                painterSelection.update(selection => selection?.characterId === this.characterId && selection.chatId === this.chatId ? null : selection)
                painterInsertionRequest.update(request => request?.characterId === this.characterId && request.chatId === this.chatId ? null : request)
                this.state.sources = []
                this.state.notice = '작업을 리셋했습니다. 생성 설정과 프리셋, 갤러리 이미지는 유지됩니다.'
            })
        } finally { this.state.status = 'idle' }
    }

    async setReference(assetId: string): Promise<boolean> {
        if (this.state.status !== 'idle' || this.state.pendingImage) return false
        this.state.status = 'saving'
        const success = await this.action(async () => {
            if (this.chat.isStreaming) throw new Error('메시지 작성이 끝난 뒤 참고 삽화를 변경해 주세요.')
            const context = this.data.settings.context
            if (assetId) {
                const { loadPainterReference } = await import('./reference')
                if (!await loadPainterReference(assetId, this.characterId)) throw new Error('이 그림에는 참고할 생성 정보가 없거나 현재 봇에서 사용할 수 없습니다.')
            }
            if (this.data.settings.context !== context) throw new Error('챗 내용이 변경되었습니다. 참고 삽화를 다시 지정해 주세요.')
            const previous = { assetId: context.referenceAssetId, legacyId: context.referenceId }
            context.referenceAssetId = assetId
            context.referenceId = ''
            try { await persist() }
            catch (cause) {
                if (context.referenceAssetId === assetId && context.referenceId === '') {
                    context.referenceAssetId = previous.assetId
                    context.referenceId = previous.legacyId
                }
                throw cause
            }
            this.state.notice = assetId ? '현재 챗의 참고 삽화를 지정했습니다.' : '참고 삽화 슬롯을 비웠습니다.'
        })
        this.state.status = 'idle'
        return success
    }

    private assertPresetReady(global = false) {
        const characters = global ? DBState.db.characters : [this.character]
        for (const character of characters) for (const chat of character.chats) {
            const own = character.chaId === this.characterId && chat.id === this.chatId
            if (chat.isStreaming || (!own && chat.id && isPainterChatBusy(character.chaId, chat.id)) || chat.bardPainter?.results?.some(item => item.compressionPending)) {
                throw new Error('진행 중인 생성과 이미지 저장을 마친 뒤 프리셋을 변경해 주세요.')
            }
        }
    }
    private async presetAction<T>(notice: string, work: (write: PresetWrite) => T | undefined | Promise<T | undefined>, global = false, draftOnly = false): Promise<T | undefined> {
        if (this.state.status !== 'idle' || this.state.pendingImage || presetMutationInProgress) return
        this.state.status = 'saving'
        presetMutationInProgress = true
        let result: T | undefined
        const undo: Array<() => void> = []
        const write: PresetWrite = (owner, key, value) => {
            const prior = owner[key]
            undo.push(() => { owner[key] = prior })
            owner[key] = value
        }
        try {
            await this.action(async () => {
                try {
                    // Draft edits touch only this chat; other chats may keep streaming.
                    if (!draftOnly) this.assertPresetReady(global)
                    const value = await work(write)
                    if (value === undefined || value === false) return
                    await persist()
                    result = value
                    this.state.notice = notice
                } catch (cause) {
                    for (const restore of undo.reverse()) restore()
                    throw cause
                }
            })
        } finally { this.state.status = 'idle'; presetMutationInProgress = false }
        return result
    }

    /** Outfits a saved character can wear here: its chat, bot and selected global outfits. */
    outfitsFor(identityId: string): PainterOutfit[] {
        return [...this.data.outfits.filter(outfit => outfit.subjectId === identityId),
            ...outfitsForIdentity(this.botCatalog, identityId).map(outfit => ({ ...outfit, subjectId: identityId }))]
    }
    /** Outfits offered in a block's picker: its own first, then shared templates. */
    outfitChoices(subjectId: string): PainterOutfit[] {
        const own = this.outfitsFor(subjectId)
        const shared = [...this.data.outfits, ...this.botCatalog.outfits].filter(item => !item.subjectId && !own.some(outfit => outfit.id === item.id))
        return [...own, ...shared]
    }
    /** A block filled from a saved character: its look verbatim, plus the default outfit when the block has none. */
    private linkedSubject(subject: PainterSubject, identity: PainterIdentity, replaceOutfit = false): PainterSubject {
        const next: PainterSubject = { ...clone(subject), id: identity.id, name: identity.name, aliases: [...identity.aliases], kind: 'character', presetMatch: 'manual' }
        if (identity.appearance.trim()) { next.appearance = identity.appearance; delete next.appearanceEdited }
        const outfit = identity.defaultOutfitId && (replaceOutfit || !next.clothing.trim()) ? this.outfitsFor(identity.id).find(item => item.id === identity.defaultOutfitId) : undefined
        if (outfit) { next.clothing = outfit.clothing; next.state = outfit.state; next.outfitId = outfit.id; delete next.outfitEdited }
        return next
    }
    private findBotIdentity(id: string) {
        const identity = this.bot.identities.find(item => item.id === id)
        if (!identity) throw new Error('캐릭터 프리셋을 다시 선택해 주세요.')
        return identity
    }
    /** Add a block before or after planning. A global character is reflected into this bot first. */
    async addSubject(options: { kind?: PainterSubject['kind']; identityId?: string; globalId?: string } = {}): Promise<string | undefined> {
        const notice = options.globalId ? '글로벌 캐릭터를 이 봇에 반영하고 인물 블록을 추가했습니다.' : options.identityId ? '캐릭터 프리셋으로 인물 블록을 추가했습니다.' : options.kind === 'object' ? '사물 블록을 추가했습니다.' : '인물 블록을 추가했습니다.'
        return this.presetAction(notice, write => {
            const subjects = this.data.draft?.subjects ?? []
            if (subjects.length >= painterSubjectLimit(this.settings.model)) throw new Error(`선택한 모델은 인물과 사물 블록을 최대 ${painterSubjectLimit(this.settings.model)}개까지 지원합니다.`)
            let subject: PainterSubject = { id: v4(), name: '', aliases: [], kind: options.kind ?? 'character', appearance: '', clothing: '', state: '', pose: '', negative: '', manual: true }
            const identityId = options.globalId ? this.reflectGlobalIdentity(options.globalId, write) : options.identityId
            if (identityId) {
                if (subjects.some(item => item.id === identityId)) throw new Error('이미 인물 블록에 있는 캐릭터입니다.')
                subject = this.linkedSubject(subject, this.findBotIdentity(identityId))
            }
            if (this.data.draft) write(this.data.draft, 'subjects', [...subjects, subject])
            else write(this.data, 'draft', { rendering: '', scene: '', negative: '', subjects: [subject] } satisfies PainterDraft)
            return subject.id
        }, false, !options.globalId)
    }
    /** Fill a block from a bot character, or from a global one after reflecting it into this bot. */
    async linkSubject(subjectId: string, target: { identityId?: string; globalId?: string }): Promise<boolean> {
        return (await this.presetAction(target.globalId ? '글로벌 캐릭터를 이 봇에 반영하고 블록에 불러왔습니다.' : '캐릭터 프리셋을 블록에 불러왔습니다.', write => {
            const draft = this.data.draft
            const subject = draft?.subjects.find(item => item.id === subjectId)
            if (!draft || !subject) throw new Error('인물 블록을 다시 선택해 주세요.')
            const identityId = target.globalId ? this.reflectGlobalIdentity(target.globalId, write) : target.identityId
            if (!identityId) return
            if (draft.subjects.some(item => item !== subject && item.id === identityId)) throw new Error('이미 다른 블록에 불러온 캐릭터입니다.')
            const linked = this.linkedSubject(subject, this.findBotIdentity(identityId), subject.id !== identityId)
            write(draft, 'subjects', draft.subjects.map(item => item === subject ? linked : item))
            return true
        }, false, !target.globalId)) === true
    }
    /** Pick another moment. User-added and locked blocks carry over; the planned text does not. */
    async changeScene(anchor: PainterAnchor): Promise<boolean> {
        if (this.state.status !== 'idle' || this.state.pendingImage) return false
        if (anchor.characterId !== this.characterId || anchor.chatId !== this.chatId) return false
        this.state.status = 'saving'
        try {
            return await this.action(async () => {
                if (this.chat.isStreaming) throw new Error('메시지 작성이 끝난 뒤 장면을 바꿔 주세요.')
                const data = this.data
                const prior = { anchor: data.anchor, draft: data.draft, previousDraft: data.previousDraft, conversation: data.conversation }
                const kept = (data.draft?.subjects ?? []).filter(item => item.manual || item.locked).map(item => item.locked ? clone(item) : { ...clone(item), pose: '' })
                const fragments = data.draft?.fragments
                data.anchor = clone(anchor)
                data.draft = kept.length || fragments?.length ? { rendering: '', scene: '', negative: '', subjects: kept, ...(fragments?.length ? { fragments: clone(fragments) } : {}) } : undefined
                data.previousDraft = undefined
                data.conversation = []
                try { await persist() } catch (cause) { Object.assign(data, prior); throw cause }
                this.state.notice = kept.length ? '장면을 바꿨습니다. 직접 추가하거나 잠근 블록은 유지했습니다.' : '그릴 장면을 정했습니다.'
            })
        } finally { this.state.status = 'idle' }
    }
    /** Context choices made in the main panel follow the same scope as other generation options. */
    async updateContext(patch: Partial<PainterContext>): Promise<boolean> {
        const { wikiIds, referenceId: _referenceId, referenceAssetId: _referenceAssetId, ...shared } = patch
        if (wikiIds) this.data.settings.context.wikiIds = [...new Set(wikiIds)]
        if (!Object.keys(shared).length) return this.persist()
        const settings = this.settings
        return this.updateGenerationSettings({ ...settings, context: { ...settings.context, ...shared } })
    }
    /** Remove bot identities with nothing saved in them, after loading every chat's outfits. */
    async pruneBlankIdentities(): Promise<number | undefined> {
        if (!blankPainterIdentityIds(this.bot, [], this.character.globalLore ?? []).length) return 0
        const removed = await this.presetAction('', async write => {
            const character = this.character
            const chatIds = character.chats.map(chat => chat.id)
            for (const chatId of chatIds) {
                const index = character.chats.findIndex(chat => chat.id === chatId)
                const hydrated = index < 0 ? null : await ensureChatHydrated(character.chats, index, character.chaId)
                if (!hydrated || hydrated._placeholder || !Array.isArray(hydrated.message)) throw new Error('챗의 의상 프리셋을 읽지 못해 빈 인물 정리를 미뤘습니다.')
            }
            this.assertPresetReady()
            const ids = new Set(blankPainterIdentityIds(this.bot, character.chats.flatMap(chat => chat.bardPainter?.outfits ?? []), character.globalLore ?? []))
            if (!ids.size) return 0
            write(this.bot, 'identities', this.bot.identities.filter(item => !ids.has(item.id)))
            return ids.size
        })
        if (removed) this.state.notice = `내용이 비어 있던 인물 프리셋 ${removed}개를 정리했습니다.`
        return removed
    }
    /** Clean up once per bot and app run; failures stay silent and the manual button remains. */
    async autoPruneBlankIdentities() {
        if (autoPruned.has(this.characterId) || !blankPainterIdentityIds(this.bot, [], this.character.globalLore ?? []).length) return
        autoPruned.add(this.characterId)
        const error = this.state.error
        if (await this.pruneBlankIdentities() === undefined) this.state.error = error
    }

    loadWiki() {
        if (this.wikiPromise) return this.wikiPromise
        this.state.loadingWiki = true
        this.wikiPromise = this.action(async () => {
            const wiki = await loadNarrativeMemoryWiki({ characterId: this.characterId, chatId: this.chatId, fetchImpl: fetch, createAuth: () => forageStorage.createAuth() })
            this.state.wikiDocs = wiki.mode === 'markdown'
                ? wiki.documents.filter((item) => item.status === 'active').map(({ id, title, content }) => ({ id, title, content })) : []
        }).finally(() => { this.state.loadingWiki = false; this.wikiPromise = null })
        return this.wikiPromise
    }

    private async context(anchor: PainterAnchor, instruction: string): Promise<PainterContextSource[]> {
        const chat = this.chat
        const options = this.settings.context
        const index = chat.message.findIndex((item) => item.chatId === anchor.messageId)
        if (index < 0) throw new Error('선택한 메시지가 없습니다. 본문에서 장면을 다시 선택해 주세요.')
        const char = this.character
        const contextCharacter = { ...char, chatPage: char.chats.indexOf(chat) }
        const imagePreset = this.imagePreset
        const database = painterPromptDatabase(DBState.db, chat)
        const globalChatVariables = imagePreset ? await painterImageToggleScope(database, char, chat, imagePreset.values) : undefined
        const includeSystemPrompt = options.systemPrompt || !!imagePreset
        const parsePrompt = includeSystemPrompt ? (await import('../parser/parser.svelte')).risuChatParser : undefined
        const modules = new Set([...(DBState.db.enabledModules ?? []), ...(char.modules ?? []), ...(chat.modules ?? [])])
        const source = collectLoreBuilderSources({
            database,
            character: { ...contextCharacter, globalLore: [] },
            parsePrompt: parsePrompt ? (text, role) => parsePrompt(text, { db: database, chara: contextCharacter, role, globalChatVariables }) : undefined,
            targetEntryId: '',
            moduleLorebooks: (DBState.db.modules ?? []).filter((item) => modules.has(item.id))
                .flatMap((item) => (item.lorebook ?? []).map((entry) => ({ scopeId: `module:${item.id}`, entry }))),
        })
        const result: PainterContextSource[] = []
        const add = (name: string, content: string | undefined) => { if (content?.trim()) result.push({ name, content }) }
        for (const key of ['systemPrompt', 'characterDescription', 'moduleLorebook'] as const) {
            if (key === 'systemPrompt' ? includeSystemPrompt : options[key]) add(key, source[key])
        }
        if (options.persona) {
            const personas = [...(char.personas ?? []), ...(DBState.db.personas ?? [])]
            const persona = personas.find((item) => item.id === chat.bindedPersona)
            add('페르소나', persona?.personaPrompt ?? DBState.db.personaPrompt)
        }
        const scene = [anchor.text]
        if (options.surrounding && !anchor.insertionUnavailable) {
            const message = chat.message[index].data
            add('선택 구간 앞 문맥', message.slice(0, anchor.start))
            add('선택 구간 뒤 문맥', message.slice(anchor.end))
            scene.push(message.slice(0, anchor.start), message.slice(anchor.end))
        }
        const before = Math.max(0, Math.min(50, Math.trunc(options.before || 0)))
        const after = Math.max(0, Math.min(50, Math.trunc(options.after || 0)))
        for (let i = Math.max(0, index - before); i <= Math.min(chat.message.length - 1, index + after); i++) {
            if (i === index) continue
            const msg = chat.message[i]
            if (msg.disabled || msg.isComment || msg.data.includes('<!-- OOC_turn -->')) continue
            add(`${i < index ? '이전' : '이후'} 메시지 ${i + 1} (${msg.role})`, msg.data)
            scene.push(msg.data)
        }
        if (options.characterLorebook) {
            const lore = await matchLoreBuilderCharacterLorebook({
                character: contextCharacter, targetEntryId: '',
                userInstruction: instruction, draft: scene.join('\n\n'),
            })
            add('characterLorebook', lore.content)
            const links = (lore.entries ?? []).flatMap(entry => {
                const identityId = getPainterLoreIdentity(entry)
                return identityId && this.bot.identities.some(item => item.id === identityId)
                    ? [{ loreTitle: entry.comment || entry.key, loreKeys: entry.key, identityId }] : []
            })
            if (links.length) add('로어에 연결된 캐릭터 프리셋', JSON.stringify(links))
            this.loreIdentityIds = new Set(links.map(link => link.identityId))
        }
        if (options.wikiIds.length) {
            await this.loadWiki()
            if (this.state.error) throw new Error(this.state.error)
            for (const id of options.wikiIds) {
                const doc = this.state.wikiDocs.find((item) => item.id === id)
                if (!doc) throw new Error('선택한 위키 항목이 없습니다. 컨텍스트 설정에서 다시 선택해 주세요.')
                add(`바드위키: ${doc.title}`, doc.content)
            }
        }
        if (options.referenceAssetId) {
            const { loadPainterReference } = await import('./reference')
            const reference = await loadPainterReference(options.referenceAssetId, this.characterId)
            if (!reference) throw new Error('참고 그림의 생성 정보를 읽을 수 없습니다. 생성 설정에서 다른 그림을 선택하거나 해제해 주세요.')
            add('참고 삽화의 외형과 의상 (자세와 사건은 이어받지 않음)', reference)
        } else if (options.referenceId) {
            const reference = this.data.results.find((item) => item.id === options.referenceId)
            if (reference) add('참고 삽화의 외형과 의상 (자세와 사건은 이어받지 않음)', JSON.stringify(reference.draft.subjects.map(({ id, name, appearance, clothing }) => ({ id, name, appearance, clothing }))))
        }
        if (result.reduce((sum, item) => sum + item.content.length, 0) > 100_000) throw new Error('참고 자료가 너무 많습니다. 메시지 수나 위키 항목을 줄여 주세요.')
        return result
    }

    async prepare(anchor?: PainterAnchor, options: { instruction?: string; fresh?: boolean } = {}) {
        if (this.state.status !== 'idle') return
        if (anchor && (anchor.characterId !== this.characterId || anchor.chatId !== this.chatId)) return
        const previousAnchor = this.data.anchor ? clone(this.data.anchor) : undefined
        const previousDraft = this.data.draft ? clone(this.data.draft) : undefined
        const sameScene = !anchor || JSON.stringify(anchor) === JSON.stringify(previousAnchor)
        let prepared = false
        if (anchor) this.data.anchor = clone(anchor)
        if (!this.data.anchor) { this.state.error = '본문에서 그리고 싶은 부분을 선택해 주세요.'; return }
        const target = clone(this.data.anchor)
        const controller = new AbortController()
        this.controller = controller
        this.state.status = 'prompt'
        await this.action(async () => {
            this.loreIdentityIds = new Set()
            const sources = await this.context(target, options.instruction ?? this.settings.instruction)
            if (controller.signal.aborted) return
            this.state.sources = sources
            const settings = clone(this.settings)
            if (options.instruction !== undefined) settings.instruction = options.instruction
            const style = clone(this.style)
            const revising = sameScene && !options.fresh
            // A new scene or a rewrite starts only from the blocks the user added or locked.
            const seed = previousDraft && !revising ? {
                rendering: '', scene: '', negative: '',
                subjects: previousDraft.subjects.filter(item => item.manual || item.locked).map(item => item.locked ? item : { ...item, pose: '' }),
            } : previousDraft
            const draft = seed && (seed.scene.trim() || seed.subjects.length) ? seed : undefined
            const requestCharacter = { ...this.character, chatPage: this.character.chats.indexOf(this.chat) }
            const userName = resolvePersonaById(DBState.db, this.character, this.chat.bindedPersona)?.persona.name ?? DBState.db.username ?? 'User'
            const presets = clone(this.bot.identities)
            const outfitsFor = (identityId: string) => this.outfitsFor(identityId)
            const formated = buildPainterMessages({ anchor: target, settings, style, sources, userName,
                identities: presets, draft, fragments: previousDraft?.fragments,
                outfits: clone(presets.flatMap(identity => outfitsFor(identity.id))),
                conversation: revising ? clone((this.data.conversation ?? []).slice(-12)) : [] })
            const viewerNames = new Set([userName, '{{user}}', 'user', 'you', '당신'].map(name => name.trim().toLowerCase()).filter(Boolean))
            const plan = async (messages: ReturnType<typeof buildPainterRepairMessages>) => {
                const response = await requestChatData({ formated: messages, currentChar: requestCharacter, bias: {},
                    useStreaming: false, noMultiGen: true, tools: [], maxTokens: 8192, temperature: 0.3,
                    disablePromptCache: true, logSource: 'other', logPurpose: 'bard-painter' }, settings.modelSlot, controller.signal)
                const raw = response.type === 'success' && typeof response.result === 'string' ? response.result : ''
                if (response.type !== 'success') return { raw, error: new Error(response.type === 'fail' ? response.result : '프롬프트 응답 형식을 읽을 수 없습니다. 다시 작성해 주세요.') }
                try { return { raw, draft: parsePainterDraft(response.result, settings.perspective === 'first-person' ? viewerNames : undefined) } }
                catch (error) { return { raw, error: error instanceof Error ? error : new Error(String(error)) } }
            }
            let attempt = await plan(formated)
            if (controller.signal.aborted) return
            // Truncated, malformed or declined plans get one repair turn that keeps the rejected text in context.
            if (attempt.error) attempt = await plan(buildPainterRepairMessages(formated, attempt.raw, attempt.error.message))
            if (controller.signal.aborted) return
            if (!attempt.draft) throw attempt.error
            const next = attempt.draft
            const visibleSubjects = (subjects: typeof next.subjects) => settings.perspective === 'first-person'
                ? subjects.filter(subject => subject.kind !== 'character' || ![subject.name, ...subject.aliases].some(name => viewerNames.has(name.trim().toLowerCase())))
                : subjects
            // Reconciliation otherwise restores omitted locked blocks, including the viewer.
            const previousSubjects = visibleSubjects(draft?.subjects ?? [])
            next.subjects = applyPainterPresets(reconcilePainterSubjects(visibleSubjects(next.subjects), presets, previousSubjects),
                presets, outfitsFor, previousSubjects, this.loreIdentityIds)
            if (previousDraft?.fragments) next.fragments = clone(previousDraft.fragments)
            this.data.draft = next
            this.data.previousDraft = previousDraft?.scene.trim() ? previousDraft : undefined
            const planned = !!draft?.scene.trim()
            const history = revising ? this.data.conversation ?? [] : []
            this.data.conversation = [...history, { id: v4(), role: 'user' as const, text: settings.instruction.trim() || (planned ? '현재 초안을 다듬어 주세요.' : '선택한 장면의 프롬프트를 작성해 주세요.') },
                { id: v4(), role: 'assistant' as const, text: planned ? '요청을 반영해 초안을 수정했습니다.' : '선택한 장면의 초안을 작성했습니다. 원하는 방향을 더 알려 주세요.' }].slice(-12)
            prepared = true
            await persist()
            const unreflected = next.subjects.filter(subject => this.globalMatchFor(subject)).length
            this.state.notice = unreflected
                ? `프롬프트를 작성했습니다. 글로벌 캐릭터와 이름이 같은 인물 ${unreflected}명이 이 봇에 반영되지 않아 저장된 외형을 쓰지 못했습니다. 해당 블록에서 '봇에 반영'을 눌러 주세요.`
                : '프롬프트를 작성했습니다. 외형과 의상을 확인한 뒤 이미지를 생성하세요.'
        })
        if (!prepared && previousDraft && previousAnchor) {
            this.data.anchor = previousAnchor
            this.data.draft = previousDraft
        }
        if (this.controller === controller) { this.controller = null; this.state.status = 'idle' }
        return prepared && !this.state.error
    }
    async clearConversation(): Promise<boolean> {
        if (this.state.status !== 'idle' || this.state.pendingImage || !this.data.conversation?.length) return false
        this.state.status = 'saving'
        const success = await this.action(async () => {
            if (this.chat.isStreaming) throw new Error('메시지 작성이 끝난 뒤 대화를 비워 주세요.')
            const data = this.data, previous = data.conversation
            data.conversation = []
            try { await persist() }
            catch (cause) { data.conversation = previous; throw cause }
            this.state.notice = '프롬프트 대화를 비웠습니다. 초안과 생성한 삽화는 유지됩니다.'
        })
        this.state.status = 'idle'
        return success
    }
    async restoreDraft() {
        if (this.state.status !== 'idle' || !this.data.previousDraft) return
        this.state.status = 'saving'
        await this.action(async () => {
            const prior = { draft: this.data.draft ? clone(this.data.draft) : undefined, previousDraft: clone(this.data.previousDraft!), conversation: this.data.conversation ? clone(this.data.conversation) : undefined }
            this.data.draft = clone(this.data.previousDraft!)
            if (prior.draft?.fragments) this.data.draft.fragments = clone(prior.draft.fragments)
            else delete this.data.draft.fragments
            this.data.previousDraft = undefined
            this.data.conversation = [...(this.data.conversation ?? []), { id: v4(), role: 'assistant' as const, text: '이전 초안으로 되돌렸습니다.' }].slice(-12)
            try { await persist() }
            catch (cause) { Object.assign(this.data, prior); throw cause }
        })
        this.state.status = 'idle'
    }
    cancel() { if (this.state.status === 'prompt') { this.controller?.abort(); this.state.notice = '프롬프트 작성을 중지했습니다.' } }

    async generate() {
        if (this.state.status !== 'idle' || this.state.pendingImage) return
        if (!this.data.draft || !this.data.anchor) { this.state.error = '장면을 선택하고 프롬프트를 먼저 작성해 주세요.'; return }
        this.state.status = 'image'
        await this.action(async () => {
            if (!DBState.db.NAIApiKey?.trim()) throw new Error('설정의 이미지 생성에서 NovelAI API 키를 입력해 주세요.')
            const result: PainterResult = {
                id: v4(), assetId: v4(), createdAt: Date.now(), anchor: clone(this.data.anchor!),
                // Record the canvas actually requested so saved results and retries keep the AI choice.
                draft: clone(this.data.draft!), style: clone(this.style), settings: { ...clone(this.settings), ...painterImageSize(this.settings, this.data.draft) },
                seed: this.settings.seed ?? crypto.getRandomValues(new Uint32Array(1))[0], compressionPending: true,
            }
            const request = buildPainterImageRequest(result.draft, result.style, result.settings, result.seed)
            const response = await globalFetch(DBState.db.NAIImgUrl || 'https://image.novelai.net/ai/generate-image', {
                body: request, headers: { Authorization: `Bearer ${DBState.db.NAIApiKey}`, 'Content-Type': 'application/json' },
                rawResponse: true, logCategory: 'image', logSource: 'image', requestTimeoutMs: 180_000,
            })
            if (!response.ok) throw new Error(`이미지 생성 실패 (${response.status}): ${typeof response.data === 'string' ? response.data.slice(0, 500) : new TextDecoder().decode(response.data).slice(0, 500)}`)
            const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => unzip(new Uint8Array(response.data), (error, data) => error ? reject(error) : resolve(data)))
            const png = Object.entries(files).find(([name]) => /\.png$/i.test(name))?.[1]
            if (!png?.length) throw new Error('생성 응답에서 PNG 이미지를 찾지 못했습니다.')
            this.pending = { png, result }; this.state.pendingImage = true
            await this.finishSave()
        })
        this.state.status = 'idle'
    }

    private async finishSave() {
        this.state.status = 'saving'
        if (!this.pending) {
            const result = this.data.results.find((item) => item.compressionPending)
            if (!result) return
            const stored = await getInlayAssetBlob(result.assetId)
            if (!stored) throw new Error('저장된 생성 원본을 찾을 수 없습니다.')
            this.pending = { png: new Uint8Array(await stored.data.arrayBuffer()), result: clone(result) }
        }
        const pending = this.pending
        const { png, result } = pending
        const owner = { charId: this.characterId, chatId: this.chatId }
        const { compressPainterImage } = await import('./image')
        const request = buildPainterImageRequest(result.draft, result.style, result.settings, result.seed)
        // A WebP write may have succeeded before its metadata transaction failed.
        const isWebP = new TextDecoder().decode(png.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(png.subarray(8, 12)) === 'WEBP'
        const compressed = pending.compressed ??= isWebP
            ? { data: png, width: result.settings.width, height: result.settings.height, mime: 'image/webp' }
            : await compressPainterImage(png, request as unknown as Record<string, unknown>)
        // Only the converted image is persisted. Retain completed work for save retries.
        if (!pending.assetSaved) {
            await setInlayAsset(result.assetId, {
                name: `바드페인터-${result.id}.webp`, data: new Blob([new Uint8Array(compressed.data)], { type: compressed.mime }),
                ext: 'webp', type: 'image', width: compressed.width, height: compressed.height,
            }, owner)
            pending.assetSaved = true
        }
        if (!this.data.results.some((item) => item.id === result.id)) this.data.results.unshift(clone(result))
        const saved = this.data.results.find((item) => item.id === result.id)!
        saved.compressionPending = false
        try { await savePainterGalleryRecord(saved, this.chat.name ?? ''); await persist() }
        catch (cause) { saved.compressionPending = true; throw cause }
        this.pending = null; this.state.pendingImage = this.data.results.some((item) => item.compressionPending)
        this.state.notice = '그림을 저장했습니다. 선택한 원문 위나 아래에 삽입할 수 있습니다.'
    }
    async retrySave() {
        if (this.state.status !== 'idle') return
        await this.action(() => this.finishSave())
        this.state.status = 'idle'
    }
    async discardPending() {
        if (this.state.status !== 'idle') return
        this.state.status = 'saving'
        await this.action(async () => {
            const previous = this.data.results
            this.data.results = previous.filter((item) => !item.compressionPending)
            try { await persist() } catch (cause) { this.data.results = previous; throw cause }
            // Retain any written asset in the image library; only forget the interrupted jobs.
            this.pending = null; this.state.pendingImage = false
            this.state.notice = '저장 대기를 해제했습니다. 이미 저장된 원본 파일은 이미지 보관함에 남아 있습니다.'
        })
        this.state.status = 'idle'
    }
    async downloadOriginal() {
        await this.action(async () => {
            const pending = this.pending
            const result = this.data.results.find((item) => item.compressionPending)
            const stored = !pending && result ? await getInlayAssetBlob(result.assetId) : null
            const blob = pending ? new Blob([new Uint8Array(pending.png)], { type: 'image/png' }) : stored?.data
            if (!blob) throw new Error('내려받을 생성 원본이 없습니다.')
            await downloadFile('bard-painter-original.png', await blob.arrayBuffer())
        })
    }

    async insert(resultId: string, side: 'before' | 'after', target?: PainterAnchor) {
        if (this.state.status !== 'idle') return false
        this.state.status = 'saving'
        const success = await this.action(async () => {
            const result = this.data.results.find((item) => item.id === resultId)
            if (!result) throw new Error('삽입할 그림이 없습니다. 그림을 다시 선택해 주세요.')
            const anchor = target ?? result.anchor
            if (result.compressionPending) throw new Error('이미지 압축과 저장을 먼저 완료해 주세요.')
            if (anchor.chatId !== this.chatId || anchor.characterId !== this.characterId) throw new Error('현재 챗에서 삽입할 위치를 선택해 주세요.')
            if (this.chat.isStreaming) throw new Error('메시지 작성이 끝난 뒤 삽입해 주세요.')
            const index = this.chat.message.findIndex((item) => item.chatId === anchor.messageId)
            if (index < 0) throw new Error('원래 메시지가 삭제되어 삽입할 수 없습니다.')
            const message = this.chat.message[index]
            const capturedSelection = get(painterSelection)
            const prior = { text: message.data, swipes: message.swipes ? [...message.swipes] : undefined, painter: clone(this.data) }
            const position = anchor.insertionUnavailable ? { start: 0, end: message.data.length } : anchor
            const inserted = insertPainterReference(message.data, position, result.assetId, side)
            message.data = inserted.text
            if (message.swipes && message.swipeId !== undefined) message.swipes[message.swipeId] = inserted.text
            result.inserted = side
            for (const item of this.data.results) if (item.anchor.messageId === anchor.messageId) item.anchor = shiftPainterAnchor(item.anchor, inserted.position, inserted.length)
            if (this.data.anchor?.messageId === anchor.messageId) this.data.anchor = shiftPainterAnchor(this.data.anchor, inserted.position, inserted.length)
            try { await persist() } catch (cause) {
                message.data = prior.text; message.swipes = prior.swipes; this.chat.bardPainter = prior.painter
                throw cause
            }
            ReloadChatPointer.update((value) => { value[index] = (value[index] ?? 0) + 1; return value })
            painterSelection.update(value => value === capturedSelection && value?.anchor?.characterId === this.characterId && value.anchor.chatId === this.chatId && value.anchor.messageId === anchor.messageId
                ? { ...value, anchor: shiftPainterAnchor(value.anchor, inserted.position, inserted.length) } : value)
            this.state.notice = side === 'before' ? '선택한 원문 위에 삽입했습니다.' : '선택한 원문 아래에 삽입했습니다.'
        })
        this.state.status = 'idle'
        return success
    }

    async saveOutfit(subjectId: string, name: string, includeState: boolean) {
        return this.presetAction('현재 챗의 인물 의상으로 저장했습니다.', write => {
            const subject = this.data.draft?.subjects.find((item) => item.id === subjectId)
            if (!subject) throw new Error('의상을 저장할 인물을 선택해 주세요.')
            const outfit = capturePainterOutfit(subject, name, includeState)
            uniquePresetName(outfit.name, this.data.outfits.filter(item => item.subjectId === subjectId), outfit.id)
            if (!this.bot.identities.some(item => item.id === subject.id)) {
                uniquePresetName(subject.name, this.bot.identities, subject.id)
                write(this.bot, 'identities', [...this.bot.identities, { id: subject.id, name: subject.name.trim(), aliases: [...subject.aliases], appearance: '' }])
            }
            write(this.data, 'outfits', [...this.data.outfits, outfit])
            return outfit.id
        })
    }
    async promoteOutfit(id: string) {
        const outfit = this.data.outfits.find(item => item.id === id)
        if (!outfit) return
        const saved = await this.saveOutfitPreset(promotePainterOutfit(outfit), true)
        if (saved) this.state.notice = '같은 봇의 다른 챗에서도 사용할 수 있도록 복사했습니다.'
        return saved
    }
    async applyOutfit(subjectId: string, id: string) {
        return this.presetAction('초안에 의상을 불러왔습니다.', write => {
            const subject = this.data.draft?.subjects.find((item) => item.id === subjectId)
            const outfit = this.outfitChoices(subjectId).find(item => item.id === id)
            if (!subject || !outfit) return
            const updated: PainterSubject = { ...clone(subject), clothing: outfit.clothing, state: outfit.state, outfitId: outfit.id }
            delete updated.outfitEdited
            write(this.data.draft!, 'subjects', this.data.draft!.subjects.map(item => item.id === subjectId ? updated : item))
            return true
        }, false, true)
    }
    async removeOutfit(id: string, shared: boolean, global = false) {
        return (await this.presetAction('의상 프리셋을 삭제했습니다.', write => {
            const owner = global ? this.globalLibrary : shared ? this.bot : this.data
            if (!owner.outfits.some(item => item.id === id)) return
            write(owner, 'outfits', owner.outfits.filter(item => item.id !== id))
            if (global || shared) {
                const library = global ? this.globalLibrary : this.bot
                write(library, 'identities', library.identities.map(item => {
                    const next = { ...item }
                    if (next.outfitIds) next.outfitIds = next.outfitIds.filter(value => value !== id)
                    if (next.defaultOutfitId === id) delete next.defaultOutfitId
                    return next
                }))
            }
            return true
        })) === true
    }
    async saveOutfitPreset(outfit: PainterOutfit, shared: boolean, asNew = false, global = false): Promise<string | undefined> {
        return this.presetAction('의상 프리셋을 저장했습니다.', write => {
            const library = global ? this.globalLibrary : this.bot
            if (outfit.subjectId && !library.identities.some(item => item.id === outfit.subjectId)) throw new Error('의상을 저장할 인물을 먼저 등록해 주세요.')
            if (!outfit.subjectId && !shared && !global) throw new Error('공용 의상은 봇 공용 또는 글로벌에 저장해 주세요.')
            if (!outfit.clothing.trim()) throw new Error('의상 프롬프트를 입력해 주세요.')
            const owner = global ? this.libraryForWrite(true, write) : shared ? this.bot : this.data
            const otherOwner = shared ? this.data : this.bot
            const copyingScope = !global && !owner.outfits.some(item => item.id === outfit.id) && otherOwner.outfits.some(item => item.id === outfit.id)
            const custom = { ...clone(outfit), id: asNew || !outfit.id || copyingScope ? v4() : outfit.id, name: outfit.name.trim() }
            if (global || !shared || copyingScope || (asNew && outfit.id) || outfit.attachToCard !== true) delete custom.attachToCard
            const index = owner.outfits.findIndex(item => item.id === custom.id)
            if (index >= 0 && owner.outfits[index].subjectId !== custom.subjectId) throw new Error('다른 인물의 의상을 덮어쓸 수 없습니다.')
            uniquePresetName(custom.name, owner.outfits.filter(item => item.subjectId === custom.subjectId), custom.id)
            write(owner, 'outfits', index < 0 ? [...owner.outfits, custom] : owner.outfits.map((item, position) => position === index ? custom : item))
            return custom.id
        })
    }
    async moveOutfit(id: string, shared: boolean, direction: -1 | 1, global = false): Promise<boolean> {
        return (await this.presetAction('의상 순서를 변경했습니다.', write => {
            const owner = global ? this.globalLibrary : shared ? this.bot : this.data
            const subjectId = owner.outfits.find(item => item.id === id)?.subjectId
            const next = movedPreset(owner.outfits, id, direction, item => item.subjectId === subjectId)
            if (!next) return
            write(owner, 'outfits', next)
            return true
        })) === true
    }
    async setAllCardAttachments(attached: boolean): Promise<boolean> {
        return (await this.presetAction(attached ? '모든 외형과 봇 공용 의상을 카드 첨부로 저장했습니다.' : '모든 카드 첨부를 해제했습니다.', write => {
            const update = <T extends { attachToCard?: boolean }>(item: T): T => {
                const next = { ...item }
                if (attached) next.attachToCard = true
                else delete next.attachToCard
                return next
            }
            write(this.bot, 'identities', this.bot.identities.map(update))
            write(this.bot, 'outfits', this.bot.outfits.map(update))
            if (this.bot.globalOutfits) write(this.bot, 'globalOutfits', this.bot.globalOutfits.map(update))
            return true
        })) === true
    }
    /** Save a block's look as this bot's character, filling a same-named blank entry instead of failing on its name. */
    async rememberIdentity(subjectId: string) {
        const subject = this.data.draft?.subjects.find(item => item.id === subjectId)
        if (!subject) return
        const target = this.bot.identities.find(item => item.id === subject.id)
            ?? this.bot.identities.find(item => !item.appearance.trim() && painterNameKey(item.name) === painterNameKey(subject.name))
        const id = await this.saveIdentity({ ...(target ? clone(target) : {}), id: target?.id ?? subject.id, name: subject.name, aliases: [...new Set([...(target?.aliases ?? []), ...subject.aliases])], appearance: subject.appearance })
        const saved = id && !this.data.draft?.subjects.some(item => item !== subject && item.id === id) && this.data.draft?.subjects.find(item => item === subject)
        if (saved) {
            saved.id = id; saved.presetMatch = 'manual'
            delete saved.appearanceEdited
            await this.persist()
            this.state.notice = '인물의 이름과 외형을 이 봇의 캐릭터 프리셋으로 저장했습니다.'
        }
        return id
    }
    async saveIdentity(identity: PainterIdentity, asNew = false, global = false): Promise<string | undefined> {
        return this.presetAction('인물의 이름과 외형을 저장했습니다.', write => {
            const library = global ? this.libraryForWrite(true, write) : this.bot
            const previous = !asNew ? library.identities.find(item => item.id === identity.id) : undefined
            const outfitIds = identity.outfitIds ?? previous?.outfitIds
            const defaultOutfitId = identity.defaultOutfitId ?? previous?.defaultOutfitId
            const note = (identity.note ?? previous?.note ?? '').trim()
            const custom: PainterIdentity = { id: asNew || !identity.id ? v4() : identity.id, name: identity.name.trim(),
                aliases: [...new Set(identity.aliases.map(alias => alias.trim()).filter(Boolean))], appearance: identity.appearance,
                ...(note ? { note } : {}),
                ...(!asNew && previous?.sourceId ? { sourceId: previous.sourceId } : {}),
                ...(outfitIds ? { outfitIds: [...new Set(outfitIds)] } : {}),
                ...(defaultOutfitId ? { defaultOutfitId } : {}),
                ...(!global && identity.attachToCard === true && !(asNew && identity.id) ? { attachToCard: true } : {}) }
            const known = global ? library.outfits : [...library.outfits, ...this.globalLibrary.outfits.filter(item => !item.subjectId)]
            if (custom.outfitIds?.some(id => !previous?.outfitIds?.includes(id) && !known.some(item => item.id === id && (!item.subjectId || item.subjectId === custom.id)))
                || (custom.defaultOutfitId && custom.defaultOutfitId !== previous?.defaultOutfitId && !outfitsForIdentity({ outfits: known, identities: [custom] }, custom.id).some(item => item.id === custom.defaultOutfitId))) {
                throw new Error('캐릭터의 의상 목록을 다시 선택해 주세요.')
            }
            uniquePresetName(custom.name, library.identities, custom.id)
            const index = library.identities.findIndex(item => item.id === custom.id)
            write(library, 'identities', index < 0 ? [...library.identities, custom] : library.identities.map((item, position) => position === index ? custom : item))
            return custom.id
        })
    }
    async removeIdentity(id: string, global = false): Promise<boolean> {
        return (await this.presetAction('인물과 이 인물에 속한 의상 프리셋을 삭제했습니다.', async write => {
            const library = global ? this.globalLibrary : this.bot
            if (!library.identities.some(item => item.id === id)) return
            if (global) {
                write(library, 'identities', library.identities.filter(item => item.id !== id))
                write(library, 'outfits', library.outfits.filter(item => item.subjectId !== id))
                return true
            }
            const character = this.character
            const chatIds = character.chats.map(chat => chat.id)
            for (const chatId of chatIds) {
                const index = character.chats.findIndex(chat => chat.id === chatId)
                if (index < 0) throw new Error('챗 목록이 바뀌었습니다. 다시 시도해 주세요.')
                const hydrated = await ensureChatHydrated(character.chats, index, character.chaId)
                if (!hydrated || hydrated._placeholder || !Array.isArray(hydrated.message)) throw new Error('챗의 의상 프리셋을 읽지 못했습니다. 다시 시도해 주세요.')
            }
            if (this.character !== character || character.chats.length !== chatIds.length || character.chats.some(chat => !chatIds.includes(chat.id))) throw new Error('챗 목록이 바뀌었습니다. 다시 시도해 주세요.')
            this.assertPresetReady()
            write(this.bot, 'identities', this.bot.identities.filter(item => item.id !== id))
            write(this.bot, 'outfits', this.bot.outfits.filter(item => item.subjectId !== id))
            write(character, 'globalLore', (character.globalLore ?? []).map(entry => getPainterLoreIdentity(entry) === id ? withPainterLoreIdentity(entry) : entry))
            for (const chat of character.chats) if (chat.bardPainter) write(chat.bardPainter, 'outfits', chat.bardPainter.outfits.filter(item => item.subjectId !== id))
            return true
        })) === true
    }
    async moveIdentity(id: string, direction: -1 | 1, global = false): Promise<boolean> {
        return (await this.presetAction('인물 순서를 변경했습니다.', write => {
            const library = global ? this.globalLibrary : this.bot
            const next = movedPreset(library.identities, id, direction)
            if (!next) return
            write(library, 'identities', next)
            return true
        })) === true
    }
    async saveFragment(fragment: PainterFragment, asNew = false): Promise<string | undefined> {
        return this.presetAction('표현 조각을 저장했습니다.', write => {
            const custom = { id: asNew || !fragment.id ? v4() : fragment.id, name: fragment.name.trim(), prompt: fragment.prompt }
            uniquePresetName(custom.name, this.fragments, custom.id)
            if (!custom.prompt.trim()) throw new Error('표현 조각의 프롬프트를 입력해 주세요.')
            const existing = this.fragments
            write(DBState.db, 'bardPainterFragments', existing.some(item => item.id === custom.id)
                ? existing.map(item => item.id === custom.id ? custom : item) : [...existing, custom])
            return custom.id
        })
    }
    async removeFragment(id: string): Promise<boolean> {
        return (await this.presetAction('표현 조각을 삭제했습니다.', write => {
            if (!this.fragments.some(item => item.id === id)) return
            write(DBState.db, 'bardPainterFragments', this.fragments.filter(item => item.id !== id))
            return true
        })) === true
    }
    async addFragment(id: string): Promise<boolean> {
        return (await this.presetAction('현재 초안에 표현 조각을 추가했습니다.', write => {
            const fragment = this.fragments.find(item => item.id === id)
            if (!fragment || !this.data.draft) return
            write(this.data.draft, 'fragments', [...(this.data.draft.fragments ?? []), { ...clone(fragment), id: v4() }])
            return true
        })) === true
    }
    async setDefaultStyle(id: string): Promise<boolean> {
        return (await this.presetAction('새 작업에 사용할 기본 화풍을 지정했습니다.', write => {
            if (!this.styles.some(item => item.id === id)) return
            write(DBState.db, 'bardPainterDefaultStyleId', id)
            return true
        }, true)) === true
    }
    async saveStyle(style: PainterStyle, asNew = false): Promise<string | undefined> {
        return this.presetAction('화풍 프리셋을 저장했습니다.', write => {
            const custom = { ...clone(style), id: asNew || !style.id || PAINTER_STYLES.some(item => item.id === style.id) ? v4() : style.id, name: style.name.trim() }
            uniquePresetName(custom.name, this.styles, custom.id)
            const draft = { rendering: '', scene: 'landscape', negative: '', subjects: [] }
            buildPainterImageRequest(draft, custom, this.settings, 1)
            const existing = DBState.db.bardPainterStyles ?? []
            const index = existing.findIndex(item => item.id === custom.id)
            write(DBState.db, 'bardPainterStyles', index < 0 ? [...existing, custom] : existing.map((item, position) => position === index ? custom : item))
            write(this.data.settings, 'styleId', custom.id)
            return custom.id
        }, true)
    }
    async removeStyle(id: string): Promise<boolean> {
        return (await this.presetAction('화풍 프리셋을 삭제했습니다.', write => {
            if (PAINTER_STYLES.some(item => item.id === id) || !DBState.db.bardPainterStyles?.some(item => item.id === id)) return
            write(DBState.db, 'bardPainterStyles', DBState.db.bardPainterStyles.filter(item => item.id !== id))
            if (DBState.db.bardPainterDefaultStyleId === id) write(DBState.db, 'bardPainterDefaultStyleId', PAINTER_STYLES[0].id)
            for (const character of DBState.db.characters) for (const chat of character.chats) {
                if (!chat._placeholder && chat.bardPainter?.settings.styleId === id) write(chat.bardPainter.settings, 'styleId', this.defaultStyle.id)
            }
            return true
        }, true)) === true
    }
    async moveStyle(id: string, direction: -1 | 1): Promise<boolean> {
        return (await this.presetAction('화풍 순서를 변경했습니다.', write => {
            const next = movedPreset(DBState.db.bardPainterStyles ?? [], id, direction)
            if (!next) return
            write(DBState.db, 'bardPainterStyles', next)
            return true
        }, true)) === true
    }
    async removeResult(id: string) {
        await this.action(async () => {
            if (this.data.results.find((item) => item.id === id)?.compressionPending) throw new Error('생성 원본을 보호하기 위해 저장을 먼저 완료해 주세요.')
            this.data.results = this.data.results.filter((item) => item.id !== id)
            await persist(); this.state.notice = '삽화 목록에서 제거했습니다. 이미지 파일은 이미지 보관함에 남아 있습니다.'
        })
    }
}

const sessions = new Map<string, PainterSession>()
const autoPruned = new Set<string>()
export function isPainterChatBusy(characterId: string, chatId: string): boolean {
    const session = sessions.get(`${characterId}\u0000${chatId}`)
    return !!session && (session.state.status !== 'idle' || session.state.pendingImage)
}
export function getPainterSession(characterId: string, chatId: string): PainterSession {
    const key = `${characterId}\u0000${chatId}`
    let session = sessions.get(key)
    if (!session) { session = new PainterSession(characterId, chatId); sessions.set(key, session) }
    return session
}
