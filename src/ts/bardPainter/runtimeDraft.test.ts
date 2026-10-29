import { beforeEach, expect, it, vi } from 'vitest'
import type { Database } from '../storage/database.svelte'
import { createPainterChatData, type PainterSubject } from './types'

const mocks = vi.hoisted(() => ({ db: {} as Database, save: vi.fn(), request: vi.fn(), lore: vi.fn(), hydrate: vi.fn() }))
vi.mock('../stores.svelte', () => ({ DBState: { db: mocks.db }, ReloadChatPointer: { update: vi.fn() } }))
vi.mock('../globalApi.svelte', () => ({ requestImmediateSave: mocks.save, globalFetch: vi.fn(), forageStorage: { createAuth: vi.fn() } }))
vi.mock('../process/request/request', () => ({ requestChatData: mocks.request }))
vi.mock('../loreBuilder', () => ({ collectLoreBuilderSources: () => ({}), matchLoreBuilderCharacterLorebook: mocks.lore }))
vi.mock('../risubard/memoryWiki', () => ({ loadNarrativeMemoryWiki: vi.fn() }))
vi.mock('../process/files/inlays', () => ({ setInlayAsset: vi.fn(), getInlayAssetBlob: vi.fn() }))
vi.mock('../storage/chatStorage', () => ({ ensureChatHydrated: mocks.hydrate }))
vi.mock('./image', () => ({ compressPainterImage: vi.fn() }))
vi.mock('./gallery', () => ({ savePainterGalleryRecord: vi.fn() }))
import { PainterSession } from './runtime.svelte'

const anchor = { characterId: 'bot', chatId: 'chat', messageId: 'm', start: 0, end: 4, text: 'Aria pours tea for Seb.' }
const block = (patch: Partial<PainterSubject>): PainterSubject => ({ id: 'x', name: 'x', aliases: [], kind: 'character', appearance: 'x look', clothing: '', state: '', pose: 'old pose', negative: '', ...patch })
const plan = (subjects: unknown[]) => ({ type: 'success', result: JSON.stringify({ version: 2, size: '', rendering: '', negative: '', interactions: [],
    scene: { tags: '2people', location: 'garden', framing: '', camera: '' }, subjects }) })
const planned = (patch: Record<string, unknown>) => ({ id: '', name: '', aliases: [], kind: 'character', appearance: '', outfitId: '', clothing: '', state: '', stateIds: [],
    pose: { tags: '', placement: '', posture: '', action: '', expression: '', gaze: '' }, negative: '', ...patch })
let session: PainterSession
function open() { session = new PainterSession('bot', 'chat'); return session }

beforeEach(() => {
    vi.resetAllMocks()
    Object.assign(mocks.db, {
        characters: [{ chaId: 'bot', chatPage: 0, globalLore: [],
            bardPainter: { identities: [{ id: 'seb', name: 'Seb', aliases: ['butler'], appearance: 'black hair, butler' }, { id: 'blank-aria', name: 'Aria', aliases: [], appearance: '' }], outfits: [] },
            chats: [{ id: 'chat', message: [{ chatId: 'm', data: anchor.text, role: 'char' }], bardPainter: createPainterChatData() }] }],
        bardPainterLibrary: { identities: [{ id: 'g-aria', name: 'Aria', aliases: ['아리아'], appearance: 'silver hair', outfitIds: ['g-dress'], defaultOutfitId: 'g-dress' }],
            outfits: [{ id: 'g-dress', subjectId: '', name: 'Dress', clothing: 'white dress', state: '' }] },
        bardPainterSettings: undefined,
    })
    mocks.save.mockResolvedValue(undefined)
    mocks.hydrate.mockImplementation(async (chats, i) => chats[i])
    mocks.lore.mockResolvedValue({ content: '', sources: [], entries: [] })
    open()
})

it('adds manual blocks before any prompt and reflects a global character into a same-named blank entry', async () => {
    expect(session.data.draft).toBeUndefined()
    expect(session.unreflectedGlobalIdentities.map(item => item.id)).toEqual(['g-aria'])
    expect(await session.addSubject({ kind: 'object' })).toBeTruthy()
    expect(session.data.draft).toMatchObject({ scene: '', subjects: [{ kind: 'object', manual: true }] })
    const id = await session.addSubject({ globalId: 'g-aria' })
    expect(id).toBe('blank-aria')
    expect(session.bot.identities.find(item => item.id === 'blank-aria')).toMatchObject({ appearance: 'silver hair', aliases: ['아리아'], sourceId: 'g-aria', defaultOutfitId: 'g-dress' })
    expect(session.bot.globalOutfits).toEqual([{ id: 'g-dress' }])
    expect(session.data.draft!.subjects[1]).toMatchObject({ id: 'blank-aria', name: 'Aria', appearance: 'silver hair', clothing: 'white dress', outfitId: 'g-dress', manual: true, presetMatch: 'manual' })
    expect(session.unreflectedGlobalIdentities).toEqual([])
    expect(await session.addSubject({ identityId: 'blank-aria' })).toBeUndefined()
    expect(session.state.error).toContain('이미 인물 블록에 있는')
})

it('links a block to a saved character and flags a same-named unreflected global character', async () => {
    session.data.draft = { scene: 'garden', rendering: '', negative: '', subjects: [block({ id: 'draft-a', name: 'aria', appearance: 'model guess' })] }
    expect(session.globalMatchFor(session.data.draft.subjects[0])?.id).toBe('g-aria')
    expect(await session.linkSubject('draft-a', { globalId: 'g-aria' })).toBe(true)
    expect(session.data.draft.subjects[0]).toMatchObject({ id: 'blank-aria', appearance: 'silver hair', clothing: 'white dress' })
    expect(session.globalMatchFor(session.data.draft.subjects[0])).toBeUndefined()
    expect(await session.linkSubject('blank-aria', { identityId: 'seb' })).toBe(true)
    expect(session.data.draft.subjects[0]).toMatchObject({ id: 'seb', name: 'Seb', appearance: 'black hair, butler' })
})

it('keeps only user-added and locked blocks when the scene changes', async () => {
    const data = session.data
    data.anchor = anchor
    data.draft = { scene: 'garden', rendering: '', negative: '', fragments: [{ id: 'f', name: 'glow', prompt: 'glow' }], subjects: [
        block({ id: 'manual', manual: true, poseEdited: true }), block({ id: 'locked', locked: true }), block({ id: 'model' }),
    ] }
    data.conversation = [{ id: '1', role: 'user', text: 'closer' }]
    expect(await session.changeScene({ ...anchor, start: 1 })).toBe(true)
    expect(data.anchor!.start).toBe(1)
    expect(data.draft!.scene).toBe('')
    expect(data.draft!.fragments).toHaveLength(1)
    expect(data.draft!.subjects.map(item => [item.id, item.pose])).toEqual([['manual', ''], ['locked', 'old pose']])
    expect(data.draft!.subjects[0].poseEdited).toBeUndefined()
    expect(data.conversation).toEqual([])
})

it('renders a version 3 plan with final block IDs, saved looks, locked blocks and warnings', async () => {
    const lockedPlan = { version: 3 as const, scene: { modifiers: {}, freeTags: {}, notes: '' }, interactions: [],
        subjects: { aria: { modifiers: {}, freeTags: {}, stateIds: ['nude'], notes: { placement: '', action: '' } } } }
    session.data.anchor = anchor
    session.data.draft = { scene: 'old', rendering: '', negative: '', plan: lockedPlan, subjects: [
        block({ id: 'aria', name: 'Aria', pose: 'locked pose', locked: true, sex: 'female' }),
    ] }
    const v3subject = (patch: Record<string, unknown>) => ({ id: '', name: '', aliases: [], kind: 'character', sex: 'male', evidence: '', appearance: '', outfitId: '', clothing: '', state: '',
        stateIds: [], modifiers: {}, freeTags: {}, notes: { placement: '', action: '' }, negative: '', ...patch })
    mocks.request.mockResolvedValueOnce({ type: 'success', result: JSON.stringify({ version: 3, size: '', rendering: '', negative: '',
        scene: { modifiers: { 'framing.crop': ['upper_body'] }, freeTags: { 'scene.location': ['garden'] }, notes: '' },
        subjects: [
            v3subject({ name: 'Seb', evidence: 'pours tea for Seb', modifiers: { 'pose.body': ['standing'], 'pose.legs': ['crossed_legs'] } }),
            v3subject({ name: 'Ghost', sex: 'unknown', evidence: 'a ghost watches', appearance: 'pale' }),
        ],
        interactions: [{ source: 0, target: 1, acts: ['headpat'], description: 'One pats the other.', sourceAction: 'pats', targetAction: 'is patted' }] }) })
    expect(await session.prepare(anchor)).toBe(true)
    const system = mocks.request.mock.calls[0][0].formated[0].content
    expect(system).toContain('version 3 scene-plan')
    expect(system).toContain('gaze.direction (subject, up to 1')
    const draft = session.data.draft!
    expect(draft.subjects.map(item => item.id)).toEqual(['aria', 'seb', expect.any(String)])
    const [aria, seb, ghost] = draft.subjects
    expect(aria).toMatchObject({ pose: 'locked pose', locked: true })
    // upper_body hides the legs, so crossed_legs is dropped.
    expect(seb).toMatchObject({ appearance: 'black hair, butler', pose: 'standing, source#headpat\npats' })
    expect(ghost.pose).toBe('target#headpat\nis patted')
    expect(draft.subjects.some(item => 'planKey' in item)).toBe(false)
    expect(draft.scene).toBe('nsfw, upper body, garden\nOne pats the other.')
    expect(Object.keys(draft.plan!.subjects)).toEqual(['aria', 'seb', ghost.id])
    expect(draft.plan!.interactions[0]).toMatchObject({ source: 'seb', target: ghost.id })
    expect(session.state.notice).toContain('성별을 알 수 없는 인물(Ghost)')
    expect(session.state.notice).toContain('등장 근거를 찾지 못한 인물이 있습니다(Ghost)')
    expect(session.state.notice).not.toContain('(Seb)')
})

it('keeps hand-edited text, sex and the stored plan through a revision without sending them to the planner', async () => {
    const storedPlan = { version: 3 as const, scene: { modifiers: {}, freeTags: {}, notes: '' }, subjects: {}, interactions: [] }
    session.data.anchor = anchor
    session.data.draft = { scene: 'my scene', sceneEdited: true, rendering: '', negative: '', plan: storedPlan, subjects: [
        block({ id: 'seb', name: 'Seb', appearance: 'black hair, butler', pose: 'my pose', poseEdited: true, sex: 'male' }),
    ] }
    mocks.request.mockResolvedValueOnce(plan([planned({ name: 'Seb', pose: { tags: 'sitting', placement: '', posture: '', action: '', expression: '', gaze: '' } })]))
    expect(await session.prepare(anchor)).toBe(true)
    const input = JSON.parse(mocks.request.mock.calls[0][0].formated[1].content)
    expect(input.draft).not.toHaveProperty('plan')
    expect(input.draft).not.toHaveProperty('sceneEdited')
    expect(input.draft.subjects[0]).not.toHaveProperty('poseEdited')
    expect(input.draft.subjects[0]).toMatchObject({ id: 'seb', sex: 'male' })
    expect(session.data.draft).toMatchObject({ scene: 'my scene', sceneEdited: true })
    expect(session.data.draft!.subjects[0]).toMatchObject({ id: 'seb', pose: 'my pose', poseEdited: true, sex: 'male' })
    expect(session.data.previousDraft?.plan).toEqual(storedPlan)
    await session.restoreDraft()
    expect(session.data.draft!.plan).toEqual(storedPlan)
})

it('plans from user blocks, fills saved looks over model text and never registers new identities', async () => {
    session.data.anchor = anchor
    session.data.draft = { scene: '', rendering: '', negative: '', subjects: [block({ id: 'seb', name: 'Seb', appearance: 'black hair, butler', manual: true })] }
    mocks.request.mockResolvedValueOnce(plan([
        planned({ name: 'Seb', appearance: 'paraphrased look', pose: { tags: 'standing', placement: '', posture: '', action: '', expression: '', gaze: '' } }),
        planned({ name: 'Stranger', appearance: 'red coat' }),
    ]))
    expect(await session.prepare(anchor)).toBe(true)
    const input = JSON.parse(mocks.request.mock.calls[0][0].formated[1].content)
    expect(input.draft.subjects[0]).toMatchObject({ id: 'seb', userAdded: true })
    expect(input.draft.subjects[0]).not.toHaveProperty('manual')
    const [seb, stranger] = session.data.draft!.subjects
    expect(seb).toMatchObject({ id: 'seb', appearance: 'black hair, butler', manual: true, presetMatch: 'name' })
    expect(stranger).toMatchObject({ name: 'Stranger', appearance: 'red coat' })
    expect(session.bot.identities.map(item => item.id)).toEqual(['seb', 'blank-aria'])
})

it('notes when a planned character matches a global preset this bot has not reflected', async () => {
    session.data.anchor = anchor
    mocks.request.mockResolvedValueOnce(plan([planned({ name: '아리아', appearance: 'guess' })]))
    expect(await session.prepare(anchor)).toBe(true)
    expect(session.state.notice).toContain('글로벌 캐릭터와 이름이 같은 인물 1명')
})

it('removes only blank identities with nothing attached after loading every chat', async () => {
    const character = session.character
    character.bardPainter!.identities.push({ id: 'noted', name: 'Noted', aliases: [], appearance: '', note: 'sister' }, { id: 'worn', name: 'Worn', aliases: [], appearance: '' }, { id: 'remote', name: 'Remote', aliases: [], appearance: '' })
    session.data.outfits.push({ id: 'o', subjectId: 'worn', name: 'Coat', clothing: 'coat', state: '' })
    const remote = { id: 'other', _placeholder: true, message: [] }
    const loaded = { id: 'other', message: [], bardPainter: { ...createPainterChatData(), outfits: [{ id: 'r', subjectId: 'remote', name: 'Cape', clothing: 'cape', state: '' }] } }
    character.chats.push(remote as never)
    mocks.hydrate.mockImplementation(async (chats, i) => { if (chats[i] === remote) chats[i] = loaded; return chats[i] })
    expect(await session.pruneBlankIdentities()).toBe(1)
    expect(character.bardPainter!.identities.map(item => item.id)).toEqual(['seb', 'noted', 'worn', 'remote'])
    expect(session.state.notice).toContain('1개')
})

it('cleans up automatically once per bot and stays quiet when loading fails', async () => {
    mocks.hydrate.mockResolvedValueOnce(null)
    await session.autoPruneBlankIdentities()
    expect(session.bot.identities).toHaveLength(2)
    expect(session.state.error).toBe('')
    mocks.hydrate.mockImplementation(async (chats, i) => chats[i])
    await session.autoPruneBlankIdentities()
    expect(session.bot.identities).toHaveLength(2)
})

it('migrates legacy single-field prompts and stores main-panel context choices', async () => {
    mocks.db.characters[0].chats[0].bardPainter!.draft = { scene: 'room', rendering: '', negative: '', subjects: [{ ...block({ id: 'old' }), prompt: 'old look\n\nold coat\n\nsitting' }] }
    open()
    expect(session.data.draft!.subjects[0]).toMatchObject({ appearance: 'old look', clothing: 'old coat', pose: 'sitting', appearanceEdited: true })
    expect(await session.updateContext({ persona: true, before: 4, wikiIds: ['w', 'w'] })).toBe(true)
    expect(session.settings.context).toMatchObject({ persona: true, before: 4, wikiIds: ['w'] })
    expect(session.data.settingsScope).toBe('chat')
})
