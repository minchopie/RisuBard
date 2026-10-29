import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { character } from './storage/database.svelte'

const state = vi.hoisted(() => ({
    events: [] as string[],
    alerts: [] as Array<{ type: string; msg: string; submsg?: string }>,
    doneCalls: 0,
    completion: Promise.resolve(),
    requestImmediateSave: vi.fn(),
    cardPayload: undefined as unknown,
    db: {
        statics: { imports: 0 },
        characters: [],
        modules: [],
        characterOrder: [],
    },
}))

vi.mock('./alert', () => ({
    alertCardExport: vi.fn(),
    alertConfirm: vi.fn(),
    alertConfirmMulti: vi.fn(async () => 0),
    alertError: vi.fn(() => state.events.push('error')),
    alertInput: vi.fn(),
    alertStore: { set: vi.fn((value) => state.alerts.push(value)) },
    alertTOS: vi.fn(),
    alertWait: vi.fn((msg) => state.alerts.push({ type: 'wait', msg })),
    notifyError: vi.fn(),
    notifySuccess: vi.fn(() => state.events.push('notified')),
}))

vi.mock('./storage/database.svelte', () => ({
    appVer: 'test',
    defaultSdDataFunc: () => ({}),
    getDatabase: () => state.db,
    importPreset: vi.fn(),
    newChatModelDefaults: () => ({}),
    setDatabase: vi.fn(),
    setDatabaseLite: vi.fn(),
}))

vi.mock('./charxPreflight', async (original) => ({ ...await original<typeof import('./charxPreflight')>(), inspectCharx: vi.fn(async () => ({ bytes: 1, assets: 0 })) }))

vi.mock('./process/processzip', () => ({
    CharXImporter: class {
        alertInfo = false
        assets = {}
        cardData: string | undefined
        moduleData: Uint8Array | undefined

        constructor(private readonly progress?: (event: any) => void) {}

        async parse() {
            this.progress?.({ phase: 'reading', completed: 5, total: 10 })
            this.progress?.({ phase: 'extracting', completed: 2, total: 3 })
            this.progress?.({ phase: 'preparing-assets', completed: 3, total: 5 })
            this.progress?.({ phase: 'saving-assets', completed: 5, total: 5 })
            state.completion = new Promise<void>((resolve) => {
                setTimeout(() => {
                    this.cardData = JSON.stringify(state.cardPayload ?? { spec: 'not-v3', data: {} })
                    state.events.push('assets-5/5')
                    resolve()
                }, 0)
            })
        }

        async done() {
            state.doneCalls += 1
            await state.completion
        }
    },
    CharXSkippableChecker: vi.fn(),
    CharXWriter: class {},
}))

vi.mock('./globalApi.svelte', () => ({
    AppendableBuffer: class {},
    BlankWriter: class {},
    LocalWriter: class {},
    VirtualWriter: class {},
    checkCharOrder: vi.fn(),
    downloadFile: vi.fn(),
    forageStorage: { keys: vi.fn(async () => []), cleanupImportAssets: vi.fn(async () => {}), prepareImportRollback: vi.fn(async () => {}), observeImportProgress: vi.fn(async () => () => {}) },
    loadAsset: vi.fn(),
    readImage: vi.fn(),
    requestImmediateSave: state.requestImmediateSave,
    saveAsset: vi.fn(),
}))

vi.mock('./process/modules', () => ({
    exportModuleLegacy: vi.fn(),
    readModule: vi.fn(),
    prepareImportedModule: vi.fn(),
    installImportedModule: vi.fn(async (module: any) => { state.db.modules.push(module) }),
}))

vi.mock('./stores.svelte', () => ({ selectedCharID: { set: vi.fn() } }))
vi.mock('./routing', () => ({ openSettings: vi.fn(), SettingsRoute: {} }))
vi.mock('./media', () => ({ compressImage: vi.fn(), getImageType: vi.fn() }))
vi.mock('./parser/parser.svelte', () => ({ hasher: vi.fn(), risuChatParser: vi.fn() }))
vi.mock('./process/files/inlays', () => ({ reencodeImage: vi.fn() }))
vi.mock('./characterVault', () => ({ pinCharacterVaultQuickAccess: vi.fn() }))
vi.mock('./characters', () => ({ characterFormatUpdate: vi.fn() }))
vi.mock('./characterUpdateFlow.svelte', () => ({ tryUpdateExistingCharacter: vi.fn(async () => null) }))
vi.mock('src/lang', async () => ({
    language: {
        importInstall: (await import('src/lang/en')).languageEnglish.importInstall,
        errors: { noData: 'invalid-data' },
        importedCharacter: 'imported',
        characterImportFailed: 'Import failed',
        characterImportReadingBytes: (done: string, total: string) => `읽기 ${done}/${total}`,
        characterImportExtracting: (done: number, total: number) => `압축 ${done}/${total}`,
        characterImportPreparingAssets: (done: number, total: number) => `준비 ${done}/${total}`,
        characterImportSavingAssets: (done: number, total: number) => `저장 ${done}/${total}`,
        characterImportReadingMetadata: '메타데이터 읽기',
        characterImportApplying: '캐릭터 적용',
    },
}))

import { createBaseV2, createBaseV3, downloadRisuHub, importCharacterProcess } from './characterCards'
import { inspectCharx } from './charxPreflight'
import { alertConfirmMulti, alertError } from './alert'
import { selectedCharID } from './stores.svelte'
import { createBardLoreSettings, fingerprintLegacyLore, upgradeLegacyLorebook } from './lorebook/bardLore'
import { tryUpdateExistingCharacter } from './characterUpdateFlow.svelte'
import { BOT_LINEAGE_KEY } from './characterUpdate'

beforeEach(() => {
    state.cardPayload = undefined
    state.db.modules = []
    state.events = []
    state.requestImmediateSave.mockReset()
    state.requestImmediateSave.mockImplementation(async () => {
        state.events.push('saved')
    })
})

describe('CHARX install routing', () => {
    beforeEach(() => {
        state.db.characters = []
        state.doneCalls = 0
        state.cardPayload = cardFixture('chara_card_v3', undefined)
        vi.mocked(inspectCharx).mockResolvedValue({ bytes: 1, assets: 0 })
        vi.mocked(alertConfirmMulti).mockClear()
    })
    test('automatically registers a .MODULE.CHARX as a module', async () => {
        await importCharacterProcess({ name: 'pack.MODULE.CHARX', data: new Uint8Array() })
        expect(state.db.characters).toHaveLength(0)
        expect(state.db.modules).toHaveLength(1)
        expect(alertConfirmMulti).not.toHaveBeenCalled()
    })
    test.each([0, 1])('uses selected installation type %s for an asset-heavy archive', async choice => {
        vi.mocked(inspectCharx).mockResolvedValue({ bytes: 1, assets: 5000 })
        vi.mocked(alertConfirmMulti).mockResolvedValueOnce(choice)
        await importCharacterProcess({ name: 'pack.charx', data: new Uint8Array() })
        expect(state.db.modules).toHaveLength(choice === 0 ? 1 : 0)
        expect(state.db.characters).toHaveLength(choice === 1 ? 1 : 0)
    })
    test('cancels at classification without extracting or saving anything', async () => {
        vi.mocked(inspectCharx).mockResolvedValue({ bytes: 150_000_000, assets: 1 })
        vi.mocked(alertConfirmMulti).mockResolvedValueOnce(-1)
        await importCharacterProcess({ name: 'pack.charx', data: new Uint8Array() })
        expect(state.doneCalls).toBe(0)
        expect(state.requestImmediateSave).not.toHaveBeenCalled()
        expect(state.db.characters).toHaveLength(0)
        expect(state.db.modules).toHaveLength(0)
    })
})

describe('Realm installation results', () => {
    const originalFetch = globalThis.fetch
    beforeEach(() => {
        state.db.characters = [{ chaId: 'existing', name: 'Existing character' }] as any
        state.db.modules = []
        state.cardPayload = cardFixture('chara_card_v3', undefined)
        vi.mocked(inspectCharx).mockResolvedValue({ bytes: 150_000_000, assets: 1 })
        vi.mocked(selectedCharID.set).mockClear()
        vi.mocked(alertError).mockClear()
        globalThis.fetch = vi.fn(async () => new Response(new Uint8Array(), {
            headers: { 'content-type': 'application/charx' },
        }))
    })
    afterEach(() => { globalThis.fetch = originalFetch })

    test('does not change character selection when installation is cancelled', async () => {
        vi.mocked(alertConfirmMulti).mockResolvedValueOnce(-1)
        await downloadRisuHub('test', { forceRedirect: true })
        expect(state.db.characters).toHaveLength(1)
        expect(selectedCharID.set).not.toHaveBeenCalled()
    })
    test('does not select an unrelated character after installing a module', async () => {
        vi.mocked(alertConfirmMulti).mockResolvedValueOnce(0)
        await downloadRisuHub('test', { forceRedirect: true })
        expect(state.db.modules).toHaveLength(1)
        expect(state.db.characters).toHaveLength(1)
        expect(selectedCharID.set).not.toHaveBeenCalled()
    })
    test('selects the character actually installed', async () => {
        vi.mocked(alertConfirmMulti).mockResolvedValueOnce(1)
        await downloadRisuHub('test', { forceRedirect: true })
        expect(state.db.characters).toHaveLength(2)
        expect(selectedCharID.set).toHaveBeenCalledWith(1)
    })
    test('records the RisuRealm id on a downloaded CHARX so the next download can update it', async () => {
        vi.mocked(alertConfirmMulti).mockResolvedValueOnce(1)
        vi.mocked(tryUpdateExistingCharacter).mockClear()
        await downloadRisuHub('realm-item', { forceRedirect: true })
        expect(vi.mocked(tryUpdateExistingCharacter).mock.calls[0][0].extentions).toMatchObject({ risuRealmImportId: 'realm-item' })
    })
    test('selects the updated bot instead of adding one when the user updates an installed bot', async () => {
        vi.mocked(alertConfirmMulti).mockResolvedValueOnce(1)
        vi.mocked(tryUpdateExistingCharacter).mockResolvedValueOnce(0)
        await downloadRisuHub('test', { forceRedirect: true })
        expect(state.db.characters).toHaveLength(1)
        expect(selectedCharID.set).toHaveBeenCalledWith(0)
    })
    test('preserves the original import error and stack for the error dialog', async () => {
        const error = new Error('Invalid CHARX ZIP entry')
        vi.mocked(inspectCharx).mockRejectedValueOnce(error)
        await downloadRisuHub('test', { forceRedirect: true })
        expect(alertError).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining(error.message), stack: error.stack,
        }))
    })
})

function cardFixture(spec: 'chara_card_v2'|'chara_card_v3', risuai: Record<string, unknown>|undefined, postHistory = 'legacy card global note') {
    return {
        spec,
        spec_version: spec === 'chara_card_v2' ? '2.0' : '3.0',
        data: {
            name: 'Legacy card', description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
            creator_notes: '', system_prompt: '', post_history_instructions: postHistory,
            alternate_greetings: [], tags: [], creator: '', character_version: '',
            extensions: risuai === undefined ? {} : { risuai },
        },
    }
}

async function importFixture(card: ReturnType<typeof cardFixture>) {
    state.db.characters = []
    await importCharacterProcess({
        name: 'fixture.json',
        data: Buffer.from(JSON.stringify(card)),
    })
    return state.db.characters[0]
}

describe('CharX import completion', () => {
    beforeEach(() => {
        state.events = []
        state.alerts = []
        state.doneCalls = 0
        state.completion = Promise.resolve()
        state.db.statics.imports = 0
    })

    test('waits for delayed archive completion before validating card metadata', async () => {
        await expect(importCharacterProcess({
            name: 'realm.charx',
            data: new Uint8Array(),
        })).rejects.toThrow('invalid-data')
        await state.completion

        expect(state.doneCalls).toBe(1)
        expect(state.events).toEqual(['assets-5/5'])
        expect(state.alerts.map((alert) => alert.msg)).toEqual(expect.arrayContaining([
            '읽기 5 B/10 B',
            '압축 2/3',
            '준비 3/5',
            '저장 5/5',
            '메타데이터 읽기',
        ]))
    })
})

describe('character import localization', () => {
    test('does not ship hard-coded English loading or import error messages', () => {
        const source = readFileSync('src/ts/characterCards.ts', 'utf8')
        expect(source).not.toMatch(/Loading\.\.\. \((Reading|Loading Emotions|Loading Assets|Assets)\)/)
        expect(source).not.toContain('alertError("Error while importing")')
    })
})

describe('bot updates on import', () => {
    test('returns the updated bot from a card import without adding a new one', async () => {
        state.db.characters = [{ chaId: 'installed', name: 'Legacy card' }] as any
        vi.mocked(tryUpdateExistingCharacter).mockResolvedValueOnce(0)
        const index = await importCharacterProcess({ name: 'card.json', data: Buffer.from(JSON.stringify(cardFixture('chara_card_v3', undefined))) })
        expect(index).toBe(0)
        expect(state.db.characters).toHaveLength(1)
    })
    test('exports a stable bot id that a later import carries', async () => {
        const card = createBaseV3({ name: 'Lineage', chaId: 'origin', globalLore: [], loreExt: {} } as any)
        expect((card.data.extensions as any)[BOT_LINEAGE_KEY]).toBe('origin')
        const imported = await importFixture(card as any)
        expect(imported.extentions[BOT_LINEAGE_KEY]).toBe('origin')
        expect((createBaseV3(imported).data.extensions as any)[BOT_LINEAGE_KEY]).toBe('origin')
    })
})

describe('character import display names', () => {
    test('adds a numeric suffix when an imported character name already exists', async () => {
        const first = cardFixture('chara_card_v3', undefined)
        const second = cardFixture('chara_card_v3', undefined)
        second.data.name = 'legacy card'

        state.db.characters = []
        await importCharacterProcess({ name: 'first.json', data: Buffer.from(JSON.stringify(first)) })
        await importCharacterProcess({ name: 'second.json', data: Buffer.from(JSON.stringify(second)) })

        expect(state.db.characters.map((character: any) => character.name)).toEqual([
            'Legacy card', 'legacy card (2)',
        ])
    })
})

describe('legacy character-card replace-global-note compatibility', () => {
    test('persists an imported card before reporting success', async () => {
        await importFixture(cardFixture('chara_card_v3', undefined))

        expect(state.requestImmediateSave).toHaveBeenCalledWith(expect.objectContaining({ flushServer: 'canonical', rejectOnFailure: true }))
        expect(state.events).toEqual(['saved', 'notified'])
    })

    test.each(['chara_card_v2', 'chara_card_v3'] as const)('restores legacy replaceGlobalNote from %s cards with a Risu extension that does not own it', async (spec) => {
        const imported = await importFixture(cardFixture(spec, {}))

        expect(imported).toMatchObject({
            postHistoryInstructions: 'legacy card global note',
            replaceGlobalNote: 'legacy card global note',
        })
    })

    test('does not fall back when a new card explicitly owns an empty replaceGlobalNote', async () => {
        const imported = await importFixture(cardFixture('chara_card_v3', { replaceGlobalNote: '' }, 'standard post history'))

        expect(imported).toMatchObject({
            postHistoryInstructions: 'standard post history',
            replaceGlobalNote: '',
        })
    })

    test.each(['chara_card_v2', 'chara_card_v3'] as const)('does not create a Risu replaceGlobalNote for ordinary %s cards', async (spec) => {
        const imported = await importFixture(cardFixture(spec, undefined, 'standard post history'))

        expect(imported).toMatchObject({
            postHistoryInstructions: 'standard post history',
            replaceGlobalNote: '',
        })
    })

    test('imports Risu module extension fields through the public card lifecycle', async () => {
        const imported = await importFixture(cardFixture('chara_card_v3', {
            moduleNamespace: 'fixture-namespace', hideChatIcon: true,
        }, ''))

        expect(imported).toMatchObject({ moduleNamespace: 'fixture-namespace', hideChatIcon: true })
    })
})

describe('public character-card lifecycle round-trips', () => {
    test.each([['v2', createBaseV2], ['v3', createBaseV3]] as const)('round-trips shared painter outfits and sanitizes lore links through %s', async (_spec, createCard) => {
        const lore = (id: string) => ({ id, key: id, secondkey: '', insertorder: 10, comment: id, content: 'Unchanged lore', mode: 'normal', alwaysActive: false, selective: false,
            extentions: { custom: { keep: true }, risubard: { other: true, bardPainter: { identityId: id } } } })
        const char = { name: 'Preset links', globalLore: [lore('aria'), lore('private')], loreExt: {}, bardPainter: {
            identities: [{ id: 'aria', name: 'Aria', aliases: [], appearance: 'hair', outfitIds: ['uniform', 'private-outfit'], defaultOutfitId: 'uniform', attachToCard: true },
                { id: 'private', name: 'Private', aliases: [], appearance: 'PRIVATE_APPEARANCE' }],
            outfits: [{ id: 'uniform', subjectId: '', name: 'Uniform', clothing: 'shirt', state: '', attachToCard: true },
                { id: 'private-outfit', subjectId: '', name: 'PRIVATE_OUTFIT', clothing: 'PRIVATE_CLOTHES', state: '' }],
        } } as unknown as character
        const before = JSON.stringify({ lore: char.globalLore, painter: char.bardPainter })
        const card = createCard(char)
        const entries = card.data.character_book!.entries
        expect(entries[0].extensions).toMatchObject({ custom: { keep: true }, risubard: { other: true, bardPainter: { identityId: 'aria' } } })
        expect(entries[1].extensions).toMatchObject({ custom: { keep: true }, risubard: { other: true } })
        expect((entries[1].extensions.risubard as any).bardPainter).toBeUndefined()
        expect(JSON.stringify(card)).not.toContain('PRIVATE_')
        expect(JSON.stringify(card)).not.toContain('private-outfit')
        expect(JSON.stringify({ lore: char.globalLore, painter: char.bardPainter })).toBe(before)
        const imported = await importFixture(card as any)
        expect(imported.bardPainter.identities[0]).toMatchObject({ outfitIds: ['uniform'], defaultOutfitId: 'uniform' })
        expect(imported.globalLore[0]).toMatchObject({ key: 'aria', content: 'Unchanged lore', extentions: { risubard: { bardPainter: { identityId: 'aria' } } } })
        expect(imported.bardPainter.identities[0].attachToCard).toBeUndefined()
        expect((state.db as any).bardPainterLibrary).toBeUndefined()
        delete (card.data.extensions as any).risubard.bardPainter
        const missing = await importFixture(card as any)
        expect(missing.globalLore[0].extentions.risubard).toEqual({ other: true })
        expect(missing.globalLore[0].content).toBe('Unchanged lore')
    })

    test.each([
        ['v2', createBaseV2],
        ['v3', createBaseV3],
    ] as const)('preserves bot painter identities and outfits through %s without exporting chat state', async (_spec, createCard) => {
        const painter = {
            identities: [{ id: 'aria', name: 'Aria', aliases: ['Captain'], appearance: 'black hair, blue eyes' }],
            outfits: [{ id: 'travel', subjectId: 'aria', name: 'Travel clothes', clothing: 'white shirt, dark trousers', state: '' }],
        }
        const card = createCard({
            name: 'Painter test', globalLore: [], loreExt: {}, bardPainter: {
                identities: [...painter.identities.map(item => ({ ...item, attachToCard: true })), { id: 'private', name: 'PRIVATE_NAME', aliases: ['PRIVATE_ALIAS'], appearance: 'PRIVATE_APPEARANCE' }],
                outfits: [...painter.outfits.map(item => ({ ...item, attachToCard: true })), { id: 'experiment', subjectId: 'aria', name: 'PRIVATE_OUTFIT', clothing: 'PRIVATE_CLOTHING', state: 'PRIVATE_STATE' },
                    { id: 'orphan', subjectId: 'private', name: 'PRIVATE_OWNER_OUTFIT', clothing: 'PRIVATE_OWNER_CLOTHING', state: '', attachToCard: true }],
            },
            chats: [{ bardPainter: { outfits: [{ id: 'private-outfit', clothing: 'private-chat-clothing' }], results: [{ assetId: 'private-chat-image' }] } }],
        } as any)
        expect((card.data.extensions as any).risubard?.bardPainter).toEqual(painter)
        expect(JSON.stringify(card)).not.toContain('PRIVATE_')
        expect(JSON.stringify(card)).not.toContain('attachToCard')
        expect(JSON.stringify(card)).not.toContain('private-chat')
        const imported = await importFixture(card as any)
        expect(imported.bardPainter).toEqual(painter)
        expect(imported.bardPainter).not.toBe(painter)
        expect((createCard(imported).data.extensions as any).risubard?.bardPainter).toBeUndefined()
        imported.bardPainter.identities[0].aliases.push('New alias')
        expect(painter.identities[0].aliases).toEqual(['Captain'])
    })

    test.each([['v2', createBaseV2], ['v3', createBaseV3]] as const)('excludes legacy personal painter data by default from %s', (_spec, createCard) => {
        const char = { name: 'Private', globalLore: [], loreExt: {}, bardPainter: {
            identities: [{ id: 'private', name: 'PRIVATE_NAME', aliases: [], appearance: 'PRIVATE_APPEARANCE' }],
            outfits: [{ id: 'outfit', subjectId: 'private', name: 'PRIVATE_OUTFIT', clothing: 'PRIVATE_CLOTHING', state: '' }],
        }, extentions: { risubard: { bardPainter: { private: 'PRIVATE_STALE_EXTENSION' } } } } as unknown as character
        const before = JSON.stringify(char.bardPainter)
        const card = createCard(char)
        expect((card.data.extensions as any).risubard?.bardPainter).toBeUndefined()
        expect(JSON.stringify(card)).not.toContain('PRIVATE_')
        expect(JSON.stringify(char.bardPainter)).toBe(before)
    })

    test('validates painter card data and excludes orphan outfits and unexpected fields at import', async () => {
        const card = cardFixture('chara_card_v3', undefined)
        ;(card.data.extensions as any).risubard = { bardPainter: {
            identities: [null, { id: 'aria', name: 'Aria', appearance: 'black hair', aliases: ['Captain', 7], attachToCard: true }],
            outfits: [
                { id: 'valid', subjectId: 'aria', name: 'Travel', clothing: 'cape', state: 'wet' },
                { id: 'orphan', subjectId: 'missing', name: 'Lost', clothing: 'dress', state: '' },
            ],
            results: [{ assetId: 'private-image' }], settings: { apiKey: 'secret' },
        } }
        const imported = await importFixture(card)
        expect(imported.bardPainter).toEqual({
            identities: [{ id: 'aria', name: 'Aria', appearance: 'black hair', aliases: ['Captain'] }],
            outfits: [{ id: 'valid', subjectId: 'aria', name: 'Travel', clothing: 'cape', state: 'wet' }],
        })
    })

    test.each([
        ['v2', createBaseV2],
        ['v3', createBaseV3],
    ] as const)('migrates namespaced Bard Lore without losing one-sided edits through %s', async (_spec, createCard) => {
        const legacyLore = [{
            id: 'legacy',
            key: 'legacy',
            secondkey: '',
            insertorder: 10,
            comment: 'Legacy',
            content: 'Legacy content',
            mode: 'normal',
            alwaysActive: false,
            selective: false,
        }]
        const bardEntry = {
            ...legacyLore[0],
            id: 'legacy',
            comment: 'Bard',
            content: 'Bard content',
            bard: {
                sourceLegacyId: 'legacy',
                sourceHash: fingerprintLegacyLore(legacyLore[0] as any),
                kind: 'location',
                activation: 'retrieve',
                aliases: ['장소'],
                tags: ['데이트'],
                summary: '장소 요약',
                facets: [],
                injection: 'full',
                links: [],
            },
        }
        const source = {
            name: 'Bard Lore lifecycle',
            globalLore: legacyLore,
            loreExt: {},
            bardLore: {
                schemaVersion: 1,
                mode: 'bard',
                entries: [bardEntry],
                settings: createBardLoreSettings({ maximumTokens: 777, maxEntries: 3 }),
                analysisRun: {
                    schemaVersion: 1,
                    id: 'run',
                    scope: 'all',
                    targetIds: ['legacy'],
                    createdAt: '2026-08-31T00:00:00.000Z',
                    updatedAt: '2026-08-31T00:00:00.000Z',
                    status: 'review',
                    settingsSnapshot: createBardLoreSettings({ maximumTokens: 777, maxEntries: 3 }),
                    overwriteExisting: false,
                    batches: [{
                        id: 'batch',
                        index: 0,
                        targetIds: ['legacy'],
                        estimatedInputTokens: 120,
                        status: 'complete',
                        candidates: [{
                            id: 'legacy',
                            sourceHash: 'draft-hash',
                            kind: 'location',
                            aliases: ['장소'],
                            tags: ['데이트'],
                            summary: '검토 대기',
                            facets: [],
                            injection: 'full',
                            atoms: [],
                            links: [],
                        }],
                    }],
                },
            },
        } as any

        const exported = createCard(source)
        expect(exported.data.character_book?.entries).toHaveLength(1)
        expect(exported.data.character_book?.entries[0]).toMatchObject({
            name: 'Bard',
            content: 'Bard content',
        })
        expect((exported.data.extensions as any).risubard.bardLore.settings.maximumTokens).toBe(777)
        expect(JSON.stringify((exported.data.extensions as any).risubard.bardLore)).not.toContain('Bard content')

        const imported = await importFixture(exported as any)
        const reexported = createCard(imported)

        expect(imported.globalLore).toHaveLength(1)
        expect(imported.bardLore).toMatchObject({
            schemaVersion: 2,
            metadata: [expect.objectContaining({ sourceLegacyId: 'legacy', kind: 'location' })],
            derivedEntries: [],
        })
        expect(imported.bardLore).not.toHaveProperty('entries')
        expect((reexported.data.extensions as any).risubard.bardLore).toEqual(imported.bardLore)
    })

    test.each([
        ['v2', createBaseV2],
        ['v3', createBaseV3],
    ] as const)('preserves completed Bard analysis drafts for ID-less lore through %s', async (_spec, createCard) => {
        const idlessLore = {
            key: 'place', secondkey: '', insertorder: 10, comment: 'Place', content: 'Stable place body',
            mode: 'normal' as const, alwaysActive: false, selective: false,
        }
        const settings = createBardLoreSettings()
        const bardLore = upgradeLegacyLorebook([{ ...idlessLore, id: 'old-source-id' }], () => 'unused', settings)
        bardLore.analysisRun = {
            schemaVersion: 1,
            id: 'run',
            scope: 'all',
            targetIds: ['old-source-id'],
            createdAt: '2026-09-02T00:00:00.000Z',
            updatedAt: '2026-09-02T00:00:00.000Z',
            status: 'review',
            settingsSnapshot: settings,
            overwriteExisting: false,
            batches: [{
                id: 'batch', index: 0, targetIds: ['old-source-id'], estimatedInputTokens: 10, status: 'complete',
                candidates: [{ id: 'old-source-id', sourceHash: 'draft', kind: 'location', aliases: [], tags: [], summary: 'completed', links: [] }],
            }],
        }

        const imported = await importFixture(createCard({
            name: 'ID-less Bard Lore',
            globalLore: [idlessLore],
            loreExt: {},
            bardLore,
        } as any) as any)
        const importedId = imported.globalLore[0].id

        expect(importedId).toBeTruthy()
        expect(imported.bardLore?.analysisRun?.targetIds).toEqual([importedId])
        expect(imported.bardLore?.analysisRun?.batches[0].candidates?.[0].id).toBe(importedId)
    })

    test.each([
        ['v2', createBaseV2],
        ['v3', createBaseV3],
    ] as const)('ignores malformed Bard Lore metadata without breaking the standard lorebook through %s', async (_spec, createCard) => {
        const exported = createCard({
            name: 'Standard compatibility',
            globalLore: [{
                id: 'legacy',
                key: 'legacy',
                secondkey: '',
                insertorder: 10,
                comment: 'Legacy',
                content: 'Legacy content',
                mode: 'normal',
                alwaysActive: false,
                selective: false,
            }],
            loreExt: {},
        } as any)
        ;(exported.data.extensions as any).risubard = {
            bardLore: { schemaVersion: 999, entries: 'invalid' },
        }

        const imported = await importFixture(exported as any)

        expect(imported.globalLore).toHaveLength(1)
        expect(imported.globalLore[0]).toMatchObject({
            comment: 'Legacy',
            content: 'Legacy content',
        })
        expect(imported.bardLore).toBeUndefined()
    })

    test.each([
        ['v2', createBaseV2],
        ['v3', createBaseV3],
    ] as const)('preserves Risu extensions and post-history instructions through %s export, import, and re-export', async (_spec, createCard) => {
        const source = {
            name: 'Lifecycle fixture', globalLore: [], loreExt: {},
            postHistoryInstructions: 'standard post-history instructions',
            replaceGlobalNote: 'explicit Risu global-note replacement',
            moduleNamespace: 'lifecycle-namespace',
            hideChatIcon: true,
        } as any

        const imported = await importFixture(createCard(source) as any)
        const reexported = createCard(imported)

        expect(imported).toMatchObject({
            postHistoryInstructions: source.postHistoryInstructions,
            replaceGlobalNote: source.replaceGlobalNote,
            moduleNamespace: source.moduleNamespace,
            hideChatIcon: source.hideChatIcon,
        })
        expect(reexported.data.post_history_instructions).toBe(source.postHistoryInstructions)
        expect(reexported.data.extensions.risuai).toMatchObject({
            replaceGlobalNote: source.replaceGlobalNote,
            moduleNamespace: source.moduleNamespace,
            hideChatIcon: source.hideChatIcon,
        })
    })
})
