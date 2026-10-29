import fc from 'fast-check'
import { writable } from 'svelte/store'
import { beforeEach, expect, test, vi } from 'vitest'
import { DBState } from '../../stores.svelte'
import { getChatVar, getGlobalChatVar, setChatVar, setGlobalChatVar, setScriptGlobalChatVar } from '../chatVar.svelte'
import { resetChatVariables } from './cbs/lib'
import { risuChatParser } from '../parser.svelte'
import type { Chat } from '../../storage/database.svelte'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

test.each(['editdisplay', 'editoutput'])('sequential %s regex rules do not accumulate parser recursion depth', async (mode) => {
  const source = readFileSync('src/ts/process/scripts.ts', 'utf8')
  const tree = ts.createSourceFile('scripts.ts', source, ts.ScriptTarget.Latest, true)
  const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'processScriptFullInternal')!
  const code = ts.transpileModule(fn.getText(tree), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
  const deps = {
    getDatabase:()=>DBState.db, getCurrentCharacter:()=>undefined,
    runLuaEditTrigger:async (_:unknown,_mode:unknown,text:string)=>text,
    pluginV2:{[mode]:new Set()}, risuChatParser,
    getModuleRegexScripts:()=>[], generateScriptCacheKey:()=>'', getScriptCache:()=>undefined,
    cacheScript:()=>{}, compileScriptRegex:(pattern:string,flags:string)=>new RegExp(pattern,flags),
    dreg:/{{data}}/g,
  }
  const run = new Function(...Object.keys(deps), `${code};return processScriptFullInternal`)(...Object.values(deps))
  const char = {...DBState.db.characters[0],type:'character',customscript:Array.from({length:25},()=>({type:mode,in:'원문',out:'원문',ableFlag:false}))}
  const result = await run(char,'보존해야 하는 원문',mode)
  expect(result.data).toBe('보존해야 하는 원문')
})

//#region module mocks

vi.mock(
  import('../../storage/database.svelte'),
  () =>
    ({
      appVer: '1234.5.67',
      getCurrentCharacter: () => ({}),
      getDatabase: () => DBState.db,
    } as typeof import('../../storage/database.svelte'))
)

vi.mock(import('../../globalApi.svelte'), () => ({
  aiWatermarkingLawApplies: () => false,
  getFileSrc: () => Promise.resolve(''),
}))

vi.mock(import('../../stores.svelte'), () => {
  return {
    DBState: {
      db: {
        characters: [
          {
            chatPage: 0,
            chats: [
              {
                scriptstate: {},
              },
            ],
            defaultVariables: '',
          },
        ],
        globalChatVariables: {},
        templateDefaultVariables: '',
      },
    },
    selIdState: {
      selId: 0,
    },
    selectedCharID: writable(0),
  } as typeof import('../../stores.svelte')
})

//#endregion

const anyValidDefaultVarKey = fc.string({ minLength: 1, unit: 'grapheme' }).filter((s) => !/[=\n]/.test(s))
const anyValidDefaultVarValue = fc
  .anything()
  .map(JSON.stringify)
  .filter((s) => s !== undefined && !/[=\n]/.test(s))

beforeEach(() => {
  vi.resetAllMocks()
  resetChatVariables()
})

test('can get a character default variable', () => {
  fc.assert(
    fc.property(anyValidDefaultVarKey, anyValidDefaultVarValue, (key, value) => {
      DBState.db.characters[0].defaultVariables = `${key}=${value}`
      expect(getChatVar(key)).toBe(value)
    })
  )
})

test('keeps parser variables and messages on A while B is selected', () => {
  const character = DBState.db.characters[0]
  const a = { name: 'A', note: '', localLore: [], scriptstate: { $count: '2' }, message: [{ role: 'char', data: 'A reply' }], useLocallySetGlobalVariables: true, GLGlobalVariables: { toggle_scene: 'A' } } as Chat
  const b = { name: 'B', note: '', localLore: [], scriptstate: { $count: '9' }, message: [{ role: 'char', data: 'B reply' }] } as Chat
  const previousChats = character.chats
  character.chats = [a, b]
  character.chatPage = 1
  try {
    expect(getChatVar('count', character, a)).toBe('2')
    expect(getGlobalChatVar('toggle_scene', a)).toBe('A')
    expect(risuChatParser('{{addvar::count::1}}{{getvar::count}}/{{lastcharmessage}}/{{getglobalvar::toggle_scene}}/{{#when::count::vis::3}}yes{{/}}', { chara: character, chat: a, runVar: true })).toBe('3/A reply/A/yes')
    expect(a.scriptstate.$count).toBe('3')
    expect(b.scriptstate.$count).toBe('9')
    expect(getChatVar('count')).toBe('9')
  } finally {
    character.chats = previousChats
    character.chatPage = 0
  }
})

test('uses A persona and nested variables while B is selected', () => {
  const character = DBState.db.characters[0]
  const a = { name: 'A', note: '', localLore: [], bindedPersona: 'persona-a', scriptstate: { $scene: 'A scene' }, message: [] } as Chat
  const b = { name: 'B', note: '', localLore: [], bindedPersona: 'persona-b', scriptstate: { $scene: 'B scene' }, message: [] } as Chat
  const previousChats = character.chats
  const previousPersonas = character.personas
  character.chats = [a, b]
  character.chatPage = 1
  character.personas = [
    { id: 'persona-a', name: 'A user', personaPrompt: '{{getvar::scene}}', icon: '' },
    { id: 'persona-b', name: 'B user', personaPrompt: '{{getvar::scene}}', icon: '' },
  ]
  try {
    expect(risuChatParser('{{user}}/{{persona}}', { chara: character, chat: a })).toBe('A user/A scene')
    expect(risuChatParser('{{user}}/{{persona}}')).toBe('B user/B scene')
  } finally {
    character.chats = previousChats
    character.personas = previousPersonas
    character.chatPage = 0
  }
})

test('can get a template default variable', () => {
  fc.assert(
    fc.property(anyValidDefaultVarKey, anyValidDefaultVarValue, (key, value) => {
      DBState.db.templateDefaultVariables = `${key}=${value}`
      expect(getChatVar(key)).toBe(value)
    })
  )
})

test('can set and get a chat variable', () => {
  fc.assert(
    fc.property(
      fc.string({ unit: 'grapheme' }),
      fc
        .anything()
        .filter((v) => v !== undefined)
        .map(JSON.stringify),
      (key, value) => {
        setChatVar(key, value)
        expect(getChatVar(key)).toBe(value)
      }
    )
  )
})

test('can set a chat variable over its default value', () => {
  DBState.db.characters[0].defaultVariables = 'char=default'
  DBState.db.templateDefaultVariables = 'template=default'

  setChatVar('char', 'overridden')
  setChatVar('template', 'overridden')

  expect(getChatVar('char')).toBe('overridden')
  expect(getChatVar('template')).toBe('overridden')
})

test('can get a global chat variable', () => {
  fc.assert(
    fc.property(
      fc.string({ unit: 'grapheme' }),
      fc
        .anything()
        .filter((v) => v !== undefined)
        .map(JSON.stringify),
      (key, value) => {
        DBState.db.globalChatVariables[`toggle_${key}`] = value

        expect(getGlobalChatVar(`toggle_${key}`)).toBe(value)
      }
    )
  )
})

test('reports whether setting a chat variable changed its stored value', () => {
  expect(setChatVar('scene', 'rain')).toBe(true)
  expect(setChatVar('scene', 'rain')).toBe(false)
  expect(setChatVar('scene', 'sun')).toBe(true)
  expect(getChatVar('scene')).toBe('sun')
})

test('uses an own per-chat override even when its value is empty', () => {
  const chat = DBState.db.characters[0].chats[0] as typeof DBState.db.characters[0]['chats'][0] & {
    useLocallySetGlobalVariables?: boolean
    GLGlobalVariables?: Record<string, string>
  }
  DBState.db.globalChatVariables.toggle_weather = 'sunny'
  chat.useLocallySetGlobalVariables = true
  chat.GLGlobalVariables = { toggle_weather: '' }

  expect(getGlobalChatVar('toggle_weather')).toBe('')
})

test('falls back to the global value when the pinned chat has no own override', () => {
  const chat = DBState.db.characters[0].chats[0] as typeof DBState.db.characters[0]['chats'][0] & {
    useLocallySetGlobalVariables?: boolean
    GLGlobalVariables?: Record<string, string>
  }
  DBState.db.globalChatVariables.toggle_weather = 'sunny'
  chat.useLocallySetGlobalVariables = true
  chat.GLGlobalVariables = {}

  expect(getGlobalChatVar('toggle_weather')).toBe('sunny')
})

test('writes global variables into the current chat only while local overrides are enabled', () => {
  const chat = DBState.db.characters[0].chats[0] as typeof DBState.db.characters[0]['chats'][0] & {
    useLocallySetGlobalVariables?: boolean
    GLGlobalVariables?: Record<string, string>
  }
  DBState.db.globalChatVariables.toggle_weather = 'sunny'
  chat.useLocallySetGlobalVariables = true

  setGlobalChatVar('toggle_weather', 'rainy')

  expect(chat.GLGlobalVariables).toEqual({ toggle_weather: 'rainy' })
  expect(DBState.db.globalChatVariables.toggle_weather).toBe('sunny')

  chat.useLocallySetGlobalVariables = false
  setGlobalChatVar('toggle_weather', 'cloudy')

  expect(DBState.db.globalChatVariables.toggle_weather).toBe('cloudy')
})

test('ignores per-chat overrides while toggle binding is globally disabled', () => {
  const chat = DBState.db.characters[0].chats[0] as typeof DBState.db.characters[0]['chats'][0] & {
    useLocallySetGlobalVariables?: boolean
    GLGlobalVariables?: Record<string, string>
  }
  DBState.db.globalChatVariables.toggle_weather = 'global'
  DBState.db.disableToggleBinding = true
  chat.useLocallySetGlobalVariables = true
  chat.GLGlobalVariables = { toggle_weather: 'local' }

  expect(getGlobalChatVar('toggle_weather')).toBe('global')
  setGlobalChatVar('toggle_weather', 'updated-global')
  expect(DBState.db.globalChatVariables.toggle_weather).toBe('updated-global')
  expect(chat.GLGlobalVariables.toggle_weather).toBe('local')

  DBState.db.disableToggleBinding = false
})

test('script global writes persist to the database even in a chat with pinned toggles', () => {
  const chat = DBState.db.characters[0].chats[0] as typeof DBState.db.characters[0]['chats'][0] & {
    useLocallySetGlobalVariables?: boolean
    GLGlobalVariables?: Record<string, string>
  }
  chat.useLocallySetGlobalVariables = true
  chat.GLGlobalVariables = { toggle_weather: 'local' }

  setScriptGlobalChatVar('mha_img_scale', '70', chat)

  expect(DBState.db.globalChatVariables.mha_img_scale).toBe('70')
  expect(chat.GLGlobalVariables).toEqual({ toggle_weather: 'local' })
  expect(getGlobalChatVar('mha_img_scale', chat)).toBe('70')

  chat.useLocallySetGlobalVariables = false
  chat.GLGlobalVariables = undefined
})

test('script toggle writes stay in the chat that owns its toggle values', () => {
  const chat = DBState.db.characters[0].chats[0] as typeof DBState.db.characters[0]['chats'][0] & {
    useLocallySetGlobalVariables?: boolean
    GLGlobalVariables?: Record<string, string>
  }
  DBState.db.globalChatVariables.toggle_mood = 'calm'
  chat.useLocallySetGlobalVariables = true
  chat.GLGlobalVariables = {}

  setScriptGlobalChatVar('toggle_mood', 'tense', chat)

  expect(chat.GLGlobalVariables).toEqual({ toggle_mood: 'tense' })
  expect(DBState.db.globalChatVariables.toggle_mood).toBe('calm')

  chat.useLocallySetGlobalVariables = false
  chat.GLGlobalVariables = undefined
})

test('the wiki prompt guide renders with the current chat toggle scope', () => {
  const source = readFileSync('src/ts/process/index.svelte.ts', 'utf8')
  const start = source.indexOf('function renderWikiPromptGuide')
  const body = source.slice(start, source.indexOf('\n}', start))
  expect(body).toContain('getChatToggleScope(')
  expect(body).not.toContain('DBState.db.globalChatVariables')
})

test('returns "null" for undefined variables', () => {
  fc.assert(
    fc.property(fc.string({ unit: 'grapheme' }), (key) => {
      expect(getChatVar(key)).toBe('null')
      expect(getGlobalChatVar(`toggle_${key}`)).toBe('null')
    })
  )
})
