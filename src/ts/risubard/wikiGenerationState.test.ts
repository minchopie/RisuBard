import { get } from 'svelte/store'
import { beforeEach, describe, expect, test } from 'vitest'
import {
    beginWikiGeneration,
    cancelChatWikiGeneration,
    cancelWikiGeneration,
    endWikiGeneration,
    isWikiGenerating,
    resetWikiGenerationState,
    wikiCancellationEpoch,
    wikiChatCancellationEpoch,
    wikiGenerationOperations,
} from './wikiGenerationState'

describe('BardWiki generation activity', () => {
    beforeEach(resetWikiGenerationState)

    test('each cancel advances the epoch so queued work can tell it was cancelled', () => {
        const before = wikiCancellationEpoch()
        beginWikiGeneration('automatic:chat')
        cancelWikiGeneration()
        expect(wikiCancellationEpoch()).toBe(before + 1)
        expect(wikiCancellationEpoch()).toBe(before + 1)
        cancelWikiGeneration()
        expect(wikiCancellationEpoch()).toBe(before + 2)
    })

    test('a chat cancel aborts only that chat and advances only its epoch', () => {
        const mine = beginWikiGeneration('analysis:["c","chat-a","m1"]')
        const other = beginWikiGeneration('analysis:["c","chat-b","m1"]')
        const global = wikiCancellationEpoch()
        cancelChatWikiGeneration('["c","chat-a"]', 'analysis:["c","chat-a",')
        expect(mine.aborted).toBe(true)
        expect(other.aborted).toBe(false)
        expect(wikiChatCancellationEpoch('["c","chat-a"]')).toBe(1)
        expect(wikiChatCancellationEpoch('["c","chat-b"]')).toBe(0)
        expect(wikiCancellationEpoch()).toBe(global)
    })

    test('stays active until every distinct operation ends', () => {
        beginWikiGeneration('automatic:chat')
        beginWikiGeneration('reboot:chat')
        beginWikiGeneration('automatic:chat')
        expect(get(isWikiGenerating)).toBe(true)
        expect([...get(wikiGenerationOperations)]).toEqual([
            'automatic:chat', 'reboot:chat',
        ])
        endWikiGeneration('automatic:chat')
        expect(get(isWikiGenerating)).toBe(true)
        endWikiGeneration('reboot:chat')
        expect(get(isWikiGenerating)).toBe(false)
    })

    test('aborts every active operation and waits for their cleanup', () => {
        const automatic = beginWikiGeneration('automatic:chat')
        const command = beginWikiGeneration('command:chat')

        cancelWikiGeneration()

        expect(automatic.aborted).toBe(true)
        expect(command.aborted).toBe(true)
        expect(get(isWikiGenerating)).toBe(true)
        endWikiGeneration('automatic:chat')
        endWikiGeneration('command:chat')
        expect(get(isWikiGenerating)).toBe(false)
    })
})
