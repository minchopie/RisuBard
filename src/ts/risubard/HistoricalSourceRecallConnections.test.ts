import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

describe('historical source recall connections', () => {
    test('searches loaded history outside the response rolling window', () => {
        const source = readFileSync(resolve(
            process.cwd(),
            'src/ts/process/index.svelte.ts'
        ), 'utf8')
        const recallStart = source.indexOf('const historicalOptions =')
        const recallEnd = source.indexOf('const loadInquiry =', recallStart)
        expect(recallStart).toBeGreaterThanOrEqual(0)
        expect(recallEnd).toBeGreaterThan(recallStart)
        const recallCall = source.slice(recallStart, recallEnd)
        const exactRecallCall = source.match(
            /const resolveSources = \(messageIds[\s\S]{0,1600}?\}\)\r?\n/
        )?.[0] ?? ''

        expect(source).toContain('findHistoricalSourceMatches,')
        expect(source).toContain('resolveHistoricalSourceMatchesById,')
        expect(recallCall).toContain('findHistoricalSourceMatches({ ...historicalOptions,')
        expect(recallCall).toContain('mergeHistoricalSourceMatches(')
        expect(source).toContain('sourceMatches: ranked?.sourceMatches ?? historicalMatches,')
        expect(source).toContain('resolveSourceMatches: resolveSources')
        expect(recallCall).toContain('messages: currentChat.message')
        expect(recallCall).toContain('ignoreOocTurns: true')
        expect(recallCall).toContain(
            'inquirySettings.risuBardResponseMessageCount'
        )
        expect(recallCall).not.toContain(
            'inquirySettings.risuBardRecentMessageCount'
        )
        expect(exactRecallCall).toContain('messages: currentChat.message')
        expect(exactRecallCall).toContain('messageIds')
        expect(exactRecallCall).toContain('ignoreOocTurns: true')
        expect(source).toContain('entityHints: lorepmt.bardWikiEntityHints')
        expect(source).toContain(
            'timeoutMs: inquirySettings.risuBardInquiryTimeoutMs'
        )
        expect(source).toContain(
            'fallbackInput: buildBoundedNarrativeInquiryFallback('
        )
        expect(source).toContain(
            'chat.risuBardWikiReboot?.stagingChatId === chatId'
        )
    })
})
