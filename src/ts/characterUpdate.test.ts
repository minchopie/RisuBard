import { describe, expect, test } from 'vitest'
import type { character, loreBook } from './storage/database.svelte'
import type { RisuModule } from './process/modules'
import {
    BOT_LINEAGE_KEY, MODULE_UPDATE, applyUpdate, baseSnapshot, findModuleUpdateCandidates, planUpdate, applyCharacterUpdate, botNameKey, findUpdateCandidates, planCharacterUpdate, summarizePlan,
    unresolvedItems, updateBaseSnapshot,
} from './characterUpdate'

const lore = (comment: string, content: string, extra: Partial<loreBook> = {}): loreBook => ({
    key: comment.toLowerCase(), secondkey: '', insertorder: 100, comment, content, mode: 'normal', alwaysActive: false, selective: false, ...extra,
})

function bot(overrides: Partial<character> = {}): character {
    return {
        chaId: 'installed', name: 'Aria', desc: 'desc', firstMessage: 'Hello', notes: '', chats: [{ id: 'chat', message: [] } as any],
        chatFolders: [], chatPage: 0, viewScreen: 'none', bias: [], emotionImages: [], globalLore: [], sdData: [], customscript: [],
        triggerscript: [], utilityBot: false, exampleMessage: '', creatorNotes: '', systemPrompt: '', postHistoryInstructions: '',
        alternateGreetings: [], tags: [], creator: 'maker', characterVersion: '1', personality: '', scenario: '', firstMsgIndex: -1,
        replaceGlobalNote: '', additionalText: '', extentions: {},
        ...overrides,
    } as character
}

describe('finding the installed bot', () => {
    test('strips version marks and the duplicate-install suffix from names', () => {
        expect(botNameKey('Aria v1.2')).toBe('aria')
        expect(botNameKey('Aria (2)')).toBe('aria')
        expect(botNameKey('ARIA - ver 3')).toBe('aria')
        expect(botNameKey('Aria [v1.0] 버전 2')).toBe('aria')
        expect(botNameKey('아리아 1.3.0')).toBe('아리아')
    })

    test('ranks the same RisuRealm item and bot id above a matching name', () => {
        const installed = [
            bot({ chaId: 'name', name: 'Aria v1' }),
            bot({ chaId: 'realm', name: 'Different title', extentions: { risuRealmImportId: 'r1' } }),
            bot({ chaId: 'lineage', name: 'Renamed', creator: 'other', extentions: { [BOT_LINEAGE_KEY]: 'origin' } }),
        ]
        const incoming = bot({ chaId: 'new', name: 'Aria v2', extentions: { risuRealmImportId: 'r1', [BOT_LINEAGE_KEY]: 'origin' } })
        expect(findUpdateCandidates(installed, incoming).map(candidate => [candidate.id, candidate.reason])).toEqual([
            ['realm', 'realm'], ['lineage', 'lineage'], ['name', 'name'],
        ])
    })

    test('treats the original bot whose chaId is the lineage id as the same bot', () => {
        const [candidate] = findUpdateCandidates([bot({ chaId: 'origin', name: 'Old', creator: 'x' })],
            bot({ chaId: 'new', name: 'New', creator: 'y', extentions: { [BOT_LINEAGE_KEY]: 'origin' } }))
        expect(candidate).toMatchObject({ id: 'origin', reason: 'lineage' })
    })

    test('matches by creator and shared lore titles when the name changed', () => {
        const titles = ['Town', 'Castle', 'Forest'].map(title => lore(title, ''))
        const [candidate] = findUpdateCandidates([bot({ name: 'Old name', globalLore: titles, firstMessage: 'a' })],
            bot({ chaId: 'new', name: 'New name', globalLore: titles, firstMessage: 'b' }))
        expect(candidate.reason).toBe('content')
    })

    test('a similar name alone, trashed bots and group chats never open the dialog', () => {
        expect(findUpdateCandidates([bot({ name: 'Aria Night' })], bot({ chaId: 'new', name: 'Aria', creator: 'other' }))).toEqual([])
        expect(findUpdateCandidates([bot({ trashTime: 1 })], bot({ chaId: 'new' }))).toEqual([])
        expect(findUpdateCandidates([{ ...bot(), type: 'group' } as any], bot({ chaId: 'new' }))).toEqual([])
    })

    test('lists similar names after a real match', () => {
        const result = findUpdateCandidates([bot({ chaId: 'similar', name: 'Aria Night', creator: 'other' }), bot({ chaId: 'same' })], bot({ chaId: 'new' }))
        expect(result.map(candidate => candidate.reason)).toEqual(['name', 'similar'])
    })
})

describe('three-way update plan', () => {
    test('takes author-only changes, keeps user-only changes and asks about conflicts', () => {
        const base = bot({ desc: 'base desc', firstMessage: 'base hello', scenario: 'base scene' })
        const mine = bot({ desc: 'base desc', firstMessage: 'my hello', scenario: 'my scene' })
        const theirs = bot({ chaId: 'new', desc: 'new desc', firstMessage: 'base hello', scenario: 'new scene' })
        const plan = planCharacterUpdate(mine, theirs, updateBaseSnapshot(base))
        const byField = Object.fromEntries(plan.items.map(item => [item.field, [item.status, item.choice]]))
        expect(byField).toEqual({ desc: ['update', 'theirs'], firstMessage: ['mine', 'mine'], scenario: ['conflict', null] })
        expect(unresolvedItems(plan).map(item => item.field)).toEqual(['scenario'])

        const merged = applyCharacterUpdate(mine, theirs, plan, { scenario: 'theirs' })
        expect(merged).toMatchObject({ chaId: 'installed', desc: 'new desc', firstMessage: 'my hello', scenario: 'new scene' })
        expect(merged.chats).toBe(mine.chats)
    })

    test('requires a choice for every unresolved item', () => {
        const plan = planCharacterUpdate(bot({ desc: 'a' }), bot({ desc: 'b' }), updateBaseSnapshot(bot({ desc: 'c' })))
        expect(() => applyCharacterUpdate(bot({ desc: 'a' }), bot({ desc: 'b' }), plan)).toThrow()
    })

    test('without a base every difference needs a choice', () => {
        const plan = planCharacterUpdate(bot({ desc: 'mine' }), bot({ desc: 'theirs', firstMessage: 'Hello' }), null)
        expect(plan.hasBase).toBe(false)
        expect(plan.items.map(item => [item.field, item.status, item.choice])).toEqual([['desc', 'differs', null]])
        expect(summarizePlan(plan).unresolved).toBe(1)
        expect(summarizePlan(plan, { desc: 'mine' }).unresolved).toBe(0)
    })

    test('never touches chats, notes and other personal fields', () => {
        const mine = bot({ notes: 'my notes', chatPage: 3, scriptstate: { hp: 3 }, ttsMode: 'vits' })
        const theirs = bot({ chaId: 'new', notes: '', chatPage: 0, chats: [], ttsMode: 'normal', desc: 'changed' })
        const plan = planCharacterUpdate(mine, theirs, updateBaseSnapshot(bot()))
        expect(plan.items.map(item => item.field)).toEqual(['desc'])
        const merged = applyCharacterUpdate(mine, theirs, plan)
        expect(merged).toMatchObject({ chaId: 'installed', notes: 'my notes', chatPage: 3, scriptstate: { hp: 3 }, ttsMode: 'vits', desc: 'changed' })
    })

    test('ignores lore ids and caches that differ between two installs of one card', () => {
        const mine = bot({ globalLore: [lore('Town', 'same', { id: 'a', loreCache: { key: 'x', data: [] } })] })
        const theirs = bot({ globalLore: [lore('Town', 'same', { id: 'b' })] })
        expect(planCharacterUpdate(mine, theirs, null).items).toEqual([])
    })

    test('merges lorebook entries one by one and keeps entries the user added in place', () => {
        const base = [lore('Town', 'old town'), lore('Castle', 'castle'), lore('Gone', 'gone')]
        const mine = [lore('Town', 'old town', { id: 'town-id' }), lore('My note', 'mine', { id: 'note' }), lore('Castle', 'my castle'), lore('Gone', 'gone')]
        const theirs = [lore('Town', 'new town'), lore('Castle', 'castle'), lore('Fresh', 'fresh')]
        const plan = planCharacterUpdate(bot({ globalLore: mine }), bot({ globalLore: theirs }), updateBaseSnapshot(bot({ globalLore: base })))
        expect(plan.items.map(item => [(item.mine ?? item.theirs as any).comment, item.status])).toEqual([
            ['Town', 'update'], ['Castle', 'mine'], ['Fresh', 'added'], ['My note', 'mineOnly'], ['Gone', 'removed'],
        ])
        const merged = applyCharacterUpdate(bot({ globalLore: mine }), bot({ globalLore: theirs }), plan)
        expect(merged.globalLore.map(entry => [entry.comment, entry.content])).toEqual([
            ['Town', 'new town'], ['My note', 'mine'], ['Castle', 'my castle'], ['Fresh', 'fresh'],
        ])
        // The updated entry keeps the installed id so BardLore links survive.
        expect(merged.globalLore[0].id).toBe('town-id')
    })

    test('a regex the user deleted stays deleted unless the author changed it', () => {
        const script = (comment: string, out: string) => ({ comment, in: comment, out, type: 'editoutput' })
        const base = bot({ customscript: [script('a', '1'), script('b', '1')] })
        const mine = bot({ customscript: [] })
        const theirs = bot({ customscript: [script('a', '1'), script('b', '2')] })
        const plan = planCharacterUpdate(mine, theirs, updateBaseSnapshot(base))
        expect(plan.items.map(item => [(item.theirs as any).comment, item.status])).toEqual([['a', 'mine'], ['b', 'conflict']])
        const merged = applyCharacterUpdate(mine, theirs, plan, { [plan.items[1].id]: 'theirs' })
        expect(merged.customscript.map(entry => entry.comment)).toEqual(['b'])
    })

    test('a named regex whose pattern the author changed is one updated item', () => {
        const base = bot({ customscript: [{ comment: 'bold', in: '**', out: '<b>', type: 'editdisplay' }] })
        const theirs = bot({ customscript: [{ comment: 'bold', in: '\\*\\*', out: '<b>', type: 'editdisplay' }] })
        const plan = planCharacterUpdate(base, theirs, updateBaseSnapshot(base))
        expect(plan.items.map(item => item.status)).toEqual(['update'])
    })

    test('keeps realm and bot ids from the card without asking', () => {
        const mine = bot({ extentions: { custom: 1 } })
        const theirs = bot({ extentions: { custom: 1, risuRealmImportId: 'r', [BOT_LINEAGE_KEY]: 'id' } })
        const plan = planCharacterUpdate(mine, theirs, null)
        expect(plan.items).toEqual([])
        expect(applyCharacterUpdate(mine, theirs, plan).extentions).toEqual({ custom: 1, risuRealmImportId: 'r', [BOT_LINEAGE_KEY]: 'id' })
    })

    test('the base snapshot leaves out personal fields', () => {
        const snapshot = updateBaseSnapshot(bot({ notes: 'secret', desc: 'card' }))
        expect(snapshot).not.toHaveProperty('chats')
        expect(snapshot).not.toHaveProperty('notes')
        expect(snapshot).not.toHaveProperty('chaId')
        expect(snapshot.desc).toBe('card')
    })
})

describe('module updates', () => {
    const mod = (overrides: Partial<RisuModule> = {}): RisuModule => ({ id: 'installed', name: 'World pack', description: '', lorebook: [], ...overrides })
    const assets = (count: number, from = 0) => Array.from({ length: count }, (_, i) => [`a${i + from}`, `assets/hash${i + from}.png`, 'png'] as [string, string, string])

    test('finds the module by file id lineage, name, namespace or shared assets', () => {
        const installed = [
            mod({ id: 'x', name: 'Other', updateLineage: 'file-id' }),
            mod({ id: 'n', name: 'World pack v1' }),
            mod({ id: 's', name: 'Renamed', namespace: 'world' }),
            mod({ id: 'a', name: 'Art', assets: assets(6) }),
            mod({ id: 'persona', name: 'World pack' , updateBackupOf: 'n' }),
            mod({ id: '$embedded', name: 'World pack' }),
        ]
        const incoming = mod({ id: 'new', name: 'World pack v2', updateLineage: 'file-id', namespace: 'world', assets: assets(6, 3) })
        expect(findModuleUpdateCandidates(installed, incoming).map(candidate => [candidate.id, candidate.reason])).toEqual([
            ['x', 'lineage'], ['n', 'name'], ['s', 'namespace'], ['a', 'assets'],
        ])
    })

    test('the module installed from a file is the lineage of the next version of that file', () => {
        const [candidate] = findModuleUpdateCandidates([mod({ id: 'file-id', name: 'Unrelated' })], mod({ id: 'new', name: 'Pack', updateLineage: 'file-id' }))
        expect(candidate).toMatchObject({ id: 'file-id', reason: 'lineage' })
    })

    test('keeps the module id and merges lore, regex and trigger entry by entry', () => {
        const lore = (comment: string, content: string) => ({ key: comment, secondkey: '', insertorder: 1, comment, content, mode: 'normal' as const, alwaysActive: false, selective: false })
        const base = mod({ lorebook: [lore('A', 'a'), lore('B', 'b')], description: 'old' })
        const mine = mod({ lorebook: [lore('A', 'a'), lore('B', 'my b'), lore('Mine', 'm')], description: 'old', updateBase: 'assets/base.json' })
        const theirs = mod({ id: 'new', lorebook: [lore('A', 'new a'), lore('B', 'b')], description: 'new', updateLineage: 'file' })
        const plan = planUpdate(MODULE_UPDATE, mine, theirs, baseSnapshot(MODULE_UPDATE, base))
        expect(plan.items.map(item => [item.field, item.status])).toEqual([
            ['description', 'update'], ['lorebook', 'update'], ['lorebook', 'mine'], ['lorebook', 'mineOnly'],
        ])
        const merged = applyUpdate(MODULE_UPDATE, mine, theirs, plan)
        expect(merged).toMatchObject({ id: 'installed', description: 'new', updateLineage: 'file', updateBase: 'assets/base.json' })
        expect(merged.lorebook!.map(entry => entry.content)).toEqual(['new a', 'my b', 'm'])
    })
})
describe('editing while comparing', () => {
    test('an edited value replaces the item, and a lore edit keeps the installed id', () => {
        const lore = (content: string, id?: string) => ({ key: 'town', secondkey: '', insertorder: 1, comment: 'Town', content, mode: 'normal' as const, alwaysActive: false, selective: false, ...(id ? { id } : {}) })
        const mine = bot({ desc: 'translated', globalLore: [lore('번역한 마을', 'kept-id')] })
        const theirs = bot({ desc: 'new original', globalLore: [lore('new town text')] })
        const base = updateBaseSnapshot(bot({ desc: 'old original', globalLore: [lore('old town text')] }))
        const plan = planCharacterUpdate(mine, theirs, base)
        const loreItem = plan.items.find(item => item.field === 'globalLore')!
        expect(loreItem).toMatchObject({ status: 'conflict', baseKnown: true })
        expect((loreItem.base as any).content).toBe('old town text')
        const merged = applyCharacterUpdate(mine, theirs, plan, {
            desc: { value: '번역 + 새 설정' },
            [loreItem.id]: { value: { ...(loreItem.mine as object), content: '번역한 마을 + 광장' } },
        })
        expect(merged.desc).toBe('번역 + 새 설정')
        expect(merged.globalLore[0]).toMatchObject({ id: 'kept-id', content: '번역한 마을 + 광장' })
    })
})