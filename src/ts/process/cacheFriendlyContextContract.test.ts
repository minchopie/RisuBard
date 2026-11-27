import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import ts from 'typescript'
import * as narrativeContext from '../risubard/narrativeContext'
import { createRequiredWikiMessage } from '../risubard/requiredWikiContext'
import type { ContextSource } from '../../../packages/risubard-core/src/contextCompiler'
import type { OpenAIChat } from './index.svelte'
import type { RequestInjectionSource } from '../status/requestStatus'
import {
    createNarrativeSourcesPrompt, insertBeforeLatestUserMessage,
    mergeNarrativeContextWithStaticPrompt, selectPromptedNarrativeSources,
} from '../risubard/narrativeContext'

const source = readFileSync('src/ts/process/index.svelte.ts', 'utf8').replace(/\r\n/g, '\n')

describe('assembled cache-friendly wiki evidence rules', () => {
    const makePrompt = (id: string, body: string, guide = '', budget?: number) => createNarrativeSourcesPrompt([
        { id, kind: 'memory', role: 'system', content: body, tokens: 4 },
    ], '', budget, guide)!

    test('preserves zero/one message fallback and removes only the second exact complete prefix', () => {
        const first: OpenAIChat = { role: 'system', content: makePrompt('required', 'REQUIRED\r\n가', 'GUIDE\nbytes'), removable: false }
        const second: OpenAIChat = { role: 'system', content: makePrompt('optional', 'OPTIONAL\r\n나'), requestStatusSources: [{ kind: 'wiki', role: 'system', content: 'OPTIONAL\r\n나' }] }
        const original = structuredClone([first, second])
        const prefix = second.content.slice(0, second.content.indexOf('Relevant narrative memory:'))
        expect(narrativeContext.deduplicateNarrativeEvidenceRules([])).toEqual([])
        expect(narrativeContext.deduplicateNarrativeEvidenceRules([first])).toEqual([first])
        expect(narrativeContext.deduplicateNarrativeEvidenceRules([second])).toEqual([second])
        const output = narrativeContext.deduplicateNarrativeEvidenceRules([first, second])
        expect(output[0]).toBe(first)
        expect(output[1]).toEqual({ ...second, content: second.content.slice(prefix.length) })
        expect(output[1].requestStatusSources).toBe(second.requestStatusSources)
        expect([first, second]).toEqual(original)
        expect(prefix).toMatch(/^Narrative continuity:/)
        expect(output[0].content).toContain('GUIDE\nbytes')
    })

    test('keeps custom or partially truncated rules and preserves an evidence suffix cut by the existing budget', () => {
        const full = makePrompt('a', 'evidence '.repeat(100))
        const prefixLength = full.indexOf('Relevant narrative memory:')
        const make = (content: string) => ({ role: 'system', content })
        const first = make(full)
        for (const text of [full.slice(0, prefixLength - 3), full.slice(0, prefixLength), full.replace('Narrative continuity:', 'Custom continuity:')]) {
            expect(narrativeContext.deduplicateNarrativeEvidenceRules([first, make(text)])[1].content).toBe(text)
        }
        const cut = makePrompt('b', 'b'.repeat(1000), '', prefixLength + 80)
        const output = narrativeContext.deduplicateNarrativeEvidenceRules([first, make(cut)])
        expect(output[1].content).toBe(cut.slice(prefixLength))
        // A lone partial prefix cannot authorize stripping the complete rules from the next message.
        expect(narrativeContext.deduplicateNarrativeEvidenceRules([make(full.slice(0, 40)), first])[1]).toBe(first)
    })

    test.each([true, false])('counts the final messages and preserves evidence (cache-friendly=%j)', async (enabled) => {
        const requiredWikiSources: ContextSource[] = [{ id: 'required', kind: 'memory', role: 'system', content: 'REQUIRED_BYTES\r\n가', tokens: 4 }]
        const optional: ContextSource[] = [{ id: 'optional', kind: 'memory', role: 'system', content: 'OPTIONAL_BYTES\r\n나', tokens: 4 }]
        const current = { role: 'system', content: createNarrativeSourcesPrompt(optional)! }
        const start = source.indexOf('const requiredWikiMessage = createRequiredWikiMessage(')
        const end = source.indexOf('let supaMemoryCardUsed', start)
        expect(start).toBeGreaterThan(-1)
        expect(end).toBeGreaterThan(start)
        const assembly = ts.transpileModule(source.slice(start, end), {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText
        const run = new Function('createRequiredWikiMessage', 'deduplicateNarrativeEvidenceRules', 'cacheFriendlyNarrativeMessage', 'requiredWikiSources', 'cacheFriendlyContext', `return (async () => {
            let currentTokens = 0;
            const responseWikiPromptGuide = 'CUSTOM_GUIDE_BYTES';
            const tokenizer = { tokenizeChat: async message => message.content.length };
            ${assembly}
            return { messages: cacheFriendlyContext ? cacheFriendlyWikiMessages : [requiredWikiMessage, cacheFriendlyNarrativeMessage], currentTokens };
        })()`)
        const output = await run(createRequiredWikiMessage,
            (narrativeContext as unknown as Record<string, unknown>).deduplicateNarrativeEvidenceRules,
            current, requiredWikiSources, enabled)
        expect(output.messages).toHaveLength(2)
        expect(output.messages.map((m: { content: string }) => m.content).join('\n').match(/^Narrative continuity:/gm)).toHaveLength(enabled ? 1 : 2)
        expect(output.messages[0].content).toContain('REQUIRED_BYTES\r\n가')
        expect(output.messages[0].content).toContain('CUSTOM_GUIDE_BYTES')
        expect(output.messages[1].content).toContain('OPTIONAL_BYTES\r\n나')
        expect(output.currentTokens).toBe(output.messages.reduce((n: number, m: { content: string }) => n + m.content.length, 0))
        expect(source).toContain('formated = insertBeforeLatestUserMessage(formated, cacheFriendlyWikiMessages)')
        expect(source).toContain('promptBodyformatedForChatStore = insertBeforeLatestUserMessage(promptBodyformatedForChatStore, cacheFriendlyWikiMessages)')
    })
})
const start = source.indexOf('const currentPrompt = narrativeContext.sourceChanged')
const end = source.indexOf('\n            }\n            }\n        }\n        catch', start) + '\n            }'.length
expect(start).toBeGreaterThan(-1)
expect(end).toBeGreaterThan(start)
const composition = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const compose = new Function('input', 'createNarrativeSourcesPrompt', 'mergeNarrativeContextWithStaticPrompt', 'selectPromptedNarrativeSources', `
    const { cacheFriendlyContext, narrativeContext, sources, requiredWikiSources, responseWikiPromptGuide } = input;
    let { baseDescriptionPrompt, afterDescriptionPrompts } = input;
    const unformated = { description: input.descriptionPrompts };
    const lorepmt = { actives: input.activeLorePrompts };
    const narrativeContextObservation = {}, currentChar = { name: 'test character' };
    const language = { risuBardWikiPrompt: { responseGuideInjection: 'guide' } };
    const narrativeSourceDisplayName = (id) => id;
    const setRequestStatusSource = () => {};
    let cacheFriendlyNarrativeMessage = null;
    ${composition}
    return { baseDescriptionPrompt, descriptionPrompts: unformated.description,
        afterDescriptionPrompts, activeLorePrompts: lorepmt.actives, cacheFriendlyNarrativeMessage };
`)

describe('cache-friendly original prompt preservation', () => {
    // An optional read-only real card checks the same contract without shipping personal card data.
    const card: { description: string, character_book: { entries: Array<{ constant?: boolean, content: string }> } } = process.env.RISUBARD_CACHE_CARD_FIXTURE
        ? JSON.parse(readFileSync(resolve(process.cwd(), process.env.RISUBARD_CACHE_CARD_FIXTURE), 'utf8')).data
        : { description: 'ORIGINAL_DESCRIPTION_SENTINEL '.repeat(750), character_book: {
            entries: Array.from({ length: 19 }, (_, index) => ({ constant: true, content: `@@position after_desc\nORIGINAL_LORE_${index}` })),
        } }
    const original: OpenAIChat = { role: 'system', content: card.description }
    const lore = card.character_book.entries.filter((entry) => entry.constant)
        .map((entry): OpenAIChat => ({ role: 'system', content: entry.content }))
    const makeInput = (enabled: boolean, baseline: string | null, sourceChanged = false) => ({
        cacheFriendlyContext: enabled,
        narrativeContext: { baseline, sourceChanged },
        sources: [{ id: 'chat:wiki:1', kind: 'memory', role: 'system', content: 'dynamic wiki evidence', tokens: 4 }] satisfies ContextSource[],
        requiredWikiSources: [], responseWikiPromptGuide: 'wiki guide',
        baseDescriptionPrompt: original, descriptionPrompts: [original],
        afterDescriptionPrompts: [], activeLorePrompts: lore,
    })
    const run = (input: ReturnType<typeof makeInput>) => compose(
        structuredClone(input), createNarrativeSourcesPrompt,
        mergeNarrativeContextWithStaticPrompt, selectPromptedNarrativeSources,
    )

    test.each(['LOSSY_BASELINE_SENTINEL', null])('keeps description and all 19 constant lore texts with baseline %j', (baseline) => {
        expect(lore).toHaveLength(19)
        expect(lore.every((entry: { content: string }) => entry.content.startsWith('@@position after_desc\n'))).toBe(true)
        const output = run(makeInput(true, baseline))
        expect(output.baseDescriptionPrompt).toEqual(original)
        expect(output.descriptionPrompts).toEqual([original])
        expect(output.activeLorePrompts).toEqual(lore)
        expect(output.afterDescriptionPrompts).toEqual([])
        expect(output.cacheFriendlyNarrativeMessage.content).toContain('dynamic wiki evidence')
        expect(JSON.stringify(output)).not.toContain('LOSSY_BASELINE_SENTINEL')
        const messages = [original, ...lore, { role: 'user', content: 'latest user' }]
        const body = { messages: insertBeforeLatestUserMessage(messages, [output.cacheFriendlyNarrativeMessage]) }
        expect(body.messages.slice(0, 20)).toEqual(messages.slice(0, 20))
        expect(body.messages.at(-2)?.content).toContain('dynamic wiki evidence')
        expect(body.messages.at(-1)?.content).toBe('latest user')
    })

    test.each(['LOSSY_BASELINE_SENTINEL', null])('keeps cache-off composition identical to the existing merge contract with baseline %j', (baseline) => {
        const input = makeInput(false, baseline)
        const output = run(input)
        const prompt = createNarrativeSourcesPrompt(input.sources, baseline ?? '', undefined, input.responseWikiPromptGuide)!
        const requestStatusSources: RequestInjectionSource[] = [
            ...(baseline ? [{ kind: 'character' as const, name: 'test character', role: 'system' as const, content: baseline }] : []),
            { kind: 'wiki', name: 'guide', role: 'system', content: input.responseWikiPromptGuide },
            { kind: 'wiki', name: 'chat:wiki:1', role: 'system', content: input.sources[0].content },
        ]
        const expected = mergeNarrativeContextWithStaticPrompt<OpenAIChat, OpenAIChat>({
            currentContext: { role: 'system', content: prompt, requestStatusSources }, baseline,
            baseDescription: original, descriptionPrompts: [original],
            afterDescriptionPrompts: [], activeLorePrompts: lore,
        })
        expect(JSON.stringify(output)).toBe(JSON.stringify({
            baseDescriptionPrompt: expected.baseDescription,
            descriptionPrompts: expected.descriptionPrompts,
            afterDescriptionPrompts: expected.afterDescriptionPrompts,
            activeLorePrompts: expected.activeLorePrompts,
            cacheFriendlyNarrativeMessage: null,
        }))
    })

    test('preserves the sourceChanged gate and both outgoing/preview memory insertion paths', () => {
        const output = run(makeInput(true, 'LOSSY_BASELINE_SENTINEL', true))
        expect(output.descriptionPrompts).toEqual([original])
        expect(output.activeLorePrompts).toEqual(lore)
        expect(output.cacheFriendlyNarrativeMessage).toBeNull()
        expect(source).toContain('formated = insertBeforeLatestUserMessage(formated, cacheFriendlyWikiMessages)')
        expect(source).toContain('promptBodyformatedForChatStore = insertBeforeLatestUserMessage(promptBodyformatedForChatStore, cacheFriendlyWikiMessages)')
    })
})
