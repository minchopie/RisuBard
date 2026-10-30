import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import ts from 'typescript'
import type { ContextSource } from '../../../packages/risubard-core/src/contextCompiler'
import type { OpenAIChat } from './index.svelte'
import type { RequestInjectionSource } from '../status/requestStatus'
import {
    createNarrativeSourcesPrompt, insertBeforeLatestUserMessage,
    mergeNarrativeContextWithStaticPrompt, selectPromptedNarrativeSources,
} from '../risubard/narrativeContext'

const source = readFileSync('src/ts/process/index.svelte.ts', 'utf8').replace(/\r\n/g, '\n')
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
