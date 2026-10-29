import { beforeEach, describe, expect, test, vi } from 'vitest'
import { writable } from 'svelte/store'

const wasm = vi.hoisted(() => ({
  createCount: 0,
  failNextCreate: false,
  engines: [] as FakeLuaEngine[],
  workers: [] as FakeWorker[],
}))

const globalVars = vi.hoisted(() => new Map<string, string>())

class FakeLuaGlobal {
  values = new Map<string, unknown>()
  closed = false

  set(name: string, value: unknown) {
    this.values.set(name, value)
  }

  get(name: string) {
    return this.values.get(name)
  }

  close() {
    this.closed = true
  }
}

class FakeLuaEngine {
  global = new FakeLuaGlobal()
  source = ''

  async doString(source: string) {
    this.source = source
    if (source.includes('STATE_CHANGE_PROBE')) {
      this.global.set('stateChangeProbe', (id: string) => {
        const setter = this.global.get('setChatVarChanged') as
          | ((id: string, key: string, value: string) => boolean | undefined)
          | undefined
        if (!setter) return 'missing'
        return [setter(id, '__scene', '"rain"'), setter(id, '__scene', '"rain"')]
      })
    }
    if (source.includes('GLOBAL_VAR_PROBE')) {
      this.global.set('globalVarProbe', (id: string) => {
        const set = this.global.get('setGlobalVar') as (id: string, key: string, value: unknown) => void
        const getGlobal = this.global.get('getGlobalVar') as (id: string, key: string) => string
        set(id, 'mha_img_scale', 70)
        set(id, 'toggle_detail', '1')
        set(id, '', 'empty')
        set('forged-id', 'mha_hagakure', 'visible')
        return [getGlobal(id, 'mha_img_scale'), getGlobal(id, 'toggle_detail'), getGlobal(id, 'mha_hagakure')]
      })
    }
    if (source.includes('FULL_CHAT_PROBE')) {
      this.global.set('fullChatProbe', (id: string) => {
        const getFull = this.global.get('getFullChatMain') as (id: string) => string
        const setFull = this.global.get('setFullChatMain') as (id: string, value: string) => void
        const chats = JSON.parse(getFull(id)) as { role: string, data: string }[]
        setFull(id, JSON.stringify(chats.map(chat => ({ ...chat, data: chat.data.toUpperCase() }))))
      })
    }
    if (source.includes('CONTEXT_REUSE_PROBE')) {
      this.global.set('context-reuse', (id: string) => {
        const stopChat = this.global.get('stopChat') as ((id: string) => void) | undefined
        const upsertLocalLoreBook = this.global.get('upsertLocalLoreBook') as
          | ((id: string, name: string, content: string, options: object) => void)
          | undefined
        stopChat?.(id)
        upsertLocalLoreBook?.(id, 'context-probe', 'current character', {})
      })
    }
  }
}

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  terminated = false

  constructor() {
    wasm.workers.push(this)
  }

  postMessage(message: { id?: string; type?: string }) {
    queueMicrotask(() => {
      if (message.type === 'init') {
        this.onmessage?.({ data: { id: message.id, type: 'init' } } as MessageEvent)
      } else if (message.type === 'python') {
        this.onmessage?.({ data: { id: message.id, type: 'python', call: null } } as MessageEvent)
      }
    })
  }

  terminate() {
    this.terminated = true
  }
}

vi.mock('wasmoon', () => ({
  LuaEngine: FakeLuaEngine,
  LuaFactory: class {
    async mountFile() {}

    async createEngine() {
      wasm.createCount += 1
      if (wasm.failNextCreate) {
        wasm.failNextCreate = false
        throw new Error('engine creation failed')
      }
      const engine = new FakeLuaEngine()
      wasm.engines.push(engine)
      return engine
    }
  },
}))

vi.mock(import('../parser/chatVar.svelte'), () => ({
  getChatVar: vi.fn(() => 'null'),
  getGlobalChatVar: vi.fn((key: string) => globalVars.get(key) ?? 'null'),
  setChatVar: vi.fn(() => true),
  setScriptGlobalChatVar: vi.fn((key: string, value: string) => { globalVars.set(key, value) }),
}))

vi.mock(import('../parser/parser.svelte'), () => ({
  hasher: async () => '',
  risuChatParser: (value: string) => value,
}))

vi.mock('../storage/database.svelte', () => ({
  getCurrentCharacter: () => ({ type: 'simple', name: 'Test', triggerscript: [] }),
  getCurrentChat: () => ({ message: [] }),
  getDatabase: () => ({ characters: [] }),
  setDatabase: () => {},
}))

vi.mock(import('../stores.svelte'), () => ({
  ReloadChatPointer: writable<Record<number, number>>({}),
  ReloadGUIPointer: writable(0),
  selectedCharID: writable(0),
}))

vi.mock(import('../alert'), () => ({
  alertSelect: vi.fn(), alertError: vi.fn(), alertInput: vi.fn(), alertNormal: vi.fn(), alertConfirm: vi.fn(),
}))

vi.mock('./memory/hypamemory', () => ({
  HypaProcesser: class {
    async addText() {}
    async similaritySearch() { return [] }
  },
}))

vi.mock(import('./stableDiff'), () => ({ generateAIImage: vi.fn() }))
vi.mock(import('./files/inlays'), () => ({ writeInlayImage: vi.fn(), getInlayAsset: vi.fn() }))
vi.mock(import('./request/request'), () => ({ requestChatData: vi.fn() }))
vi.mock(import('./modules'), () => ({ getModuleLorebooks: () => [], getModuleTriggers: () => [] }))
vi.mock(import('../tokenizer'), () => ({ tokenize: async () => 0 }))
vi.mock(import('../globalApi.svelte'), () => ({ fetchNative: vi.fn(), readImage: vi.fn() }))
vi.mock(import('./lorebook.svelte'), () => ({ loadLoreBookV3Prompt: vi.fn() }))
vi.mock('../util', () => ({
  asBuffer: (value: unknown) => value,
  getPersonaPrompt: () => '', getUserName: () => '', getUserIcon: () => '',
}))

type ScriptingsModule = typeof import('./scriptings')

async function loadScriptings(): Promise<ScriptingsModule> {
  vi.resetModules()
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, text: async () => '' })))
  return import('./scriptings')
}

function chatWithMessages() {
  return {
    message: [
      { role: 'user' as const, data: 'first', time: 10, swipes: ['large-copy'] },
      { role: 'char' as const, data: 'second', time: undefined, multimodals: [{ type: 'image' }] },
      { role: 'user' as const, data: 'third', time: 30, chatId: 'unrelated' },
    ],
  }
}

beforeEach(() => {
  wasm.createCount = 0
  wasm.failNextCreate = false
  wasm.engines = []
  wasm.workers = []
  vi.unstubAllGlobals()
})

describe('lightweight chat scripting APIs', () => {
  test('pins default Lua variable access to the supplied chat across initialization', async () => {
    const { runScripted } = await loadScriptings()
    const { setChatVar, getChatVar, getGlobalChatVar } = await import('../parser/chatVar.svelte')
    vi.mocked(setChatVar).mockClear()
    const chats = [{ id: 'A', message: [] }, { id: 'B', message: [] }]
    const character = { type: 'character', chatPage: 0, chats }
    const running = runScripted('-- STATE_CHANGE_PROBE', {
      mode: 'stateChangeProbe', char: character as never, chat: chats[0] as never,
    })
    character.chatPage = 1
    await running
    expect(setChatVar).toHaveBeenCalledWith('__scene', '"rain"', chats[0])
    const globals = wasm.engines[0].global.values
    ;(globals.get('getChatVar') as Function)('id', 'owner')
    ;(globals.get('getGlobalVar') as Function)('id', 'mode')
    expect(getChatVar).toHaveBeenCalledWith('owner', character, chats[0])
    expect(getGlobalChatVar).toHaveBeenCalledWith('mode', chats[0])
  })

  test('setGlobalVar writes a string global that getGlobalVar reads back, refusing toggle_ and empty keys', async () => {
    globalVars.clear()
    const { runScripted } = await loadScriptings()
    const { setScriptGlobalChatVar } = await import('../parser/chatVar.svelte')
    vi.mocked(setScriptGlobalChatVar).mockClear()
    const chat = { id: 'A', message: [] }
    const result = await runScripted('-- GLOBAL_VAR_PROBE', { mode: 'globalVarProbe', chat: chat as never })

    expect(result.res).toEqual(['70', 'null', 'null'])
    expect(setScriptGlobalChatVar).toHaveBeenCalledTimes(1)
    expect(setScriptGlobalChatVar).toHaveBeenCalledWith('mha_img_scale', '70', chat)
    expect(globalVars.has('toggle_detail')).toBe(false)
    expect(globalVars.has('')).toBe(false)
  })

  test('setFullChat keeps message identity, timing and BardWiki state of rewritten messages', async () => {
    const { runScripted } = await loadScriptings()
    const chat = {
      id: 'A',
      message: [
        { role: 'user' as const, data: 'hi', chatId: 'u1', time: 10 },
        { role: 'char' as const, data: 'reply', chatId: 'c1', time: 20, saying: 'bot', risubardMemoryConfirmed: true },
      ],
    }
    const result = await runScripted('-- FULL_CHAT_PROBE', { mode: 'fullChatProbe', chat: chat as never })
    expect(result.chat.message).toEqual([
      { role: 'user', data: 'HI', chatId: 'u1', time: 10 },
      { role: 'char', data: 'REPLY', chatId: 'c1', time: 20, saying: 'bot', risubardMemoryConfirmed: true },
    ])
  })

  test('exposes direct message fields without copying unrelated message data', async () => {
    const { runScripted } = await loadScriptings()
    await runScripted('', { mode: 'chatApiProbe', chat: chatWithMessages() as never })
    const globals = wasm.engines[0].global.values

    expect((globals.get('getChatData') as Function)('id', 1)).toBe('second')
    expect((globals.get('getChatRole') as Function)('id', 1)).toBe('char')
    expect((globals.get('getChatData') as Function)('id', 99)).toBe('')
    expect((globals.get('getChatRole') as Function)('id', 99)).toBe('')
  })

  test('returns only role, data, and time for a bounded recent slice', async () => {
    const { runScripted } = await loadScriptings()
    await runScripted('', { mode: 'recentChatsProbe', chat: chatWithMessages() as never })
    const recent = wasm.engines[0].global.values.get('getRecentChatsMain') as Function

    expect(JSON.parse(recent('id', 2.9))).toEqual([
      { role: 'char', data: 'second', time: 0 },
      { role: 'user', data: 'third', time: 30 },
    ])
    expect(JSON.parse(recent('id', -1))).toEqual([])
    expect(JSON.parse(recent('id', Number.POSITIVE_INFINITY))).toEqual([])
  })

  test('surfaces no-op state writes through setStateChanged without changing setState', async () => {
    const values = new Map<string, string>()
    const setVar = (key: string, value: string) => {
      if (values.get(key) === value) return false
      values.set(key, value)
      return true
    }
    const { runScripted } = await loadScriptings()
    const result = await runScripted('-- STATE_CHANGE_PROBE', {
      mode: 'stateChangeProbe', chat: { message: [] } as never, setVar,
    })

    expect(result.res).toEqual([true, false])
    expect(wasm.engines[0].source).toContain('function setStateChanged')
    expect(wasm.engines[0].source).toContain('function setState(id, name, value)')
  })
})

describe('bounded scripting engine lifecycle', () => {
  test('reuses one runtime for concurrent calls with the same mode, type, and code', async () => {
    const { runScripted } = await loadScriptings()
    await Promise.all([
      runScripted('-- same', { mode: 'shared', chat: { message: [] } as never }),
      runScripted('-- same', { mode: 'shared', chat: { message: [] } as never }),
    ])
    expect(wasm.createCount).toBe(1)
  })

  test('rebuilds and closes the runtime when code changes', async () => {
    const { runScripted } = await loadScriptings()
    await runScripted('-- first', { mode: 'code-change', chat: { message: [] } as never })
    const first = wasm.engines[0]
    await runScripted('-- second', { mode: 'code-change', chat: { message: [] } as never })
    expect(first.global.closed).toBe(true)
    expect(wasm.createCount).toBe(2)
  })

  test('refreshes per-run character and stop state when reusing the same runtime', async () => {
    const { runScripted } = await loadScriptings()
    const makeCharacter = () => ({
      type: 'character' as const,
      chats: [{ message: [], localLore: [] as Array<{ comment: string }> }],
      chatPage: 0,
    })
    const first = makeCharacter()
    const second = makeCharacter()

    const firstResult = await runScripted('-- CONTEXT_REUSE_PROBE', {
      mode: 'context-reuse', char: first as never, chat: first.chats[0] as never,
    })
    const secondResult = await runScripted('-- CONTEXT_REUSE_PROBE', {
      mode: 'context-reuse', char: second as never, chat: second.chats[0] as never,
    })

    expect(wasm.createCount).toBe(1)
    expect(firstResult.stopSending).toBe(true)
    expect(secondResult.stopSending).toBe(true)
    expect(first.chats[0].localLore).toHaveLength(1)
    expect(second.chats[0].localLore).toHaveLength(1)
  })

  test('rebuilds the runtime when low-level permission changes', async () => {
    const { runScripted } = await loadScriptings()
    await runScripted('-- permission', {
      mode: 'permission-change', lowLevelAccess: false, chat: { message: [] } as never,
    })
    const first = wasm.engines[0]
    await runScripted('-- permission', {
      mode: 'permission-change', lowLevelAccess: true, chat: { message: [] } as never,
    })

    expect(first.global.closed).toBe(true)
    expect(wasm.createCount).toBe(2)
  })

  test('retries the same code after runtime creation fails', async () => {
    const { runScripted } = await loadScriptings()
    wasm.failNextCreate = true

    await expect(runScripted('-- retry', {
      mode: 'retry-create', chat: { message: [] } as never,
    })).rejects.toThrow('engine creation failed')
    await runScripted('-- retry', { mode: 'retry-create', chat: { message: [] } as never })

    expect(wasm.createCount).toBe(2)
    expect(wasm.engines).toHaveLength(1)
  })

  test('invalidates the prior identity when a rebuild fails', async () => {
    const { runScripted } = await loadScriptings()
    await runScripted('-- stable', { mode: 'failed-rebuild', chat: { message: [] } as never })
    const first = wasm.engines[0]
    wasm.failNextCreate = true

    await expect(runScripted('-- changed', {
      mode: 'failed-rebuild', chat: { message: [] } as never,
    })).rejects.toThrow('engine creation failed')
    await runScripted('-- stable', { mode: 'failed-rebuild', chat: { message: [] } as never })

    expect(first.global.closed).toBe(true)
    expect(wasm.createCount).toBe(3)
    expect(wasm.engines.filter((engine) => !engine.global.closed)).toHaveLength(1)
  })

  test('disposes the previous engine when a mode changes language type', async () => {
    const { runScripted } = await loadScriptings()
    await runScripted('-- lua', { mode: 'type-change', type: 'lua', chat: { message: [] } as never })
    const lua = wasm.engines[0]
    await runScripted('# python', { mode: 'type-change', type: 'py', chat: { message: [] } as never })
    expect(lua.global.closed).toBe(true)
    expect(wasm.workers).toHaveLength(1)
  })

  test('evicts and disposes least-recently-used modes beyond the fixed cache cap', async () => {
    const { runScripted } = await loadScriptings()
    for (let index = 0; index < 9; index += 1) {
      await runScripted(`-- ${index}`, { mode: `mode-${index}`, chat: { message: [] } as never })
    }
    expect(wasm.engines[0].global.closed).toBe(true)
    expect(wasm.engines.filter((engine) => !engine.global.closed)).toHaveLength(8)
  })

  test('provides an explicit reset that disposes every cached runtime', async () => {
    const scriptings = await loadScriptings()
    await scriptings.runScripted('-- one', { mode: 'reset-one', chat: { message: [] } as never })
    await scriptings.runScripted('-- two', { mode: 'reset-two', chat: { message: [] } as never })
    const reset = (scriptings as unknown as { resetScriptingEngineCache?: () => Promise<void> })
      .resetScriptingEngineCache
    expect(reset).toBeTypeOf('function')
    await reset?.()
    expect(wasm.engines.every((engine) => engine.global.closed)).toBe(true)
  })
})
