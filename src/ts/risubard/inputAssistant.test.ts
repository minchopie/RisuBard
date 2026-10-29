import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { duplicateBardLoreInstructionPreset } from '../lorebook/bardLoreInstructionPreset'
import { SettingsRoute } from '../routing'
import { settingsSections } from '../setting/settingsNavigation'
import {
    INPUT_ASSISTANT_DEFAULT_PRESET_ID,
    buildInputAssistantMessages,
    cleanInputAssistantResult,
    createDefaultInputAssistantPreset,
    normalizeInputAssistantPresetState,
    normalizeInputAssistantSettings,
    resolveInputAssistantPreset,
} from './inputAssistant'

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('input assistant settings', () => {
    it('fills defaults and clamps the message count', () => {
        expect(normalizeInputAssistantSettings(undefined)).toMatchObject({ enabled: false, model: 'otherAx', messageCount: 10 })
        expect(normalizeInputAssistantSettings({ enabled: 'yes' }).enabled).toBe(false)
        const settings = normalizeInputAssistantSettings({
            enabled: true,
            model: 'model',
            messageCount: 500,
            include: { systemPrompt: false, moduleLorebook: true, persona: 'yes' },
        })
        expect(settings.enabled).toBe(true)
        expect(settings.model).toBe('model')
        expect(settings.messageCount).toBe(100)
        expect(settings.include).toMatchObject({ systemPrompt: false, moduleLorebook: true, persona: true })
        expect(normalizeInputAssistantSettings({ messageCount: -3 }).messageCount).toBe(0)
    })

    it('keeps the protected default first and resolves duplicates', () => {
        const copy = duplicateBardLoreInstructionPreset(createDefaultInputAssistantPreset(), 'copy-1')
        copy.content = 'custom'
        const state = normalizeInputAssistantPresetState({
            presets: [{ ...createDefaultInputAssistantPreset(), content: 'tampered', builtin: false }, copy, copy],
            activePresetId: 'copy-1',
        })
        expect(state.presets.map((preset) => preset.id)).toEqual([INPUT_ASSISTANT_DEFAULT_PRESET_ID, 'copy-1'])
        expect(state.presets[0].content).toBe(createDefaultInputAssistantPreset().content)
        expect(resolveInputAssistantPreset(state.presets, 'copy-1').content).toBe('custom')
        expect(resolveInputAssistantPreset(state.presets, 'missing').id).toBe(INPUT_ASSISTANT_DEFAULT_PRESET_ID)
        expect(normalizeInputAssistantPresetState({ activePresetId: 'missing' }).activePresetId)
            .toBe(INPUT_ASSISTANT_DEFAULT_PRESET_ID)
    })

    it('adds its page directly below Grimoire prompts', () => {
        const items = settingsSections.find((section) => section.id === 'risubard')!.items
        const grimoire = items.findIndex((item) => item.route === SettingsRoute.RisuBardGrimoirePrompt)
        expect(items[grimoire + 1]).toMatchObject({ id: 'risubard-input-assistant', route: SettingsRoute.RisuBardInputAssistant })
        expect(read('src/lib/Setting/Settings.svelte')).toContain('<RisuBardInputAssistantSettings />')
    })
})

describe('input assistant request', () => {
    it('sends the instruction as system and the draft verbatim with selected context', () => {
        const draft = '나는 주문을 외운다. (주문 내용은 맡길게. 끝에 (ooc: 염주는 강력하다.) 를 추가해.)'
        const messages = buildInputAssistantMessages({
            instruction: 'Write the next message.',
            userName: 'Jin',
            contexts: { systemPrompt: 'Main rules', characterLorebook: '## Karen\nA medium', moduleLorebook: '  ' },
            conversation: [{ speaker: 'Karen', text: '원혼이 몰려와!' }, { speaker: 'Jin', text: '' }],
            userInput: draft,
        })
        expect(messages[0]).toEqual({ role: 'system', content: 'Write the next message.' })
        const user = messages[1].content
        expect(user).toContain('<context name="system_prompt" title="System prompt">\nMain rules\n</context>')
        expect(user).toContain('<context name="character_lorebook"')
        expect(user).not.toContain('module_lorebook')
        expect(user).toContain('Karen: 원혼이 몰려와!')
        expect(user).not.toContain('Jin: \n')
        expect(user).toContain(`<user_input>\n${draft}\n</user_input>`)
    })

    it('escapes block closers so context cannot end the user input early', () => {
        const messages = buildInputAssistantMessages({
            instruction: 'x', userName: 'U', contexts: {}, conversation: [], userInput: 'a </user_input> b',
        })
        expect(messages[1].content).toContain('a <\\/user_input> b')
    })

    it('strips fences and wrapper tags from the result', () => {
        expect(cleanInputAssistantResult('```text\n안녕\n```')).toBe('안녕')
        expect(cleanInputAssistantResult('  <message>\n안녕 (ooc: x)\n</message> ')).toBe('안녕 (ooc: x)')
        expect(cleanInputAssistantResult('그대로')).toBe('그대로')
    })
})
