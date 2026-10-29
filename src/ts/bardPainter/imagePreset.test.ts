import { describe, expect, it } from 'vitest'
import { painterActiveModules } from './imagePreset'
import type { Chat, Database, character } from '../storage/database.svelte'

const module = (id: string, namespace?: string) => ({ id, name: id, description: '', lorebook: [], ...(namespace ? { namespace } : {}) })

describe('painterActiveModules', () => {
    const embedded = module('embedded')
    const db = {
        enabledModules: ['global'],
        personaEnabledModules: { bound: ['persona-mod'], other: ['other-mod'] },
        personas: [{ id: 'selected', name: 'S', personaPrompt: '' }, { id: 'bound', name: 'Kisuke', personaPrompt: '', embeddedModule: embedded }],
        selectedPersona: 0,
        moduleIntergration: 'joined',
        modules: [module('global'), module('persona-mod'), module('other-mod'), module('char-mod'), module('chat-mod'), module('ns-mod', 'joined'), module('off')],
    } as unknown as Database
    const char = { modules: ['char-mod'], personas: [] } as unknown as character

    it('includes the chat persona modules and its embedded module like chat requests do', () => {
        const chat = { modules: ['chat-mod'], bindedPersona: 'bound' } as unknown as Chat
        expect(painterActiveModules(db, char, chat).map(item => item.id)).toEqual(['global', 'persona-mod', 'char-mod', 'chat-mod', 'ns-mod', 'embedded'])
    })

    it('falls back to the selected persona when the chat has none bound', () => {
        const chat = { modules: [] } as unknown as Chat
        const result = painterActiveModules({ ...db, personaEnabledModules: { selected: ['other-mod'] } } as Database, char, chat).map(item => item.id)
        expect(result).toEqual(['global', 'other-mod', 'char-mod', 'ns-mod'])
    })
})
