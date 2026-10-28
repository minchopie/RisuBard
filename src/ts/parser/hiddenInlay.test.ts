import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, test } from 'vitest'

test('streaming updates register each unresolved inlay only once', () => {
    const source = readFileSync('src/ts/parser/parser.svelte.ts', 'utf8')
    const start = source.indexOf('export function resolveInlayPlaceholders')
    const code = ts.transpileModule(source.slice(start, source.indexOf('export interface simpleCharacterArgument', start))
        .replace('export function', 'function'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    const observed: Element[] = []
    const context: any = {
        observedInlayPlaceholders: new WeakSet(),
        IntersectionObserver: class {
            observe(element: Element) { observed.push(element) }
        },
    }
    runInNewContext(code, context)
    const root = document.createElement('p')
    root.innerHTML = '<span data-inlay-id="pending"></span>'
    context.resolveInlayPlaceholders(root)
    context.resolveInlayPlaceholders(root)
    expect(observed).toEqual([root.firstElementChild])
})

test('hiding an inlay preserves its DOM slot for incremental streaming updates', async () => {
    const source = readFileSync('src/ts/parser/parser.svelte.ts', 'utf8')
    const start = source.indexOf('async function processInlayQueue()')
    const code = ts.transpileModule(source.slice(start, source.indexOf('export function resolveInlayPlaceholders', start)), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText
    const root = document.createElement('p')
    root.innerHTML = '<span data-inlay-id="hidden"></span>Text'
    const text = root.lastChild
    const context: any = {
        document, console, isResolvingPlaceholders: false,
        resolveQueue: [{ el: root.firstChild, id: 'hidden', type: 'inlay' }],
        blobUrlCache: new Map([['hidden', { type: 'image', url: '/hidden.png' }]]),
        DBState: { db: { hideAllImages: true } },
    }
    runInNewContext(code, context)
    await context.processInlayQueue()
    expect(root.childNodes).toHaveLength(2)
    expect(root.firstChild?.nodeType).toBe(Node.COMMENT_NODE)
    expect(root.lastChild).toBe(text)
    expect(root.textContent).toBe('Text')
    expect(root.querySelector('img, [data-inlay-id]')).toBeNull()
})

test('cached and pending inlays carry identical IDs and occurrence indices for targeted removal', () => {
    const source = readFileSync('src/ts/parser/parser.svelte.ts', 'utf8')
    const start = source.indexOf('export function parseInlayAssets')
    const code = ts.transpileModule(source.slice(start, source.indexOf('// Global resolve queue', start))
        .replace('export function', 'function'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    const cache = new Map<string, { type: string, url: string }>()
    const context: any = { blobUrlCache: cache, DBState: { db: {} }, transferMediaScope: () => undefined }
    runInNewContext(code, context)
    const text = '{{inlay::scene}} {{inlayed::scene}} {{inlay::other}}'
    const root = document.createElement('div')
    root.innerHTML = context.parseInlayAssets(text)
    expect(Array.from(root.querySelectorAll('[data-inlay-id]'), el => [el.getAttribute('data-inlay-id'), el.getAttribute('data-inlay-occurrence')]))
        .toEqual([['scene', '0'], ['scene', '1'], ['other', '0']])
    cache.set('scene', { type: 'image', url: '/scene.png' })
    root.innerHTML = context.parseInlayAssets(text)
    expect(Array.from(root.querySelectorAll('img'), el => [el.dataset.inlayImageId, el.dataset.inlayOccurrence]))
        .toEqual([['scene', '0'], ['scene', '1']])
})

test('asynchronous image resolution preserves the selected occurrence metadata', async () => {
    const source = readFileSync('src/ts/parser/parser.svelte.ts', 'utf8')
    const start = source.indexOf('async function processInlayQueue()')
    const code = ts.transpileModule(source.slice(start, source.indexOf('export function resolveInlayPlaceholders', start)), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText
    const root = document.createElement('p')
    root.innerHTML = '<span data-inlay-id="scene" data-inlay-occurrence="2"></span>'
    const context: any = {
        document, console, isResolvingPlaceholders: false,
        resolveQueue: [{ el: root.firstChild, id: 'scene', type: 'inlay' }],
        blobUrlCache: new Map([['scene', { type: 'image', url: '/scene.png' }]]),
        DBState: { db: {} },
    }
    runInNewContext(code, context)
    await context.processInlayQueue()
    expect(root.querySelector('img')?.dataset.inlayImageId).toBe('scene')
    expect(root.querySelector('img')?.dataset.inlayOccurrence).toBe('2')
})
