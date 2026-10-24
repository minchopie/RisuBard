import { get } from "svelte/store"
import { parseChatML } from "../parser/chatML";
import { getDatabase, type character, type customscript } from "../storage/database.svelte"
import {
    defaultTranslatorPrompt,
    getCurrentTranslatorPresetFromState,
    type TranslatorPreset,
} from "./presets";
import { globalFetch } from "../globalApi.svelte"
import { notifyError } from "../alert"
import { requestChatData } from "../process/request/request"
import { doingChat, type OpenAIChat } from "../process/index.svelte"
import { applyMarkdownToNode, type simpleCharacterArgument } from "../parser/parser.svelte"
import { selectedCharID } from "../stores.svelte"
import {
    clearPersistentPrefix,
    listPersistentKeys,
    makeHashedStorageKey,
    readPersistentJson,
    readPersistentJsonWithVersion,
    removePersistentKeyConditional,
    writePersistentJson,
    writePersistentJsonConditional,
} from "../storage/persistentKv"
import { getModuleRegexScripts } from "../process/modules"
import { getNodetextToSentence, sleep } from "../util"
import { processScriptFull } from "../process/scripts"
import { playNotificationSound } from '../notificationSound'
import { PrivateMobileGoogleTranslateGate, shouldBatchPrivateMobileGoogleTranslation } from './privateMobileGoogleTranslate'

const mobileGoogleGate = new PrivateMobileGoogleTranslateGate()
const isBardAndroid = () => navigator.userAgent.includes('RisuBardAndroid/')
let googleFallbackNoticeAt = -Infinity

let cache={
    origin: [''],
    trans: ['']
}

let bergamotTranslate: (text: string, from: string, to: string, html?: boolean) => Promise<string>|null = null

const llmTranslateCache = new Map<string, string>()
const llmTranslateCachePrefix = 'cache/llm-translate/'
const llmCacheReadConcurrency = 16

type LLMTranslationCachePayload = { key: string, value: string }
type VersionedLLMTranslationCachePayload = LLMTranslationCachePayload & { etag: string }
type PersistentLLMTranslationCacheRow = VersionedLLMTranslationCachePayload & { storageKey: string }
type LLMCachePublicationToken = { globalGeneration: number, keyGeneration: number }
type LLMCacheStorageIndex = { generation: number, locations: Map<string, string[]> }

let llmCacheGlobalGeneration = 0
let llmCacheMutationGeneration = 0
const llmCacheKeyGenerations = new Map<string, number>()
const llmCacheMutationQueues = new Map<string, Promise<unknown>>()
let llmCacheStorageIndexGeneration = 0
let llmCacheStorageIndex: LLMCacheStorageIndex | null = null
let llmCacheStorageIndexBuild: Promise<LLMCacheStorageIndex> | null = null
let llmCacheClearBarrier = Promise.resolve()
let activeLLMCacheClear: Promise<void> | null = null

async function readLLMCachePayload(storageKey: string): Promise<LLMTranslationCachePayload | null> {
    try {
        const payload = await readPersistentJson<{ key?: unknown, value?: unknown }>(storageKey)
        if (!payload || typeof payload.key !== 'string' || typeof payload.value !== 'string') {
            return null
        }
        return { key: payload.key, value: payload.value }
    } catch {
        return null
    }
}

async function readVersionedLLMCachePayload(
    storageKey: string,
): Promise<VersionedLLMTranslationCachePayload | null> {
    try {
        const { value: payload, etag } = await readPersistentJsonWithVersion<{
            key?: unknown,
            value?: unknown,
        }>(storageKey)
        if (!payload || typeof payload.key !== 'string' || typeof payload.value !== 'string' || !etag) {
            return null
        }
        return { key: payload.key, value: payload.value, etag }
    } catch {
        return null
    }
}

async function readPersistentLLMCacheRows(): Promise<PersistentLLMTranslationCacheRow[]> {
    const storageKeys = (await listPersistentKeys(llmTranslateCachePrefix)).sort()
    const rows: PersistentLLMTranslationCacheRow[] = []
    for (let start = 0; start < storageKeys.length; start += llmCacheReadConcurrency) {
        const batch = await Promise.all(
            storageKeys.slice(start, start + llmCacheReadConcurrency).map(async (storageKey) => {
                const payload = await readVersionedLLMCachePayload(storageKey)
                return payload ? { ...payload, storageKey } : null
            }),
        )
        for (const row of batch) {
            if (row) rows.push(row)
        }
    }
    const rowsByKey = new Map<string, PersistentLLMTranslationCacheRow[]>()
    for (const row of rows) {
        const matchingRows = rowsByKey.get(row.key) ?? []
        matchingRows.push(row)
        rowsByKey.set(row.key, matchingRows)
    }
    const canonicalStorageKeys = new Map(await Promise.all(
        [...rowsByKey.keys()].map(async (key) => [
            key,
            await makeHashedStorageKey(llmTranslateCachePrefix, key),
        ] as const),
    ))
    return [...rowsByKey].flatMap(([key, matchingRows]) => {
        const canonicalStorageKey = canonicalStorageKeys.get(key)
        const canonicalRow = matchingRows.find((row) => row.storageKey === canonicalStorageKey)
        return canonicalRow
            ? [canonicalRow, ...matchingRows.filter((row) => row !== canonicalRow)]
            : matchingRows
    })
}

function reconcileLLMCacheMirror(rows: PersistentLLMTranslationCacheRow[]) {
    llmTranslateCache.clear()
    const seen = new Set<string>()
    for (const row of rows) {
        if (seen.has(row.key)) continue
        seen.add(row.key)
        llmTranslateCache.set(row.key, row.value)
    }
}

function rebuildLLMCacheStorageIndex(rows: PersistentLLMTranslationCacheRow[]) {
    const locations = new Map<string, string[]>()
    for (const row of rows) {
        const storageKeys = locations.get(row.key) ?? []
        storageKeys.push(row.storageKey)
        locations.set(row.key, storageKeys)
    }
    const index = { generation: llmCacheStorageIndexGeneration, locations }
    llmCacheStorageIndex = index
    return index
}

function reconcileLLMCacheState(rows: PersistentLLMTranslationCacheRow[]) {
    reconcileLLMCacheMirror(rows)
    return rebuildLLMCacheStorageIndex(rows)
}

async function readAndReconcilePersistentLLMCacheRows() {
    while (true) {
        const clearBarrier = llmCacheClearBarrier
        await clearBarrier
        const globalGeneration = llmCacheGlobalGeneration
        const mutationGeneration = llmCacheMutationGeneration
        await Promise.allSettled([...llmCacheMutationQueues.values()])
        if (globalGeneration !== llmCacheGlobalGeneration
            || mutationGeneration !== llmCacheMutationGeneration) continue
        const rows = await readPersistentLLMCacheRows()
        if (globalGeneration !== llmCacheGlobalGeneration
            || mutationGeneration !== llmCacheMutationGeneration) continue
        reconcileLLMCacheState(rows)
        return rows
    }
}

async function ensureLLMCacheStorageIndex() {
    if (llmCacheStorageIndex) return llmCacheStorageIndex
    const existingBuild = llmCacheStorageIndexBuild
    if (existingBuild) return await existingBuild

    let build!: Promise<LLMCacheStorageIndex>
    build = (async () => {
        try {
            await readAndReconcilePersistentLLMCacheRows()
            return llmCacheStorageIndex ?? {
                generation: llmCacheStorageIndexGeneration,
                locations: new Map<string, string[]>(),
            }
        } finally {
            if (llmCacheStorageIndexBuild === build) llmCacheStorageIndexBuild = null
        }
    })()
    llmCacheStorageIndexBuild = build
    return await build
}

function resolveLLMCacheStorageIndex(candidate: LLMCacheStorageIndex) {
    if (llmCacheStorageIndex) return llmCacheStorageIndex
    const current = candidate.generation === llmCacheStorageIndexGeneration
        ? candidate
        : { generation: llmCacheStorageIndexGeneration, locations: new Map<string, string[]>() }
    llmCacheStorageIndex = current
    return current
}

function invalidateLLMCacheStorageIndex() {
    llmCacheStorageIndexGeneration++
    llmCacheStorageIndex = null
}

async function refreshLLMCacheStorageIndexIfStale(key: string, candidate: LLMCacheStorageIndex) {
    const current = llmCacheStorageIndex ?? candidate
    for (const storageKey of current.locations.get(key) ?? []) {
        const payload = await readLLMCachePayload(storageKey)
        if (!payload || payload.key !== key) {
            invalidateLLMCacheStorageIndex()
            return await ensureLLMCacheStorageIndex()
        }
    }
    return current
}

function advanceLLMCacheKeyGeneration(key: string) {
    const next = (llmCacheKeyGenerations.get(key) ?? 0) + 1
    llmCacheKeyGenerations.set(key, next)
    llmCacheMutationGeneration++
    return next
}

function beginLLMCachePublication(key: string): LLMCachePublicationToken {
    return {
        globalGeneration: llmCacheGlobalGeneration,
        keyGeneration: advanceLLMCacheKeyGeneration(key),
    }
}

function invalidateLLMCacheKey(key: string) {
    advanceLLMCacheKeyGeneration(key)
}

function isCurrentLLMCachePublication(key: string, token: LLMCachePublicationToken) {
    return token.globalGeneration === llmCacheGlobalGeneration
        && token.keyGeneration === (llmCacheKeyGenerations.get(key) ?? 0)
}

async function runSerializedLLMCacheMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = llmCacheMutationQueues.get(key)
    const clearBarrier = llmCacheClearBarrier
    let task!: Promise<T>
    task = (async () => {
        await clearBarrier
        if (previous) {
            try {
                await previous
            } catch {
                // A rejected earlier mutation must not block later reconciliation.
            }
        }
        try {
            return await operation()
        } finally {
            if (llmCacheMutationQueues.get(key) === task) {
                llmCacheMutationQueues.delete(key)
            }
        }
    })()
    llmCacheMutationQueues.set(key, task)
    return await task
}

async function getPersistentLLMCache(text: string): Promise<string | null> {
    while (true) {
        const clearBarrier = llmCacheClearBarrier
        await clearBarrier
        const globalGeneration = llmCacheGlobalGeneration
        const keyGeneration = llmCacheKeyGenerations.get(text) ?? 0
        const mutationGeneration = llmCacheMutationGeneration
        const pendingMutation = llmCacheMutationQueues.get(text)
        if (pendingMutation) await Promise.allSettled([pendingMutation])
        if (globalGeneration !== llmCacheGlobalGeneration
            || keyGeneration !== (llmCacheKeyGenerations.get(text) ?? 0)
            || mutationGeneration !== llmCacheMutationGeneration) continue

        const storageKey = await makeHashedStorageKey(llmTranslateCachePrefix, text)
        const payload = await readLLMCachePayload(storageKey)
        if (globalGeneration !== llmCacheGlobalGeneration
            || keyGeneration !== (llmCacheKeyGenerations.get(text) ?? 0)
            || mutationGeneration !== llmCacheMutationGeneration) continue
        if (payload?.key === text) {
            llmTranslateCache.set(text, payload.value)
            return payload.value
        }

        const storageIndex = await ensureLLMCacheStorageIndex()
        if (globalGeneration !== llmCacheGlobalGeneration
            || keyGeneration !== (llmCacheKeyGenerations.get(text) ?? 0)
            || mutationGeneration !== llmCacheMutationGeneration) continue
        const cachedValue = llmTranslateCache.get(text)
        if (cachedValue !== undefined) return cachedValue

        const indexedStorageKeys = storageIndex.locations.get(text) ?? []
        if (indexedStorageKeys.length === 0) return null
        for (const candidateStorageKey of indexedStorageKeys) {
            const indexedPayload = await readLLMCachePayload(candidateStorageKey)
            if (globalGeneration !== llmCacheGlobalGeneration
                || keyGeneration !== (llmCacheKeyGenerations.get(text) ?? 0)
                || mutationGeneration !== llmCacheMutationGeneration) break
            if (!indexedPayload || indexedPayload.key !== text) continue
            llmTranslateCache.set(text, indexedPayload.value)
            return indexedPayload.value
        }
        if (globalGeneration !== llmCacheGlobalGeneration
            || keyGeneration !== (llmCacheKeyGenerations.get(text) ?? 0)
            || mutationGeneration !== llmCacheMutationGeneration) continue
        storageIndex.locations.delete(text)
        return null
    }
}

async function setPersistentLLMCache(
    text: string,
    value: string,
    storageIndex: Map<string, string[]>,
    preferredStorageKey?: string,
    expectedAuthorityEtag?: string,
) {
    const canonicalStorageKey = await makeHashedStorageKey(llmTranslateCachePrefix, text)
    const matchingStorageKeys = new Set(storageIndex.get(text) ?? [])
    if (preferredStorageKey) matchingStorageKeys.add(preferredStorageKey)
    const storageKey = preferredStorageKey
        ? preferredStorageKey
        : matchingStorageKeys.has(canonicalStorageKey)
            ? canonicalStorageKey
            : matchingStorageKeys.values().next().value ?? canonicalStorageKey

    const indexedAuthority = matchingStorageKeys.has(storageKey)
    const currentAuthority = await readVersionedLLMCachePayload(storageKey)
    if ((indexedAuthority && !currentAuthority) || (currentAuthority && currentAuthority.key !== text)) {
        invalidateLLMCacheStorageIndex()
        throw new Error('LLM translation cache storage index is stale')
    }
    if (expectedAuthorityEtag !== undefined && currentAuthority?.etag !== expectedAuthorityEtag) {
        throw new Error('LLM translation cache entry changed in another window')
    }

    const duplicateStorageKeys = [...matchingStorageKeys].filter((key) => key !== storageKey)
    const originalDuplicatePayloads = new Map<string, VersionedLLMTranslationCachePayload>()
    for (const duplicateStorageKey of duplicateStorageKeys) {
        const payload = await readVersionedLLMCachePayload(duplicateStorageKey)
        if (!payload || payload.key !== text) {
            invalidateLLMCacheStorageIndex()
            throw new Error('LLM translation cache storage index is stale')
        }
        originalDuplicatePayloads.set(duplicateStorageKey, payload)
    }
    const updatedDuplicateEtags = new Map<string, string>()
    const rollbackDuplicates = async () => {
        let rollbackError: unknown = null
        for (const [duplicateStorageKey, currentEtag] of updatedDuplicateEtags) {
            const payload = originalDuplicatePayloads.get(duplicateStorageKey)
            if (!payload) continue
            try {
                await writePersistentJsonConditional(
                    duplicateStorageKey,
                    { key: payload.key, value: payload.value },
                    currentEtag,
                )
            } catch (error) {
                rollbackError ??= error
            }
        }
        if (rollbackError) {
            const actualRows: PersistentLLMTranslationCacheRow[] = []
            for (const candidateStorageKey of matchingStorageKeys) {
                const payload = await readVersionedLLMCachePayload(candidateStorageKey)
                if (payload?.key === text) {
                    actualRows.push({ ...payload, storageKey: candidateStorageKey })
                }
            }
            const canonicalRowIndex = actualRows.findIndex((row) => row.storageKey === canonicalStorageKey)
            if (canonicalRowIndex > 0) {
                actualRows.unshift(actualRows.splice(canonicalRowIndex, 1)[0])
            }
            if (actualRows.length > 0) {
                storageIndex.set(text, actualRows.map((row) => row.storageKey))
                llmTranslateCache.set(text, actualRows[0].value)
            } else {
                storageIndex.delete(text)
                llmTranslateCache.delete(text)
            }
        }
        return rollbackError
    }

    try {
        for (const duplicateStorageKey of duplicateStorageKeys) {
            const original = originalDuplicatePayloads.get(duplicateStorageKey)!
            const nextEtag = await writePersistentJsonConditional(
                duplicateStorageKey,
                { key: text, value },
                original.etag,
            )
            if (!nextEtag) throw new Error('Persistent storage did not return an ETag')
            updatedDuplicateEtags.set(duplicateStorageKey, nextEtag)
        }
    } catch (error) {
        await rollbackDuplicates()
        invalidateLLMCacheStorageIndex()
        throw error
    }

    try {
        if (currentAuthority) {
            await writePersistentJsonConditional(storageKey, { key: text, value }, currentAuthority.etag)
        } else {
            await writePersistentJson(storageKey, { key: text, value })
        }
    } catch (error) {
        await rollbackDuplicates()
        invalidateLLMCacheStorageIndex()
        throw error
    }

    llmTranslateCache.set(text, value)
    const remainingStorageKeys = new Set([storageKey, ...duplicateStorageKeys])
    let cleanupError: unknown = null
    for (const duplicateStorageKey of duplicateStorageKeys) {
        try {
            await removePersistentKeyConditional(
                duplicateStorageKey,
                updatedDuplicateEtags.get(duplicateStorageKey)!,
            )
            remainingStorageKeys.delete(duplicateStorageKey)
        } catch (error) {
            cleanupError ??= error
        }
    }
    storageIndex.set(text, [
        storageKey,
        ...[...remainingStorageKeys].filter((key) => key !== storageKey),
    ])
    if (cleanupError) {
        invalidateLLMCacheStorageIndex()
        throw cleanupError
    }
    return storageKey
}

async function requireLLMCachePayload(key: string, storageKey: string) {
    if (!storageKey || !storageKey.startsWith(llmTranslateCachePrefix)) {
        throw new Error('Invalid LLM translation cache storage key')
    }
    const payload = await readVersionedLLMCachePayload(storageKey)
    if (!payload || payload.key !== key) {
        throw new Error('LLM translation cache storage key does not match entry')
    }
    return payload
}

let waitTrans = 0

export function getCurrentTranslatorPreset(): TranslatorPreset {
    return getCurrentTranslatorPresetFromState(getDatabase())
}

export async function translate(text:string, reverse:boolean) {
    let db = getDatabase()
    if(!reverse){
        const ind = cache.origin.indexOf(text)
        if(ind !== -1){
            return cache.trans[ind]
        }
    }
    else{
        const ind = cache.trans.indexOf(text)
        if(ind !== -1){
            return cache.origin[ind]
        }
    }

    return runTranslator(text, reverse, db.translator,db.aiModel.startsWith('novellist') ? 'ja' : 'en')
}

export async function runTranslator(text:string, reverse:boolean, from:string,target:string, exarg?:{translatorNote?:string}) {
    let transientFallback = false
    const arg = {
        onFallback: () => { transientFallback = true },
        from: reverse ? from : target,

        to: reverse ? target : from,

        host: 'translate.googleapis.com',

        translatorNote: exarg?.translatorNote
    }
    const texts = text.split('\n')
    let chunks:[string,boolean][] = [['', true]]

    for(let i = 0; i < texts.length; i++){
        if( texts[i].startsWith('{{img')
            || texts[i].startsWith('{{raw')
            || texts[i].startsWith('{{video')
            || texts[i].startsWith('{{audio')
            && texts[i].endsWith('}}')
            || texts[i].length === 0){
            chunks.push([texts[i], false])
            chunks.push(["", true])
        }
        else{
            chunks[chunks.length-1][0] += texts[i]
        }
    }

    let fullResult:string[] = []

    for(const chunk of chunks){
        if(chunk[1]){
            const trimed = chunk[0].trim();
            if(trimed.length === 0){
                fullResult.push(chunk[0])
                continue
            }
            const result = await translateMain(trimed, arg);

            if(result.startsWith('ERR::')){
                notifyError(result)
                return text
            }


            fullResult.push(result.trim())
        }
        else{
            fullResult.push(chunk[0])
        }
    }

    if (transientFallback) return text
    const result = fullResult.join("\n").trim()

    if (!transientFallback) {
        cache.origin.push(reverse ? result : text)
        cache.trans.push(reverse ? text : result)
    }


    return result

}

async function translateMain(text:string, arg:{from:string, to:string, host:string, translatorNote?:string, onFallback?:()=>void}){
    let db = getDatabase()
    if(db.translatorType === 'llm'){
        const tr = arg.to || 'en'
        return translateLLM(text, {to: tr, from: arg.from, translatorNote: arg.translatorNote})
    }
    if(db.translatorType === 'deepl'){
        const body = {
            text: [text],
            target_lang: arg.to.toLocaleUpperCase(),
        }
        let url = db.deeplOptions.freeApi ? "https://api-free.deepl.com/v2/translate" : "https://api.deepl.com/v2/translate"
        const f = await globalFetch(url, {
            headers: {
                "Authorization": "DeepL-Auth-Key " + db.deeplOptions.key,
                "Content-Type": "application/json"
            },
            body: body,
            logCategory: 'translate',
            logSource: 'translate',
        })

        if(!f.ok){
            return 'ERR::DeepL API Error' + (await f.data)
        }
        return f.data.translations[0].text

    }
    if(db.translatorType === 'deeplX'){
        if(!db.noWaitForTranslate){
            if(waitTrans - Date.now() > 0){
                const waitTime = waitTrans - Date.now()
                waitTrans = Date.now() + 3000
                await sleep(waitTime)
            }
        }

        let url = db.deeplXOptions.url ?? 'http://localhost:1188'

        if(url.endsWith('/')){
            url = url.slice(0, -1)
        }

        if(!url.endsWith('/translate')){
            url += '/translate'
        }

        let headers = { "Content-Type": "application/json" }

        const body = {text: text, target_lang: arg.to.toLocaleUpperCase(), source_lang: arg.from.toLocaleUpperCase()}

    
        if(db.deeplXOptions.token.trim() !== '') { headers["Authorization"] = "Bearer " + db.deeplXOptions.token}
        
        //Since the DeepLX API is non-CORS restricted, we can use the plain fetch function
        const f = await globalFetch(url, { method: "POST", headers: headers, body: body, plainFetchForce:true, logCategory: 'translate', logSource: 'translate' })

        if(!f.ok){ return 'ERR::DeepLX API Error' + (await f.data) }

        return f.data.data;
    }
    if(db.translatorType == "bergamot") {
        if(!bergamotTranslate){
            const bergamotTranslator = await import('./bergamotTranslator')
            bergamotTranslate = bergamotTranslator.bergamotTranslate
        }

        return bergamotTranslate(text, arg.from, arg.to, false);
    }
    if(db.useExperimentalGoogleTranslator){

        const hqAvailable = true

        if(hqAvailable){
            try {
                const ua = navigator.userAgent
                const d = await globalFetch(`https://translate.google.com/m?tl=${arg.to}&sl=${arg.from}&q=${encodeURIComponent(text)}`, {
                    headers: {
                        "User-Agent": ua,
                        "Accept": "*/*",
                    },
                    method: "GET",
                    logCategory: 'translate',
                    logSource: 'translate',
                })
                const parser = new DOMParser()
                const dom = parser.parseFromString(d.data, 'text/html')
                const result = dom.querySelector('.result-container')?.textContent?.trim()
                if(result){
                    return result
                }
            } catch (error) {
                
            }
        }
    }


    const url = `https://${arg.host}/translate_a/single?client=gtx&dt=t&sl=${db.translatorInputLanguage}&tl=${arg.to}&q=` + encodeURIComponent(text)



    const mobileGoogle = isBardAndroid() && db.translatorType === 'google'
    const fallback = () => {
        arg.onFallback?.()
        const now = Date.now()
        if (now - googleFallbackNoticeAt >= 30_000) {
            googleFallbackNoticeAt = now
            notifyError('Google 번역을 잠시 사용할 수 없어 원문을 표시합니다. 잠시 후 번역 재시도를 눌러 주세요.')
        }
        return text
    }
    const f = mobileGoogle ? await mobileGoogleGate.request(url) : await fetch(url, { method: 'GET' })
    if (!f || (mobileGoogle && !f.ok)) return fallback()
    let res: any
    try { res = await f.json() }
    catch (error) { if (mobileGoogle) return fallback(); throw error }

    if(typeof(res) === 'string'){

        return res as unknown as string

    }

    if ((mobileGoogle && !Array.isArray(res?.[0])) || !res[0] || res[0].length === 0) {
        return mobileGoogle ? fallback() : text
    }

    const result = (res[0].map((s) => s[0]).filter(Boolean).join('') as string).replace(/\* ([^*]+)\*/g, '*$1*').replace(/\*([^*]+) \*/g, '*$1*');
    return result
}

export async function translateVox(text:string) {    
    return jaTrans(text)
}


async function jaTrans(text:string) {
    return await runTranslator(text, true, 'en','ja')
}

export function isExpTranslator(){
    const db = getDatabase()
    return db.translatorType === 'llm' || db.translatorType === 'deepl' || db.translatorType === 'deeplX'
}

export async function translateHTML(html: string, reverse:boolean, charArg:simpleCharacterArgument|string = '', chatID:number, regenerate = false): Promise<string> {
    let alwaysExistChar: character | simpleCharacterArgument;
    if(charArg !== ''){
        if(typeof(charArg) === 'string'){
            const db = getDatabase()
            const charId = get(selectedCharID)
            alwaysExistChar = db.characters[charId]
        }
        else{
            alwaysExistChar=charArg
        }
    } else {
        alwaysExistChar = {
            type: 'simple',
            customscript: [],
            virtualscript: null,
            emotionImages: [],
            chaId: 'simple'
        }
    }
    let db = getDatabase()
    let DoingChat = get(doingChat)
    if(DoingChat){
        if(isExpTranslator()){
            if(!(db.translatorType === 'llm' && await getLLMCache(html) !== null)){
                return html
            }
        }
    }
    if(db.translatorType === 'llm'){
        const tr = db.translator || 'en'
        const from = db.translatorInputLanguage
        let translated = false
        const r = await translateLLM(html, {to: tr, from: from, regenerate, onCacheState: (cached) => { translated = !cached }})
        if(translated && db.playMessageOnTranslateEnd){
            playNotificationSound(db.translateSound, db.translateSoundVolume)
        }

        return applyEdittransRegex(r, charArg, alwaysExistChar)
    }
    if(db.translatorType == "bergamot" && db.htmlTranslation) {
        const from = db.aiModel.startsWith('novellist') ? 'ja' : 'en'
        const to = db.translator || 'en'

        if(!bergamotTranslate){
            const bergamotTranslator = await import('./bergamotTranslator')
            bergamotTranslate = bergamotTranslator.bergamotTranslate
        }
 
        return applyEdittransRegex(await bergamotTranslate(html, from, to, true), charArg, alwaysExistChar)
    }
    const dom = new DOMParser().parseFromString(html, 'text/html');
    console.log(html)

    let promises: Promise<void>[] = [];
    let translationError: unknown;
    let translationChunks: {
        chunks: string[],
        resolvers: ((text:string) => void)[]
    }[] = [{
        chunks: [],
        resolvers: []
    }]
    

    async function translateTranslationChunks(force:boolean = false, additionalChunkLength = 0){
        if(translationChunks.length === 0 || !needSuperChunkedTranslate()){
            return
        }

        const currentChunk = translationChunks[translationChunks.length-1]
        const text: string = currentChunk.chunks.join('\n■\n')

        if(!force && text.length + additionalChunkLength < 5000){
            return
        }

        translationChunks.push({
            chunks: [],
            resolvers: []
        })

        if(!text){
            return
        }

        try {
            const translated = await translate(text, reverse)
            if (translated === text) {
                currentChunk.chunks.forEach((original, i) => currentChunk.resolvers[i](original))
                return
            }
            const split = translated.split('■')
            if(split.length !== currentChunk.chunks.length){
                for(let i = 0; i < currentChunk.chunks.length; i++){
                    currentChunk.resolvers[i](await translate(currentChunk.chunks[i], reverse))
                }
                return
            }
            split.forEach((value, i) => currentChunk.resolvers[i](value))
        } catch (error) {
            // Settle every queued node before reporting a failed batch to the caller.
            translationError ??= error
            currentChunk.chunks.forEach((original, i) => currentChunk.resolvers[i](original))
        }


    }

    async function translateNodeText(node:Node, reprocessDisplayScript:boolean = false) {
        if(node.textContent.trim().length !== 0){
            let translated: string;
            if(needSuperChunkedTranslate()){
                const prm = new Promise<string>((resolve) => {
                    translateTranslationChunks(false, node.textContent.length)
                    translationChunks[translationChunks.length-1].resolvers.push(resolve)
                    translationChunks[translationChunks.length-1].chunks.push(node.textContent)
                })
    
                translated = await prm
            } else {
                const translateChunks = (node.textContent || '').split(/\n\n+/g);
                const translatedChunks = await Promise.all(translateChunks.map(chunk => translate(chunk, reverse)));
                translated = translatedChunks.join("\n\n");
            }
            if (!reprocessDisplayScript) {
                node.textContent = translated;
                return;
            }
            
            const { data: processedTranslated } = await processScriptFull(
                alwaysExistChar,
                translated,
                "editdisplay",
                chatID
            );
            // If the translation is the same, don't replace the node
            if (translated == processedTranslated) {
                node.textContent = processedTranslated;
                applyMarkdownToNode(node)
                return;
            }

            // Replace the old node with the new one
            const newNode = document.createElement(
                node.nodeType === Node.TEXT_NODE ? "span" : node.nodeName
            );
            newNode.innerHTML = processedTranslated;
            node.parentNode.replaceChild(newNode, node);
            applyMarkdownToNode(newNode);
        }
    }

    // Recursive function to translate all text nodes
    async function translateNode(node: Node, parent?: Node): Promise<void> {
        if (node.nodeType === Node.TEXT_NODE) {
            // Translate the text content of the node
            if(node.textContent && parent){
                const parentName = parent.nodeName.toLowerCase();
                if(parentName === 'script' || parentName === 'style'){
                    return
                }
                if(promises.length > 10){
                    await translateTranslationChunks(true, 0)
                    await Promise.all(promises)
                    promises = []
                }
                promises.push(translateNodeText(node))
            }
        } else if(node.nodeType === Node.ELEMENT_NODE) {
            // Translate child nodes
            //skip if it's a script or style tag
            if(node.nodeName.toLowerCase() === 'script' || node.nodeName.toLowerCase() === 'style'){
                return
            }
            // combineTranslation feature
            if (
                db.combineTranslation &&
                node.nodeName.toLowerCase() === "p" &&
                node instanceof HTMLElement
            ) {
                const children = Array.from(node.childNodes);
                const blacklist = ["img", "iframe", "script", "style", "div", "button", "audio", "video"];
                const hasBlacklistChild = children.some((child) =>
                    blacklist.includes(child.nodeName.toLowerCase())
                );
                if (!hasBlacklistChild && (node as Element)?.getAttribute('translate') !== 'no'){
                    const text = getNodetextToSentence(node);
                    const sentences = text.split("\n");
                    if (sentences.length > 1) {
                        // Multiple sentences seperated by <br> tags
                        // reconstruct the p tag
                        node.innerHTML = "";
                        for (const sentence of sentences) {
                            const newNode = document.createElement("span");
                            newNode.textContent = sentence;
                            node.appendChild(newNode);
                            if (needSuperChunkedTranslate()) promises.push(translateNodeText(newNode, true));
                            else await translateNodeText(newNode, true);
                            node.appendChild(document.createElement("br"));
                        }
                    } else {
                        // Single sentence
                        node.innerHTML = sentences[0];
                        if (needSuperChunkedTranslate()) promises.push(translateNodeText(node, true));
                        else await translateNodeText(node, true);
                    }
                    return;
                }
            }

            for (const child of Array.from(node.childNodes)) {
                if(node.nodeType === Node.ELEMENT_NODE && (node as Element)?.getAttribute('translate') === 'no'){
                    continue
                }
                await translateNode(child, node);
            }
        }
    }
    

    // Start translation from the body element
    await translateNode(dom.body);

    await translateTranslationChunks(true, 0)

    await Promise.all(promises)
    if (translationError) throw translationError
    // Serialize the DOM back to HTML
    const serializer = new XMLSerializer();
    let translatedHTML = serializer.serializeToString(dom);
    // Remove the outer <html|body|head> tags
    translatedHTML = translatedHTML.replace(/<\/?(html|body|head)[^>]*>/g, '');

    translatedHTML = applyEdittransRegex(translatedHTML, charArg, alwaysExistChar);

    // console.log(html)
    // console.log(translatedHTML)
    // Return the translated HTML, excluding the outer <body> tags if needed
    return translatedHTML
}

function needSuperChunkedTranslate(){
    const translatorType = getDatabase().translatorType
    return translatorType === 'deeplX' || shouldBatchPrivateMobileGoogleTranslation(isBardAndroid(), translatorType)
}

async function translateLLM(text:string, arg:{to:string, from:string, regenerate?:boolean,translatorNote?:string, onCacheState?:(cached:boolean) => void}):Promise<string>{
    if(!arg.regenerate){
        const cacheMatch = llmTranslateCache.get(text)
        if(cacheMatch){
            arg.onCacheState?.(true)
            return cacheMatch
        }
        const persistedCacheMatch = await getPersistentLLMCache(text)
        if (persistedCacheMatch !== null) {
            arg.onCacheState?.(true)
            return persistedCacheMatch
        }
    }
    // The cache is looked up (above) with the original text, so it must be stored
    // under the same key. `text` gets mutated below for the request; storing under
    // the mutated string made every <style>-bearing message a permanent cache miss
    // that re-billed the LLM and piled up orphan entries.
    const cacheKey = text
    const publicationToken = beginLLMCachePublication(cacheKey)
    const styleDecodeRegex = /\<risu-style\>(.+?)\<\/risu-style\>/gms
    let styleDecodes:string[] = []
    text = text.replace(styleDecodeRegex, (match, p1) => {
        styleDecodes.push(p1)
        return `<style-data style-index="${styleDecodes.length-1}"></style-data>`
    })

    const db = getDatabase()
    const charIndex = get(selectedCharID)
    const currentChar = db.characters[charIndex]
    let translatorNote = ""
    console.log(arg.translatorNote)
    if(arg.translatorNote){
        translatorNote = arg.translatorNote
    }
    else if (currentChar?.type === "character") {
        translatorNote = currentChar.translatorNote ?? ""
    } else {
        translatorNote = ""
    }
    console.log(translatorNote)

    let formated:OpenAIChat[] = []
    const preset = getCurrentTranslatorPreset()
    let prompt = preset.prompt || defaultTranslatorPrompt
    let parsedPrompt = parseChatML(prompt.replaceAll('{{slot::from}}', arg.from).replaceAll('{{slot}}', arg.to).replaceAll('{{solt::content}}', text).replaceAll('{{slot::content}}', text).replaceAll('{{slot::tnote}}', translatorNote))
    if(parsedPrompt){
        formated = parsedPrompt
    }
    else{
        prompt = prompt.replaceAll('{{slot}}', arg.to).replaceAll('{{slot::tnote}}', translatorNote).replaceAll('{{slot::from}}', arg.from)
        formated = [
            {
                'role': 'system',
                'content': prompt
            },
            {
                'role': 'user',
                'content': text
            }
        ]
    }
    const rq = await requestChatData({
        formated,
        bias: {},
        useStreaming: false,
        noMultiGen: true,
        maxTokens: preset.maxResponse,
    }, 'translate')

    if(rq.type === 'fail'){
        notifyError(rq.result)
        return text
    }
    if(rq.type === 'streaming' || rq.type === 'multiline'){
        notifyError('Unexpected response type')
        return text
    }
    const result = rq.result.replace(/<style-data style-index="(\d+)" ?\/?>/g, (match, p1) => {
        return styleDecodes[parseInt(p1)] ?? ''
    }).replace(/<\/style-data>/g, '')
    try {
        let preparedStorageIndex = await ensureLLMCacheStorageIndex()
        preparedStorageIndex = await refreshLLMCacheStorageIndexIfStale(cacheKey, preparedStorageIndex)
        llmCacheMutationGeneration++
        await runSerializedLLMCacheMutation(cacheKey, async () => {
            if (!isCurrentLLMCachePublication(cacheKey, publicationToken)) return
            const storageIndex = resolveLLMCacheStorageIndex(preparedStorageIndex)
            await setPersistentLLMCache(cacheKey, result, storageIndex.locations)
            if (isCurrentLLMCachePublication(cacheKey, publicationToken)) {
                llmTranslateCache.set(cacheKey, result)
            }
        })
    } catch (error) {
        notifyError(error instanceof Error ? error.message : String(error))
    }
    arg.onCacheState?.(false)
    return result
}

export async function clearLLMCache(): Promise<void> {
    if (activeLLMCacheClear) return await activeLLMCacheClear

    llmCacheGlobalGeneration++
    const previousBarrier = llmCacheClearBarrier
    const pendingMutations = [...llmCacheMutationQueues.values()]
    let releaseBarrier!: () => void
    const ownBarrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve
    })
    llmCacheClearBarrier = previousBarrier.then(() => ownBarrier)

    let clearTask!: Promise<void>
    clearTask = (async () => {
        try {
            await previousBarrier
            await Promise.allSettled(pendingMutations)
            invalidateLLMCacheStorageIndex()
            try {
                await clearPersistentPrefix(llmTranslateCachePrefix)
                llmTranslateCache.clear()
            } catch (error) {
                try {
                    reconcileLLMCacheState(await readPersistentLLMCacheRows())
                } catch {
                    llmTranslateCache.clear()
                    llmCacheStorageIndex = null
                }
                throw error
            }
        } finally {
            releaseBarrier()
            if (activeLLMCacheClear === clearTask) activeLLMCacheClear = null
        }
    })()
    activeLLMCacheClear = clearTask
    return await clearTask
}

export async function getLLMCache(text:string):Promise<string | null>{
    return llmTranslateCache.get(text) ?? await getPersistentLLMCache(text)
}

export async function searchLLMCache(partialKey:string):Promise<{key: string, value: string}[]>{
    const rows = await readAndReconcilePersistentLLMCacheRows()
    const results:{key: string, value: string}[] = []
    const seen = new Set<string>()
    for (const row of rows) {
        if (seen.has(row.key) || !row.key.includes(partialKey)) continue
        seen.add(row.key)
        results.push({ key: row.key, value: row.value })
    }
    return results
}

export async function setLLMCache(key:string, value:string):Promise<void>{
    const entryGeneration = llmCacheGlobalGeneration
    await setLLMCacheForGeneration(key, value, entryGeneration)
}

async function setLLMCacheForGeneration(
    key: string,
    value: string,
    expectedGlobalGeneration?: number,
    sharedStorageIndex?: LLMCacheStorageIndex,
) {
    let preparedStorageIndex = llmCacheStorageIndex
        ?? sharedStorageIndex
        ?? await ensureLLMCacheStorageIndex()
    if (expectedGlobalGeneration !== undefined
        && expectedGlobalGeneration !== llmCacheGlobalGeneration) {
        throw new Error('LLM translation cache operation was superseded by clear')
    }
    preparedStorageIndex = await refreshLLMCacheStorageIndexIfStale(key, preparedStorageIndex)
    if (expectedGlobalGeneration !== undefined
        && expectedGlobalGeneration !== llmCacheGlobalGeneration) {
        throw new Error('LLM translation cache operation was superseded by clear')
    }
    invalidateLLMCacheKey(key)
    await runSerializedLLMCacheMutation(key, async () => {
        if (expectedGlobalGeneration !== undefined
            && expectedGlobalGeneration !== llmCacheGlobalGeneration) {
            throw new Error('LLM translation cache operation was superseded by clear')
        }
        const storageIndex = resolveLLMCacheStorageIndex(preparedStorageIndex)
        await setPersistentLLMCache(key, value, storageIndex.locations)
        llmTranslateCache.set(key, value)
    })
}

export type LLMTranslationCacheRow = {
    key: string
    value: string
    storageKey: string
    etag: string
}

export type LLMTranslationCachePage = {
    rows: LLMTranslationCacheRow[]
    total: number
    page: number
    pageSize: number
    pageCount: number
}

export type LLMTranslationCacheQuery = {
    search?: string
    page?: number
    pageSize?: number
}

function compareCacheRows(left: LLMTranslationCacheRow, right: LLMTranslationCacheRow) {
    const leftFolded = left.key.toLowerCase()
    const rightFolded = right.key.toLowerCase()
    if (leftFolded < rightFolded) return -1
    if (leftFolded > rightFolded) return 1
    if (left.key < right.key) return -1
    if (left.key > right.key) return 1
    return 0
}

export async function listLLMCache(query: LLMTranslationCacheQuery = {}): Promise<LLMTranslationCachePage> {
    const rowsByKey = new Map<string, LLMTranslationCacheRow>()
    const persistentRows = await readAndReconcilePersistentLLMCacheRows()
    for (const row of persistentRows) {
        if (!rowsByKey.has(row.key)) rowsByKey.set(row.key, row)
    }

    const search = (query.search ?? '').trim().toLowerCase()
    const rows = [...rowsByKey.values()]
        .filter((row) => !search
            || row.key.toLowerCase().includes(search)
            || row.value.toLowerCase().includes(search))
        .sort(compareCacheRows)
    const requestedPageSize = Math.floor(query.pageSize ?? 100)
    const pageSize = Number.isFinite(requestedPageSize) && requestedPageSize > 0
        ? Math.min(requestedPageSize, 100)
        : 100
    const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
    const requestedPage = Math.floor(query.page ?? 1)
    const page = Math.min(
        pageCount,
        Math.max(1, Number.isFinite(requestedPage) ? requestedPage : 1),
    )
    const start = (page - 1) * pageSize
    return {
        rows: rows.slice(start, start + pageSize),
        total: rows.length,
        page,
        pageSize,
        pageCount,
    }
}

export async function updateLLMCacheValue(
    key: string,
    value: string,
    storageKey: string,
    expectedEtag: string,
): Promise<void> {
    if (!expectedEtag) throw new Error('LLM translation cache entry version is required')
    let preparedStorageIndex = await ensureLLMCacheStorageIndex()
    preparedStorageIndex = await refreshLLMCacheStorageIndexIfStale(key, preparedStorageIndex)
    invalidateLLMCacheKey(key)
    await runSerializedLLMCacheMutation(key, async () => {
        const storageIndex = resolveLLMCacheStorageIndex(preparedStorageIndex)
        await setPersistentLLMCache(key, value, storageIndex.locations, storageKey, expectedEtag)
        llmTranslateCache.set(key, value)
    })
}

export async function deleteLLMCache(key: string, storageKey: string, expectedEtag: string): Promise<void> {
    if (!expectedEtag) throw new Error('LLM translation cache entry version is required')
    let preparedStorageIndex = await ensureLLMCacheStorageIndex()
    preparedStorageIndex = await refreshLLMCacheStorageIndexIfStale(key, preparedStorageIndex)
    invalidateLLMCacheKey(key)
    await runSerializedLLMCacheMutation(key, async () => {
        const selectedPayload = await requireLLMCachePayload(key, storageKey)
        if (selectedPayload.etag !== expectedEtag) {
            throw new Error('LLM translation cache entry changed in another window')
        }
        const storageIndex = resolveLLMCacheStorageIndex(preparedStorageIndex)
        const storageKeys = new Set([storageKey, ...(storageIndex.locations.get(key) ?? [])])
        const payloads = new Map<string, VersionedLLMTranslationCachePayload>()
        for (const matchingStorageKey of storageKeys) {
            const payload = matchingStorageKey === storageKey
                ? selectedPayload
                : await readVersionedLLMCachePayload(matchingStorageKey)
            if (!payload || payload.key !== key) {
                invalidateLLMCacheStorageIndex()
                throw new Error('LLM translation cache storage index is stale')
            }
            payloads.set(matchingStorageKey, payload)
        }
        for (const [matchingStorageKey, payload] of payloads) {
            try {
                await removePersistentKeyConditional(matchingStorageKey, payload.etag)
            } catch (error) {
                invalidateLLMCacheStorageIndex()
                reconcileLLMCacheState(await readPersistentLLMCacheRows())
                throw error
            }
        }
        storageIndex.locations.delete(key)
        llmTranslateCache.delete(key)
    })
}

export async function exportLLMCacheAsJSON():Promise<Record<string, string>>{
    const rows = await readAndReconcilePersistentLLMCacheRows()
    const result = Object.create(null) as Record<string, string>
    for (const row of rows) {
        if (!Object.hasOwn(result, row.key)) result[row.key] = row.value
    }
    return result
}

export async function importLLMCacheFromJSON(data:Record<string, string>):Promise<{count: number, failed: number}>{
    let count = 0
    let failed = 0
    const entries = Object.entries(data)
    const importGeneration = llmCacheGlobalGeneration
    let storageIndex: LLMCacheStorageIndex
    try {
        storageIndex = await ensureLLMCacheStorageIndex()
    } catch {
        return { count, failed: entries.length }
    }
    for(let index = 0; index < entries.length; index++){
        if (importGeneration !== llmCacheGlobalGeneration) {
            failed += entries.length - index
            break
        }
        const [key, value] = entries[index]
        try {
            await setLLMCacheForGeneration(key, value, importGeneration, storageIndex)
            count++
        } catch {
            failed++
        }
    }
    return {count, failed}
}


function applyEdittransRegex(
      text: string, 
      charArg: simpleCharacterArgument | string, 
      alwaysExistChar: character | simpleCharacterArgument
  ): string {
      if (charArg === '') return text

      let scripts: customscript[] = []
      // Preset-level regex scripts count too, otherwise an 'edittrans' script
      // registered on a preset silently never runs. (Order stays preset -> module ->
      // char, which differs from processScriptFull; left as-is to avoid changing
      // which script wins on overlapping matches.)
      scripts = (getDatabase().presetRegex ?? [])
          .concat(getModuleRegexScripts() ?? [])
          .concat(alwaysExistChar?.customscript ?? [])

      for (const script of scripts) {
          if (script.type === 'edittrans') {
              const reg = new RegExp(script.in, script.ableFlag ? script.flag : 'g')
              let outScript = script.out.replaceAll("$n", "\n")
              text = text.replace(reg, outScript)
          }
      }
      return text
  }
