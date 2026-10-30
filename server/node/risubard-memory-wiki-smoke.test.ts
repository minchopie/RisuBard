import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { describe, expect, test } from 'vitest'
import {
    createStoredResponseMemoryAnalysis,
} from '../../src/ts/risubard/memoryAnalysisClient'
import {
    loadNarrativeMemoryWiki,
} from '../../src/ts/risubard/memoryWiki'
import {
    createNarrativeSourcesPrompt,
    loadNarrativeInquiry,
} from '../../src/ts/risubard/narrativeContext'
import {
    resolveMarkdownWikiWorkspace,
} from './risubard-markdown-wiki'

const require = createRequire(import.meta.url)

async function startMemoryViewServer(service: unknown): Promise<{
    baseUrl: string
    close(): Promise<void>
}> {
    const express = require('express')
    const {
        createRisuBardMemoryJsonParser,
        registerRisuBardMemoryRoutes,
    } = require('./risubard-memory-routes.cjs')
    const app = express()
    app.use(
        '/api/risubard/memory',
        createRisuBardMemoryJsonParser(express)
    )
    registerRisuBardMemoryRoutes(app, {
        auth: async (
            req: { headers: Record<string, unknown> },
            res: {
                status(code: number): { send(body: unknown): void }
            }
        ) => {
            if (req.headers['risu-auth'] === 'smoke-token') return true
            res.status(401).send({ error: 'Unauthorized' })
            return false
        },
        service,
    })
    const server: Server = await new Promise((resolve) => {
        const listening = app.listen(
            0,
            '127.0.0.1',
            () => resolve(listening)
        )
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
        throw new Error('Smoke server did not bind a TCP port')
    }
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve())
        }),
    }
}

function smokeFetch(baseUrl: string): typeof fetch {
    return ((path: string | URL | Request, init?: RequestInit) =>
        fetch(new URL(String(path), baseUrl), init)) as typeof fetch
}

describe('RisuBard Markdown wiki full-stack smoke', () => {
    test('writes .md, displays it, injects it, and reloads it after restart', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const userDataDirectory = await mkdtemp(
            join(tmpdir(), 'risubard-markdown-wiki-smoke-')
        )
        let server: Awaited<ReturnType<typeof startMemoryViewServer>>
            | undefined
        try {
            server = await startMemoryViewServer(
                createRuntimeMemoryService(userDataDirectory)
            )
            const fetchImpl = smokeFetch(server.baseUrl)
            const providerInputs: unknown[] = []
            const analysis = createStoredResponseMemoryAnalysis({
                requestModel: async (request, model) => {
                    providerInputs.push(structuredClone({ request, model }))
                    return {
                        type: 'success',
                        result: JSON.stringify({
                            schemaVersion: 1,
                            title: 'The moon lantern opened the sealed vault',
                            establishedEvents: [
                                '[[The Archivist]] lit the moon lantern, and the sealed vault opened.',
                            ],
                            stateChanges: [],
                            characterKnowledge: [],
                            persistentFacts: [],
                            openContinuity: [],
                            canonicalUpdateCandidates: [],
                        }),
                    }
                },
                fetchImpl,
                createAuth: async () => 'smoke-token',
                onError: (error) => { throw error },
                nativeV2Analysis: true,
            })

            await analysis.confirm({
                characterId: 'character-e2e',
                chatId: 'chat-e2e',
                messages: [
                    {
                        messageId: 'user-e2e',
                        role: 'user',
                        content: 'Light the lantern.',
                    },
                    {
                        messageId: 'assistant-e2e',
                        role: 'assistant',
                        content:
                            'The Archivist lit the moon lantern, opening the sealed vault.',
                    },
                ],
            })

            expect(providerInputs).toHaveLength(1)
            for (const providerInput of providerInputs) {
                expect(providerInput).toMatchObject({
                    model: 'memory',
                    request: {
                        maxTokens: 32_768,
                        temperature: 0,
                    },
                })
                expect(providerInput).toMatchObject({
                    request: { schema: expect.any(String) },
                })
            }

            const view = await loadNarrativeMemoryWiki({
                characterId: 'character-e2e',
                chatId: 'chat-e2e',
                fetchImpl,
                createAuth: async () => 'smoke-token',
            })
            expect(view).toMatchObject({
                mode: 'markdown',
                documents: [expect.objectContaining({
                    title: 'The moon lantern opened the sealed vault',
                    sourceMessageIds: ['user-e2e', 'assistant-e2e'],
                    content: expect.stringContaining('[[The Archivist]]'),
                })],
            })
            if (view.mode !== 'markdown') {
                throw new Error('Expected a Markdown wiki view')
            }

            const workspace = resolveMarkdownWikiWorkspace(
                userDataDirectory,
                'character-e2e',
                'chat-e2e'
            )
            const files = await readdir(workspace.eventsDirectory)
            expect(files).toHaveLength(1)
            const stored = await readFile(
                join(workspace.eventsDirectory, files[0]),
                'utf8'
            )
            expect(stored).toContain('source_messages:')
            expect(stored).toContain('[[The Archivist]]')
            expect(stored).not.toContain('operations:')

            const inquiry = await loadNarrativeInquiry({
                characterId: 'character-e2e',
                chatId: 'chat-e2e',
                currentInput: 'What did the moon lantern open?',
                fetchImpl,
                createAuth: async () => 'smoke-token',
            })
            const sourceId =
                `narrative-memory:wiki:${view.documents[0].relativePath}`
            expect(inquiry.sources).toEqual([
                expect.objectContaining({ id: sourceId }),
            ])
            const prompt = createNarrativeSourcesPrompt(inquiry.sources)
            expect(prompt).toContain(sourceId)
            expect(prompt).toContain('the sealed vault opened')

            await server.close()
            server = undefined
            server = await startMemoryViewServer(
                createRuntimeMemoryService(userDataDirectory)
            )
            const restarted = await loadNarrativeMemoryWiki({
                characterId: 'character-e2e',
                chatId: 'chat-e2e',
                fetchImpl: smokeFetch(server.baseUrl),
                createAuth: async () => 'smoke-token',
            })
            expect(restarted).toEqual(view)
        }
        finally {
            if (server) await server.close()
            await rm(userDataDirectory, { recursive: true, force: true })
        }
    })
})
