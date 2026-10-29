import { unzipSync } from 'fflate'
import { language } from 'src/lang'
import type { character, customscript, loreBook, triggerscript } from './storage/database.svelte'
import { AppendableBuffer } from './globalApi.svelte'
import { PngChunk } from './pngChunk'
import { convertCharbook } from './characterCards'
import { readModuleMetadata, type RisuModule } from './process/modules'
import { convertCharacterToModule } from './interchangeability'

// Reads an earlier version of a bot or module file as the base of an update,
// without installing it or saving its assets. Only the text the card carries
// is read; the caller fills the rest from the installed entity.

type Card = { spec?: string, data?: Record<string, any> }

async function cardFromPng(data: Uint8Array): Promise<Card> {
    let chara = ''
    let ccv3 = ''
    for await (const chunk of PngChunk.readGenerator(data)) {
        if (!chunk || chunk instanceof AppendableBuffer) break
        if (chunk.key === 'ccv3') ccv3 = chunk.value
        else if (chunk.key === 'chara') chara = chunk.value
    }
    const encoded = ccv3 || chara
    if (!encoded || encoded.startsWith('rcc||')) throw new Error(language.characterUpdate.baseFileUnsupported)
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'))
}

function unzipCharx(data: Uint8Array) {
    const filter = (file: { name: string }) => file.name === 'card.json' || file.name === 'module.risum'
    try {
        return unzipSync(data, { filter })
    } catch (error) {
        // A JPEG with a CHARX appended: read from the first local file header.
        for (let i = 0; i + 3 < data.length; i++) {
            if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 3 && data[i + 3] === 4) return unzipSync(data.subarray(i), { filter })
        }
        throw error
    }
}

/** The card fields a bot import sets from text, as importCharacterCardSpec maps them. */
function cardToCharacter(card: Card, module: RisuModule | null): Partial<character> {
    const data = card?.data
    if (!data || (card.spec !== 'chara_card_v2' && card.spec !== 'chara_card_v3')) throw new Error(language.characterUpdate.baseFileUnsupported)
    const risu = data.extensions?.risuai
    let lore: loreBook[] = module?.lorebook ?? []
    if (!module?.lorebook && data.character_book) {
        lore = convertCharbook({ lorebook: [], charbook: safeStructuredClone(data.character_book), loresettings: undefined, loreExt: undefined }).lorebook
    }
    const char: Partial<character> = {
        name: data.name ?? '',
        desc: data.description ?? '',
        firstMessage: data.first_mes ?? '',
        alternateGreetings: data.alternate_greetings ?? [],
        group_only_greetings: data.group_only_greetings,
        nickname: data.nickname,
        personality: data.personality ?? '',
        scenario: data.scenario ?? '',
        exampleMessage: data.mes_example ?? '',
        creatorNotes: data.creator_notes ?? '',
        systemPrompt: data.system_prompt ?? '',
        postHistoryInstructions: data.post_history_instructions ?? '',
        tags: data.tags ?? [],
        creator: data.creator ?? '',
        characterVersion: `${data.character_version ?? ''}`,
        replaceGlobalNote: risu && !Object.prototype.hasOwnProperty.call(risu, 'replaceGlobalNote')
            ? data.post_history_instructions ?? ''
            : risu?.replaceGlobalNote ?? '',
        globalLore: lore,
        customscript: (module?.regex ?? risu?.customScripts ?? []) as customscript[],
        triggerscript: (module?.trigger ?? risu?.triggerscript ?? []) as triggerscript[],
        backgroundHTML: risu?.backgroundHTML,
        additionalText: risu?.additionalText ?? '',
        defaultVariables: risu?.defaultVariables ?? '',
        lowLevelAccess: risu?.lowLevelAccess ?? false,
        hideChatIcon: risu?.hideChatIcon ?? false,
        moduleNamespace: risu?.moduleNamespace ?? '',
        customModuleToggle: risu?.toggles ?? '',
        bias: risu?.bias,
        viewScreen: risu?.viewScreen,
    }
    return char
}

function defined<T extends object>(value: T): Partial<T> {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>
}

// Install bookkeeping and asset paths of another install never compare.
const moduleIgnored = ['id', 'type', 'assets', 'icon', 'updateBase', 'updateLineage', 'updateBackupOf', 'realmId']

/** Reads a bot or module file as the base of an update. */
export async function readUpdateBaseFile(kind: 'character' | 'module', file: { name: string, data: Uint8Array }): Promise<Partial<character> | Partial<RisuModule>> {
    const name = file.name.toLowerCase()
    let card: Card | null = null
    let module: RisuModule | null = null
    if (name.endsWith('.risum')) {
        module = await readModuleMetadata(Buffer.from(file.data))
    } else if (name.endsWith('.json')) {
        const parsed = JSON.parse(Buffer.from(file.data).toString('utf-8'))
        if (parsed?.type === 'risuModule') module = parsed
        else card = parsed
    } else if (name.endsWith('.png')) {
        card = await cardFromPng(file.data)
    } else if (name.endsWith('.charx') || name.endsWith('.jpg') || name.endsWith('.jpeg')) {
        const files = unzipCharx(file.data)
        if (!files['card.json']) throw new Error(language.characterUpdate.baseFileUnsupported)
        card = JSON.parse(Buffer.from(files['card.json']).toString('utf-8'))
        if (files['module.risum']) module = await readModuleMetadata(Buffer.from(files['module.risum']))
    }
    if (kind === 'character') {
        if (!card) throw new Error(language.characterUpdate.baseFileUnsupported)
        return defined(cardToCharacter(card, module))
    }
    if (!module && card) module = convertCharacterToModule(cardToCharacter(card, null) as character)
    if (!module) throw new Error(language.characterUpdate.baseFileUnsupported)
    const out: Record<string, unknown> = { ...module }
    for (const key of moduleIgnored) delete out[key]
    return defined(out) as Partial<RisuModule>
}
