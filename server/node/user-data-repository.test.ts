import { afterEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { createUserDataRepository } = require('./user-data-repository.cjs')

const roots: string[] = []
function root() {
    const value = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-repository-'))
    roots.push(value)
    return value
}

function replaceCanonicalBytes(dataRoot: string, relativePath: string, bytes: Buffer, updateChecksum = true) {
    const target = path.join(dataRoot, relativePath)
    const temporary = `${target}.external.tmp`
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(temporary, bytes)
    fs.renameSync(temporary, target)
    if (updateChecksum) {
        const digest = crypto.createHash('sha256').update(bytes).digest('hex')
        const checksumTarget = `${target}.sha256`
        const checksumTemporary = `${checksumTarget}.external.tmp`
        fs.writeFileSync(checksumTemporary, `${digest}\n`)
        fs.renameSync(checksumTemporary, checksumTarget)
    }
}

function replaceCanonicalJson(dataRoot: string, relativePath: string, value: unknown, updateChecksum = true) {
    replaceCanonicalBytes(
        dataRoot,
        relativePath,
        Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'),
        updateChecksum,
    )
}
afterEach(() => {
    vi.restoreAllMocks()
    roots.splice(0).forEach(value => fs.rmSync(value, { recursive: true, force: true }))
})

function legacyDatabase() {
    return {
        formatversion: 5,
        language: 'ko',
        openAIKey: 'secret-key',
        provider: { model: 'example', credentials: { accessToken: 'nested-secret' } },
        botPresets: [{ id: 'preset-1', name: 'Preset', temperature: 0.7 }],
        modules: [{ id: 'module-1', name: 'Module', lorebook: [] }],
        personas: [{ id: 'persona-1', name: 'Writer', personaPrompt: 'hello' }],
        loreBook: [{ id: 'lore-1', name: 'World', data: [] }],
        characters: [{
            chaId: 'char-1',
            name: 'Character',
            description: 'loaded only on demand',
            chats: [{
                id: 'chat-1',
                name: 'Chat',
                lastDate: 123,
                message: [
                    { id: 'message-1', role: 'user', data: 'hello' },
                    { id: 'message-2', role: 'char', data: 'world' },
                ],
            }],
        }],
    }
}

describe('canonical entity tree', () => {
    it.each([false, true])('saves painter character metadata without reading chat bodies (root settings: %s)', (includeRootSettings) => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        const database = legacyDatabase()
        repository.importLegacyDatabase(database, { mode: 'sync' })
        Object.assign(database.characters[0], { bardPainter: { identities: [{ id: 'person', name: 'Aria', appearance: 'blue eyes' }], outfits: [] } })
        if (includeRootSettings) Object.assign(database, { bardPainterLibrary: { identities: [], outfits: [] } })
        const expected = structuredClone(database)
        const chat = database.characters[0].chats[0]
        const messages = chat.message
        Object.defineProperty(chat, 'message', { configurable: true, get() { throw new Error('Unrelated chat body was read') } })
        try {
            const { writeCanonicalProjection } = require('./canonical-projection-writer.cjs')
            const result = writeCanonicalProjection({ repository, database, directCollection: {
                kind: 'chatState', chats: [], characterIds: ['char-1'], includeRootSettings,
            } })
            expect(result.fallbackUsed).toBe(false)
            expect(result.result.files).toBe(includeRootSettings ? 4 : 2)
        } finally { Object.defineProperty(chat, 'message', { configurable: true, enumerable: true, writable: true, value: messages }) }
        expect(createUserDataRepository({ dataRoot }).exportLegacyDatabase()).toEqual(expected)
    })

    it.each([{ characterIds: [] }, { characterIds: ['unknown'] }])('rejects empty or stale metadata scopes before writing: %j', ({ characterIds }) => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        const database = legacyDatabase()
        repository.importLegacyDatabase(database, { mode: 'sync' })
        database.characters[0].name = 'must not save'
        expect(() => repository.syncLegacyChatState(database, { chats: [], characterIds })).toThrow(/scope changed/)
        expect(repository.exportLegacyDatabase()).toEqual(legacyDatabase())
    })

    it('preserves legacy JSONL bytes for sparse and omitted message values', () => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        const database = legacyDatabase()
        const messages = database.characters[0].chats[0].message
        delete messages[0]
        messages.push(undefined as any)
        repository.importLegacyDatabase(database, { mode: 'sync' })
        expect(fs.readFileSync(path.join(dataRoot, 'characters/char-1/chats/chat-1/messages.jsonl'), 'utf8'))
            .toBe(messages.map(message => JSON.stringify(message)).join('\n') + '\n')
    })

    it('keeps chat-variable checkpoints only on the latest message that has them', () => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        const database = legacyDatabase()
        const checkpoint = { before: { a: '1' }, after: { a: '2' } }
        database.characters[0].chats[0].message = [
            { id: 'm1', role: 'char', data: 'old', scriptstateCheckpoint: checkpoint, scriptstateSwipeCheckpoints: [checkpoint] },
            { id: 'm2', role: 'char', data: 'latest', scriptstateCheckpoint: checkpoint },
            { id: 'm3', role: 'user', data: 'next' },
        ] as any
        repository.importLegacyDatabase(database, { mode: 'sync' })
        expect(repository.exportLegacyDatabase().characters[0].chats[0].message).toEqual([
            { id: 'm1', role: 'char', data: 'old' },
            { id: 'm2', role: 'char', data: 'latest', scriptstateCheckpoint: checkpoint },
            { id: 'm3', role: 'user', data: 'next' },
        ])
    })

    it('drops the latest checkpoint instead of failing when the message is too large to serialize', () => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        const database = legacyDatabase()
        database.characters[0].chats[0].message = [
            { id: 'm1', role: 'char', data: 'huge', scriptstateSwipeCheckpoints: [{ before: null, after: { a: 'x' } }] },
        ] as any
        const stringify = JSON.stringify
        vi.spyOn(JSON, 'stringify').mockImplementation(function (this: unknown, value: any, ...rest: any[]) {
            if (value?.id === 'm1' && value.scriptstateSwipeCheckpoints) throw new RangeError('Invalid string length')
            return stringify.call(JSON, value, ...rest)
        } as typeof JSON.stringify)
        repository.importLegacyDatabase(database, { mode: 'sync' })
        vi.restoreAllMocks()
        expect(repository.exportLegacyDatabase().characters[0].chats[0].message).toEqual([
            { id: 'm1', role: 'char', data: 'huge' },
        ])
    })

    it.each(['full', 'direct'])('round-trips %s chat saves without a chat-sized string', (mode) => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        const database = legacyDatabase()
        if (mode === 'direct') repository.importLegacyDatabase(database, { mode: 'sync' })
        database.characters[0].chats[0].message = Array.from({ length: 12 }, (_, index) => ({
            id: `message-${index}`, role: 'char', data: '한글😀\n'.repeat(40),
        }))
        // Model a low JS string limit without allocating hundreds of megabytes.
        const join = Array.prototype.join
        const decode = Buffer.prototype.toString
        const joinSpy = vi.spyOn(Array.prototype, 'join').mockImplementation(function (this: string[], separator) {
            if (separator === '\n' && this.reduce((size, item) => size + item.length, 0) > 1024) {
                throw new RangeError('Invalid string length')
            }
            return join.call(this, separator)
        })
        const decodeSpy = vi.spyOn(Buffer.prototype, 'toString').mockImplementation(function (this: Buffer, encoding, start, end) {
            if ((end ?? this.length) - (start ?? 0) > 1024) throw new RangeError('Invalid string length')
            return decode.call(this, encoding, start, end)
        })
        let loaded
        let reconciled
        try {
            if (mode === 'full') repository.importLegacyDatabase(database, { mode: 'sync' })
            else repository.syncLegacyChatState(database, { chats: [{ characterId: 'char-1', chatId: 'chat-1' }] })
            const reopened = createUserDataRepository({ dataRoot })
            loaded = reopened.loadChat('char-1', 'chat-1')
            reconciled = reopened.reconcileCanonicalProjection().database
        } finally {
            joinSpy.mockRestore()
            decodeSpy.mockRestore()
        }
        expect(loaded.message).toEqual(database.characters[0].chats[0].message)
        expect(reconciled).toEqual(database)
    })

    it('reads startup metadata without reading message files, and hydrates only the requested chat', () => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        const database = legacyDatabase()
        database.characters[0].chats.push({ ...structuredClone(database.characters[0].chats[0]), id: 'chat-2' })
        repository.importLegacyDatabase(database, { mode: 'sync' })
        const reads = vi.spyOn(fs, 'readFileSync')
        const startup = repository.loadStartupDatabase()
        expect(startup.characters[0].chats[0]).toEqual({ id: 'chat-1', name: 'Chat', lastDate: 123, _stub: true })
        expect(startup.characters[0].description).toBe(database.characters[0].description)
        expect(reads.mock.calls.some(([file]) => String(file).endsWith('messages.jsonl'))).toBe(false)
        reads.mockClear()
        expect(repository.loadIndexedChat('char-1', 1)).toEqual(database.characters[0].chats[1])
        expect(reads.mock.calls.some(([file]) => String(file).includes('chat-1'))).toBe(false)
        expect(repository.exportLegacyDatabase()).toEqual(database)
    })

    it('previews an indexed chat from its metadata and last message line only', () => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        const database = legacyDatabase()
        Object.assign(database.characters[0].chats[0], { bindedPersona: 'persona-1', note: 'not in preview' })
        repository.importLegacyDatabase(database, { mode: 'sync' })
        const reads = vi.spyOn(fs, 'readFileSync')
        expect(repository.loadIndexedChatPreview('char-1', 0)).toEqual({
            id: 'chat-1',
            bindedPersona: 'persona-1',
            lastMessage: { role: 'char', data: 'world' },
        })
        // The message file is read through a bounded tail read, never parsed whole.
        expect(reads.mock.calls.some(([file]) => String(file).endsWith('messages.jsonl'))).toBe(false)
        expect(repository.loadIndexedChatPreview('char-1', 5)).toBeNull()
        expect(repository.loadIndexedChatPreview('missing', 0)).toBeNull()
    })

    it('declines direct startup for legacy chats needing persistent IDs', () => {
        const repository = createUserDataRepository({ dataRoot: root() })
        const database = legacyDatabase()
        database.characters[0].chats[0].id = ''
        repository.importLegacyDatabase(database, { mode: 'sync' })
        expect(() => repository.loadStartupDatabase()).toThrow(/migration/i)
    })

    it('writes only selected chat state and companion settings, with restart equality', () => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        const database = legacyDatabase()
        database.characters[0].chats.push({ ...structuredClone(database.characters[0].chats[0]), id: 'chat-2' })
        repository.importLegacyDatabase(database, { mode: 'sync' })
        const untouched = path.join(dataRoot, 'characters/char-1/chats/chat-2/messages.jsonl')
        const previousStat = fs.statSync(untouched, { bigint: true })
        database.characters[0].chats[0].message[1].data = 'edited response'
        database.characters[0].chats[0].name = 'renamed'
        database.characters[0].name = 'renamed character'
        database.language = 'en'
        const result = repository.syncLegacyChatState(database, {
            chats: [{ characterId: 'char-1', chatId: 'chat-1' }],
            characterIds: ['char-1'], includeRootSettings: true,
        })
        expect(result.files).toBe(6)
        expect(fs.statSync(untouched, { bigint: true }).mtimeNs).toBe(previousStat.mtimeNs)
        expect(createUserDataRepository({ dataRoot }).exportLegacyDatabase()).toEqual(database)
    })

    it.each(['reorder', 'delete', 'duplicate', 'missing', 'unknown-scope'])
    ('rejects %s before publishing a partial chat projection', (kind) => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        const database = legacyDatabase()
        database.characters[0].chats.push({ ...structuredClone(database.characters[0].chats[0]), id: 'chat-2' })
        repository.importLegacyDatabase(database, { mode: 'sync' })
        const before = repository.exportLegacyDatabase()
        if (kind === 'reorder') database.characters[0].chats.reverse()
        if (kind === 'delete') database.characters[0].chats.pop()
        if (kind === 'duplicate') database.characters[0].chats[1].id = 'chat-1'
        if (kind === 'missing') database.characters[0].chats[0].id = ''
        expect(() => repository.syncLegacyChatState(database, {
            chats: [{ characterId: 'char-1', chatId: kind === 'unknown-scope' ? 'unknown' : 'chat-1' }],
            characterIds: ['char-1'], includeRootSettings: false,
        })).toThrow()
        expect(repository.exportLegacyDatabase()).toEqual(before)
    })

    it('rejects character aliases that normalize to the same canonical directory', () => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        const database = legacyDatabase()
        database.characters.push({ ...structuredClone(database.characters[0]), chaId: ' char-1 ' })
        repository.importLegacyDatabase(database, { mode: 'sync' })
        expect(() => repository.syncLegacyChatState(database, {
            chats: [{ characterId: 'char-1', chatId: 'chat-1' }],
        })).toThrow(/scope changed/)
    })

    it('imports the legacy projection into stable-ID JSON and chat JSONL files', () => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        const result = repository.importLegacyDatabase(legacyDatabase(), { mode: 'merge' })

        expect(result.transaction).toMatchObject({
            committed: result.files,
            published: result.files,
            skipped: 0,
        })
        expect(result.transaction.stagedBytes).toBeGreaterThan(0)

        expect(JSON.parse(fs.readFileSync(path.join(dataRoot, 'settings', 'app.json'), 'utf8')).openAIKey).toBeUndefined()
        expect(JSON.parse(fs.readFileSync(path.join(dataRoot, 'secrets', 'credentials.json'), 'utf8')).openAIKey).toBe('secret-key')
        expect(JSON.parse(fs.readFileSync(path.join(dataRoot, 'settings', 'app.json'), 'utf8')).provider).toEqual({ model: 'example' })
        expect(JSON.parse(fs.readFileSync(path.join(dataRoot, 'secrets', 'credentials.json'), 'utf8')).provider.credentials.accessToken).toBe('nested-secret')
        expect(fs.existsSync(path.join(dataRoot, 'presets', 'preset-1.json'))).toBe(true)
        expect(fs.existsSync(path.join(dataRoot, 'modules', 'module-1.json'))).toBe(true)
        expect(fs.existsSync(path.join(dataRoot, 'personas', 'persona-1.json'))).toBe(true)
        expect(fs.existsSync(path.join(dataRoot, 'lorebooks', 'lore-1.json'))).toBe(true)
        expect(fs.existsSync(path.join(dataRoot, 'characters', 'char-1', 'metadata.json'))).toBe(true)
        const lines = fs.readFileSync(path.join(dataRoot, 'characters', 'char-1', 'chats', 'chat-1', 'messages.jsonl'), 'utf8').trim().split('\n')
        expect(lines.map(line => JSON.parse(line).id)).toEqual(['message-1', 'message-2'])
    })

    it('keeps existing stable-ID entities on merge and moves omitted entities to trash on replace', () => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        repository.importLegacyDatabase(legacyDatabase(), { mode: 'replace' })

        repository.importLegacyDatabase({
            language: 'en',
            characters: [{ chaId: 'char-2', name: 'Second', chats: [] }],
            botPresets: [], modules: [], personas: [], loreBook: [],
        }, { mode: 'merge' })
        expect(repository.loadSidebarIndex().characters.map((item: any) => item.id)).toEqual(['char-1', 'char-2'])
        expect(repository.exportLegacyDatabase().provider.model).toBe('example')

        repository.importLegacyDatabase({
            language: 'ja',
            characters: [{ chaId: 'char-2', name: 'Second updated', chats: [] }],
            botPresets: [], modules: [], personas: [], loreBook: [],
        }, { mode: 'replace' })
        expect(repository.loadSidebarIndex().characters.map((item: any) => item.id)).toEqual(['char-2'])
        expect(repository.exportLegacyDatabase().provider).toBeUndefined()
        expect(fs.existsSync(path.join(dataRoot, 'characters', 'char-1'))).toBe(false)
        expect(fs.readdirSync(path.join(dataRoot, 'trash')).length).toBeGreaterThan(0)
    })

    it('validates sidebar metadata on startup without reading message bodies', () => {
        const dataRoot = root()
        createUserDataRepository({ dataRoot }).importLegacyDatabase(legacyDatabase(), { mode: 'merge' })
        const reads: string[] = []
        const original = fs.readFileSync
        vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) => {
            reads.push(String(file))
            return (original as any)(file, ...args)
        }) as any)

        const index = createUserDataRepository({ dataRoot }).loadSidebarIndex()
        expect(index.characters[0]).toMatchObject({ id: 'char-1', name: 'Character' })
        expect(reads.some(file => file.endsWith(`characters${path.sep}char-1${path.sep}metadata.json`))).toBe(true)
        expect(reads.some(file => file.endsWith('messages.jsonl'))).toBe(false)
    })

    it('lazy-loads a selected chat and reconstructs a compatible legacy projection', () => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        repository.importLegacyDatabase(legacyDatabase(), { mode: 'merge' })

        expect(repository.loadChat('char-1', 'chat-1').message).toHaveLength(2)
        const exported = repository.exportLegacyDatabase()
        expect(exported.openAIKey).toBe('secret-key')
        expect(exported.characters[0].description).toBe('loaded only on demand')
        expect(exported.characters[0].chats[0].message[1].data).toBe('world')
    })

    it('round-trips empty objects, an empty chat id, and an absent message field', () => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        const database: any = legacyDatabase()
        database.collectionOrganizers = {
            promptPresets: { folderByItemId: {} },
            plugins: { folderByItemId: {} },
        }
        database.personaEnabledModules = {}
        database.seperateParameters = {
            first: {}, second: {}, third: {}, fourth: {}, fifth: {},
        }
        database.moduleModelBindings = {}
        database.characters[0].chats[0].id = ''
        delete database.characters[0].chats[0].message

        repository.importLegacyDatabase(database, { mode: 'sync' })

        expect(repository.loadSidebarIndex().characters[0].chats[0].id).toMatch(/^chat-/)
        expect(repository.exportLegacyDatabase()).toStrictEqual(database)
    })

    it('syncs one legacy collection without rewriting unrelated canonical data', () => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        const database: any = legacyDatabase()
        repository.importLegacyDatabase(database, { mode: 'sync' })

        const result = repository.syncLegacyCollection('botPresets', [
            { id: 'preset-2', name: 'Second preset', temperature: 0.4 },
        ])
        const exported = repository.exportLegacyDatabase()

        expect(result.files).toBe(2)
        expect(exported.botPresets).toEqual([{ id: 'preset-2', name: 'Second preset', temperature: 0.4 }])
        expect(exported.modules).toEqual(database.modules)
        expect(exported.personas).toEqual(database.personas)
        expect(exported.characters).toEqual(database.characters)
        expect(fs.existsSync(path.join(dataRoot, 'presets', 'preset-1.json'))).toBe(false)
        expect(fs.readdirSync(path.join(dataRoot, 'trash')).length).toBeGreaterThan(0)
    })

    it('syncs preset companion settings and presets without rewriting unrelated entities', () => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        const database: any = legacyDatabase()
        repository.importLegacyDatabase(database, { mode: 'sync' })

        const changed = {
            ...database,
            language: 'en',
            openAIKey: 'changed-secret',
            botPresetsId: 1,
            botPresets: [
                { id: 'preset-1', name: 'Renamed preset', temperature: 0.5 },
                { id: 'preset-2', name: 'Second preset', temperature: 0.4 },
            ],
        }
        const result = repository.syncLegacyPresetState(changed)
        const exported = repository.exportLegacyDatabase()

        expect(result.files).toBe(5)
        expect(exported.language).toBe('en')
        expect(exported.openAIKey).toBe('changed-secret')
        expect(exported.botPresetsId).toBe(1)
        expect(exported.botPresets).toEqual(changed.botPresets)
        expect(exported.modules).toEqual(database.modules)
        expect(exported.personas).toEqual(database.personas)
        expect(exported.characters).toEqual(database.characters)
    })

    it('rejects malformed preset state so the caller can use the full-sync fallback', () => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        const database: any = legacyDatabase()
        repository.importLegacyDatabase(database, { mode: 'sync' })

        expect(() => repository.syncLegacyPresetState({ ...database, botPresets: null }))
            .toThrow('Legacy collection must be an array: botPresets')
    })

    it('fsyncs a user message before request state and recovers an assistant draft', () => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        repository.importLegacyDatabase(legacyDatabase(), { mode: 'merge' })
        repository.commitUserMessage('char-1', 'chat-1', { id: 'message-3', role: 'user', data: 'committed' })
        const messagesPath = path.join(dataRoot, 'characters', 'char-1', 'chats', 'chat-1', 'messages.jsonl')
        expect(fs.readFileSync(`${messagesPath}.sha256`, 'utf8').trim()).toBe(
            crypto.createHash('sha256').update(fs.readFileSync(messagesPath)).digest('hex'),
        )
        repository.saveAssistantDraft('char-1', 'chat-1', { id: 'message-4', role: 'char', data: 'partial' })

        const reopened = createUserDataRepository({ dataRoot })
        expect(reopened.loadChat('char-1', 'chat-1').message.at(-1)?.data).toBe('committed')
        expect(reopened.loadAssistantDraft('char-1', 'chat-1')?.data).toBe('partial')
        reopened.finalizeAssistantDraft('char-1', 'chat-1')
        expect(reopened.loadChat('char-1', 'chat-1').message.at(-1)?.data).toBe('partial')
        expect(reopened.loadAssistantDraft('char-1', 'chat-1')).toBeNull()
    })

    it('changes the projection revision when canonical entity files are edited externally', () => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        repository.importLegacyDatabase(legacyDatabase(), { mode: 'merge' })

        const getProjectionRevision = repository.getProjectionRevision?.bind(repository)
        expect(getProjectionRevision).toBeTypeOf('function')
        if (!getProjectionRevision) return

        const revisions = [getProjectionRevision()]
        const editJson = (relativePath: string, mutate: (value: any) => void) => {
            const target = path.join(dataRoot, relativePath)
            const value = JSON.parse(fs.readFileSync(target, 'utf8'))
            mutate(value)
            replaceCanonicalJson(dataRoot, relativePath, value)
            revisions.push(getProjectionRevision())
        }

        editJson('settings/app.json', value => { value.language = 'external-settings' })
        editJson('presets/preset-1.json', value => { value.name = 'External preset' })
        editJson('characters/char-1/metadata.json', value => { value.name = 'External character' })
        editJson('characters/char-1/chats/chat-1/metadata.json', value => { value.name = 'External chat' })
        fs.appendFileSync(
            path.join(dataRoot, 'characters', 'char-1', 'chats', 'chat-1', 'messages.jsonl'),
            `${JSON.stringify({ id: 'external-message', role: 'user', data: 'external' })}\n`,
        )
        revisions.push(getProjectionRevision())

        expect(revisions.every((revision, index) => index === 0 || revision !== revisions[index - 1])).toBe(true)
        const reopenedRevision = createUserDataRepository({ dataRoot }).getProjectionRevision()
        expect(reopenedRevision).not.toBe(revisions.at(-1))
        expect(createUserDataRepository({ dataRoot }).getProjectionRevision()).toBe(reopenedRevision)
    })

    it('reconciles externally edited character metadata and chat summaries into the derived sidebar', () => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        const database: any = legacyDatabase()
        database.characters[0].modification_date = 1_700_000_000
        database.characters[0].globalLore = [{ key: 'old', content: 'old lore' }]
        repository.importLegacyDatabase(database, { mode: 'sync' })

        const characterPath = 'characters/char-1/metadata.json'
        const character = JSON.parse(fs.readFileSync(path.join(dataRoot, characterPath), 'utf8'))
        character.name = 'Externally renamed'
        character.modification_date = 1_800_000_123
        character.globalLore = [{ key: 'new', content: 'new lore' }]
        replaceCanonicalJson(dataRoot, characterPath, character)

        const chatPath = 'characters/char-1/chats/chat-1/metadata.json'
        const chat = JSON.parse(fs.readFileSync(path.join(dataRoot, chatPath), 'utf8'))
        chat.name = 'Externally renamed chat'
        chat.lastDate = 456
        replaceCanonicalJson(dataRoot, chatPath, chat)

        const result = repository.reconcileCanonicalProjection()
        const sidebar = repository.loadSidebarIndex()

        expect(result.sidebarWritten).toBe(true)
        expect(sidebar.characters[0]).toMatchObject({
            id: 'char-1',
            name: 'Externally renamed',
            updatedAt: 1_800_000_123_000,
        })
        expect(sidebar.characters[0].chats[0]).toMatchObject({
            id: 'chat-1',
            name: 'Externally renamed chat',
            lastDate: 456,
        })
        expect(result.database.characters[0].globalLore).toEqual(character.globalLore)
    })

    it('uses metadata mtime as a stable updatedAt fallback and does not rewrite an unchanged sidebar', () => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        repository.importLegacyDatabase(legacyDatabase(), { mode: 'sync' })
        const metadataPath = path.join(dataRoot, 'characters', 'char-1', 'metadata.json')
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
        delete metadata.modification_date
        replaceCanonicalJson(dataRoot, 'characters/char-1/metadata.json', metadata)
        const expectedUpdatedAt = Math.trunc(fs.statSync(metadataPath).mtimeMs)

        const changed = repository.reconcileCanonicalProjection()
        const sidebarPath = path.join(dataRoot, 'index', 'sidebar.json')
        const sidebarMtime = fs.statSync(sidebarPath).mtimeMs
        const unchanged = repository.reconcileCanonicalProjection()

        expect(changed.sidebar.characters[0].updatedAt).toBe(expectedUpdatedAt)
        expect(unchanged.sidebarWritten).toBe(false)
        expect(fs.statSync(sidebarPath).mtimeMs).toBe(sidebarMtime)
    })

    it.each(['missing', 'stale', 'checksum-mismatch'])('repairs a %s sidebar from canonical files on repository startup', (condition) => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        repository.importLegacyDatabase(legacyDatabase(), { mode: 'sync' })
        const sidebarPath = path.join(dataRoot, 'index', 'sidebar.json')

        const metadataPath = 'characters/char-1/metadata.json'
        const metadata = JSON.parse(fs.readFileSync(path.join(dataRoot, metadataPath), 'utf8'))
        metadata.name = `Recovered ${condition}`
        metadata.modification_date = 1_800_000_456
        replaceCanonicalJson(dataRoot, metadataPath, metadata)

        if (condition === 'missing') {
            fs.rmSync(sidebarPath)
            fs.rmSync(`${sidebarPath}.sha256`)
        } else if (condition === 'checksum-mismatch') {
            fs.writeFileSync(`${sidebarPath}.sha256`, '0'.repeat(64) + '\n')
        }

        const reopened = createUserDataRepository({ dataRoot })
        expect(reopened.loadSidebarIndex().characters[0]).toMatchObject({
            name: `Recovered ${condition}`,
            updatedAt: 1_800_000_456_000,
        })
    })

    it('discovers externally added collections without relying on sidebar membership', () => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        repository.importLegacyDatabase(legacyDatabase(), { mode: 'sync' })
        replaceCanonicalJson(dataRoot, 'personas/persona-2.json', {
            id: 'persona-2',
            name: 'External persona',
            personaPrompt: 'external prompt',
        })

        const result = repository.reconcileCanonicalProjection()

        expect(result.sidebar.collections.personas).toEqual(['persona-1', 'persona-2'])
        expect(result.database.personas.map((persona: any) => persona.name))
            .toEqual(['Writer', 'External persona'])
    })

    it('rejects a canonical snapshot whose entity bytes and checksum are only partially updated', () => {
        const dataRoot = root()
        const repository = createUserDataRepository({ dataRoot })
        repository.importLegacyDatabase(legacyDatabase(), { mode: 'sync' })
        const sidebarBefore = fs.readFileSync(path.join(dataRoot, 'index', 'sidebar.json'))
        const metadataPath = 'characters/char-1/metadata.json'
        const metadata = JSON.parse(fs.readFileSync(path.join(dataRoot, metadataPath), 'utf8'))
        metadata.name = 'Partial external edit'
        replaceCanonicalJson(dataRoot, metadataPath, metadata, false)

        expect(() => repository.reconcileCanonicalProjection()).toThrow('checksum mismatch')
        expect(fs.readFileSync(path.join(dataRoot, 'index', 'sidebar.json'))).toEqual(sidebarBefore)
    })
})
