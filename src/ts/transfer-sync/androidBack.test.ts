import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { get, writable } from 'svelte/store'
import { handleBack, installAndroidBack, type BackDeps } from './androidBack'

// Each test builds the screen it needs; `hidden` marks an element as not shown (happy-dom has no layout).
function setup(over: Partial<BackDeps> = {}) {
    const d: BackDeps = {
        doc: document,
        visible: (el) => !el.closest('[hidden]'),
        desktop: () => false,
        loaded: writable(true),
        accountImportBlocking: writable(false),
        transferBusy: writable(false),
        alertStore: writable({ type: 'none', msg: '' }),
        loadingOverlay: writable({ active: false }),
        pluginAlert: { open: false },
        popup: { children: null },
        assetViewer: { open: false },
        closeAssetViewer: vi.fn(),
        gobackLabel: () => '뒤로',
        sendBusyLabels: () => ['보낼 준비 중', '보내는 중'],
        hypaV3ModalOpen: writable(false),
        galleryOpen: writable(false),
        settingsOpen: writable(false),
        settingsMenuIndex: writable(-1),
        goBackInSettings: vi.fn(() => false),
        dynamicGUI: writable(true),
        sideBarStore: writable(false),
        sideBarClosing: writable(false),
        mobileGUI: writable(false),
        mobileGUIStack: writable(0),
        mobileSideBar: writable(0),
        selectedCharID: writable(-1),
        generating: () => false,
        playground: writable(0),
        openRealm: writable(false),
        ...over,
    }
    return d
}
const html = (markup: string) => { document.body.innerHTML = markup }
// The Sidebar is mounted on every screen except the wide character grid.
const sidebar = '<div data-responsive-sidebar-host hidden><aside data-character-sidebar></aside></div>'

beforeEach(() => html(sidebar))
afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('home with nothing open: the app leaves as before', () => {
    expect(handleBack(setup())).toBe(false)
})

test('start-up screen leaves as before; account import, transfer/NAS apply (also while starting) and the stopped-server cover keep the key', () => {
    expect(handleBack(setup({ loaded: writable(false), selectedCharID: writable(3) }))).toBe(false)
    for (const lock of [{ accountImportBlocking: writable(true) }, { transferBusy: writable(true) }]) {
        const d = setup({ ...lock, selectedCharID: writable(3) })
        expect(handleBack(d)).toBe(true)
        expect(get(d.selectedCharID)).toBe(3)
        expect(handleBack(setup({ ...lock, loaded: writable(false) }))).toBe(true) // start-up recovery / account import screen
    }
    html(sidebar + '<div id="risubard-server-stopped"></div>')
    const d = setup({ selectedCharID: writable(3) })
    expect(handleBack(d)).toBe(true)
    expect(get(d.selectedCharID)).toBe(3)
})

test('questions are answered as their no/cancel button, never yes; acknowledgements close', () => {
    const cases: [string, string][] = [['ask', 'no'], ['pluginconfirm', 'no'], ['tos', 'no'], ['confirmMulti', 'cancel'], ['addchar', 'cancel'],
        ['input', ''], ['normal', ''], ['error', ''], ['markdown', ''], ['requestdata', ''], ['branches', '']]
    for (const [type, msg] of cases) {
        const d = setup({ alertStore: writable({ type, msg: 'question' }), selectedCharID: writable(2) })
        expect(handleBack(d)).toBe(true)
        expect(get(d.alertStore)).toEqual({ type: 'none', msg })
        expect(get(d.selectedCharID)).toBe(2) // only the alert closed
    }
})

test('progress, wait and choice-only alerts stay and keep the key', () => {
    for (const type of ['wait', 'wait2', 'progress', 'select', 'selectChar', 'login', 'pukmakkurit']) {
        const d = setup({ alertStore: writable({ type, msg: 'x' }), selectedCharID: writable(2) })
        expect(handleBack(d)).toBe(true)
        expect(get(d.alertStore).type).toBe(type)
        expect(get(d.selectedCharID)).toBe(2)
    }
})

test('the loading overlay keeps the key', () => {
    const d = setup({ loadingOverlay: writable({ active: true }), settingsOpen: writable(true) })
    expect(handleBack(d)).toBe(true)
    expect(get(d.settingsOpen)).toBe(true)
})

test('plugin risk notice: back = 「설치하지 않음」 (open=false only; errors stay, unlike 「계속 설치」)', () => {
    const pluginAlert = { open: true, errors: ['risk'] }
    const d = setup({ pluginAlert, settingsOpen: writable(true) })
    expect(handleBack(d)).toBe(true)
    expect(pluginAlert).toEqual({ open: false, errors: ['risk'] })
    expect(get(d.settingsOpen)).toBe(true)
})

test('module picker / card export alerts close through the own close button of their dialog', () => {
    html(sidebar + '<div role="dialog" data-state="open"><div class="risu-modal-header"><button class="risu-modal-close" id="x"></button></div></div>')
    const clicked = vi.fn()
    document.getElementById('x')!.addEventListener('click', clicked)
    for (const type of ['selectModule', 'cardexport']) {
        const d = setup({ alertStore: writable({ type, msg: '' }) })
        expect(handleBack(d)).toBe(true)
    }
    expect(clicked).toHaveBeenCalledTimes(2)
})

test('full-screen composer: its own minimize, the chat stays', () => {
    html(sidebar + '<div class="fixed inset-0 z-50"><button aria-label="minimize" id="min"></button><textarea></textarea></div>')
    const clicked = vi.fn()
    document.getElementById('min')!.addEventListener('click', clicked)
    const d = setup({ selectedCharID: writable(1) })
    expect(handleBack(d)).toBe(true)
    expect(clicked).toHaveBeenCalledOnce()
    expect(get(d.selectedCharID)).toBe(1)
})

test('BardWiki chat settings popover closes by its own Escape handler, not the whole BardWiki panel', () => {
    html(sidebar + '<section><button aria-label="BardWiki 닫기" id="wiki"></button><div role="dialog" data-memory-settings-popover id="pop"></div></section>')
    const wiki = vi.fn(), pop = vi.fn(), doc = vi.fn()
    document.getElementById('wiki')!.addEventListener('click', wiki)
    document.getElementById('pop')!.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape') { e.stopPropagation(); pop() } })
    document.addEventListener('keydown', doc)
    try {
        expect(handleBack(setup({ selectedCharID: writable(0) }))).toBe(true)
        expect(pop).toHaveBeenCalledOnce()
        expect(wiki).not.toHaveBeenCalled()
        expect(doc).not.toHaveBeenCalled() // stopped at the popover: no global Escape action
    } finally { document.removeEventListener('keydown', doc) }
})

test('leaving a chat is refused while a send is being prepared or sent (composer state, before a generation exists)', () => {
    for (const markup of ['<button aria-label="보낼 준비 중"></button>', '<button title="보내는 중"></button>', '<span role="status">보낼 준비 중</span>']) {
        html(sidebar + markup)
        const d = setup({ selectedCharID: writable(6) })
        expect(handleBack(d)).toBe(true)
        expect(get(d.selectedCharID)).toBe(6)
    }
})

test('a context popup closes first', () => {
    const d = setup({ popup: { children: () => {} }, settingsOpen: writable(true) })
    expect(handleBack(d)).toBe(true)
    expect(d.popup.children).toBe(null)
    expect(get(d.settingsOpen)).toBe(true)
})

test('asset viewer: the zoomed picture closes before the viewer', () => {
    html(sidebar + '<div><button title="뒤로" id="viewer"></button></div><div><button title="뒤로" id="zoom"></button></div>')
    const d = setup({ assetViewer: { open: true } })
    const clicked: string[] = []
    for (const id of ['viewer', 'zoom']) document.getElementById(id)!.addEventListener('click', () => clicked.push(id))
    expect(handleBack(d)).toBe(true)
    expect(clicked).toEqual(['zoom'])
    html(sidebar)
    expect(handleBack(d)).toBe(true)
    expect(d.closeAssetViewer).toHaveBeenCalledOnce()
})

test('the topmost dialog closes by its own close button; the one below stays', () => {
    html(sidebar + `
        <div role="dialog" data-state="open" style="z-index: 40"><div class="risu-modal-header"><button class="risu-modal-close" id="low"></button></div></div>
        <div role="dialog" data-state="open" style="z-index: 50"><div class="risu-modal-header"><button class="risu-modal-close" id="high"></button></div></div>
        <div role="dialog" data-state="open" style="z-index: 45"><button class="risu-modal-close" id="mid"></button></div>`)
    const clicked: string[] = []
    for (const id of ['low', 'high', 'mid']) document.getElementById(id)!.addEventListener('click', () => clicked.push(id))
    const d = setup({ settingsOpen: writable(true) })
    expect(handleBack(d)).toBe(true)
    expect(clicked).toEqual(['high'])
    expect(get(d.settingsOpen)).toBe(true)
})

test('same layer: the later (newer) dialog is on top; hidden dialogs are ignored', () => {
    html(sidebar + `
        <div role="dialog" data-state="open"><button class="risu-modal-close" id="first"></button></div>
        <div role="dialog" data-state="open"><button class="risu-modal-close" id="second"></button></div>
        <div role="dialog" data-state="open" hidden><button class="risu-modal-close" id="hidden"></button></div>`)
    const clicked: string[] = []
    for (const id of ['first', 'second', 'hidden']) document.getElementById(id)!.addEventListener('click', () => clicked.push(id))
    handleBack(setup())
    expect(clicked).toEqual(['second'])
})

test('a dialog without a close button (it wants a choice) or with a disabled one stays and keeps the key', () => {
    html(sidebar + '<div role="dialog" data-state="open"><button id="choice">A</button></div>')
    const d = setup({ selectedCharID: writable(1) })
    const clicked = vi.fn()
    document.getElementById('choice')!.addEventListener('click', clicked)
    expect(handleBack(d)).toBe(true)
    expect(clicked).not.toHaveBeenCalled()
    expect(get(d.selectedCharID)).toBe(1)
    html(sidebar + '<div role="dialog" data-state="open"><button class="risu-modal-close" disabled id="x"></button></div>')
    document.getElementById('x')!.addEventListener('click', clicked)
    expect(handleBack(d)).toBe(true)
    expect(clicked).not.toHaveBeenCalled()
})

test('a header button named 닫기 counts as the close button; a nested dialog\'s close is not the outer one\'s', () => {
    html(sidebar + `<div role="dialog" data-state="open"><div class="risu-modal-header"><button aria-label="닫기" id="named"></button></div>
        <div role="dialog" aria-modal="true" hidden><button class="risu-modal-close" id="inner"></button></div></div>`)
    const clicked: string[] = []
    for (const id of ['named', 'inner']) document.getElementById(id)!.addEventListener('click', () => clicked.push(id))
    handleBack(setup())
    expect(clicked).toEqual(['named'])
})

test('custom overlays: their .risu-modal-close, else a tap on their backdrop (their own outside-click close)', () => {
    html(sidebar + '<div class="risu-modal-overlay"><button class="risu-modal-close" id="chatlist"></button></div>')
    const clicked = vi.fn()
    document.getElementById('chatlist')!.addEventListener('click', clicked)
    handleBack(setup())
    expect(clicked).toHaveBeenCalledOnce()

    // e.g. bookmarks / model lists: `onclick={(e) => { if (e.target === e.currentTarget) close() }}`
    html(sidebar + '<div class="risu-modal-overlay" id="ov"><div class="risu-modal-surface"><button id="inside">item</button></div></div>')
    const closed = vi.fn(), inside = vi.fn()
    const ov = document.getElementById('ov')!
    ov.addEventListener('click', (e) => { if (e.target === e.currentTarget) closed() })
    document.getElementById('inside')!.addEventListener('click', inside)
    const d = setup({ selectedCharID: writable(2) })
    expect(handleBack(d)).toBe(true)
    expect(closed).toHaveBeenCalledOnce()
    expect(inside).not.toHaveBeenCalled()
    expect(get(d.selectedCharID)).toBe(2)
})

test('long-term memory window: its X sets the store (its backdrop does nothing); its own sub windows close first', () => {
    html(sidebar + '<div class="risu-modal-overlay fixed inset-0 z-40 p-1"><div>summaries</div></div>')
    const d = setup({ hypaV3ModalOpen: writable(true) })
    expect(handleBack(d)).toBe(true)
    expect(get(d.hypaV3ModalOpen)).toBe(false)
    html(sidebar + '<div class="risu-modal-overlay fixed inset-0 z-40 p-1"></div><div class="risu-modal-overlay fixed inset-0 z-50 p-4"><button class="risu-modal-close" id="tags"></button></div>')
    const tags = vi.fn()
    document.getElementById('tags')!.addEventListener('click', tags)
    const e = setup({ hypaV3ModalOpen: writable(true) })
    handleBack(e)
    expect(tags).toHaveBeenCalledOnce()
    expect(get(e.hypaV3ModalOpen)).toBe(true)
})

test('an open dialog wins over settings, panels and the chat', () => {
    html(sidebar + '<button aria-label="BardWiki 닫기" id="wiki"></button><div role="dialog" data-state="open"><button class="risu-modal-close" id="x"></button></div>')
    const clicked: string[] = []
    for (const id of ['wiki', 'x']) document.getElementById(id)!.addEventListener('click', () => clicked.push(id))
    handleBack(setup({ selectedCharID: writable(0) }))
    expect(clicked).toEqual(['x'])
})

test('settings: an assistant beside it, then a sub page back, then the page list, then settings closed', () => {
    html(sidebar + '<button aria-label="프롬프트 비서 닫기" id="assistant"></button>')
    const clicked = vi.fn()
    document.getElementById('assistant')!.addEventListener('click', clicked)
    const sub = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    const d = setup({ settingsOpen: writable(true), settingsMenuIndex: writable(14), goBackInSettings: sub })
    expect(handleBack(d)).toBe(true)
    expect(clicked).toHaveBeenCalledOnce()
    html(sidebar)
    expect(handleBack(d)).toBe(true) // module sub page -> module list (upstream registerSettingsBack)
    expect(get(d.settingsMenuIndex)).toBe(14)
    expect(handleBack(d)).toBe(true) // narrow screen: page -> page list
    expect(get(d.settingsMenuIndex)).toBe(-1)
    expect(get(d.settingsOpen)).toBe(true)
    expect(handleBack(d)).toBe(true) // list -> closed
    expect(get(d.settingsOpen)).toBe(false)
})

test('settings on a wide screen (page beside the list) closes like Escape', () => {
    const d = setup({ desktop: () => true, settingsOpen: writable(true), settingsMenuIndex: writable(16) })
    expect(handleBack(d)).toBe(true)
    expect(get(d.settingsOpen)).toBe(false)
    expect(get(d.settingsMenuIndex)).toBe(16)
})

test('docked panels close one at a time, the topmost first', () => {
    html(sidebar + `<div style="z-index: 10"><button aria-label="BardWiki 닫기" id="wiki"></button></div>
        <div style="z-index: 20"><button aria-label="캐릭터 비서 닫기" id="char"></button></div>
        <button data-lorebook-dock-close id="lore" hidden></button>`)
    const clicked: string[] = []
    for (const id of ['wiki', 'char', 'lore']) document.getElementById(id)!.addEventListener('click', () => clicked.push(id))
    const d = setup({ selectedCharID: writable(0) })
    handleBack(d)
    expect(clicked).toEqual(['char'])
    expect(get(d.selectedCharID)).toBe(0)
})

test('narrow layout: the side menu closes with its own closing animation, before the chat is left', () => {
    html('<div data-responsive-sidebar-host style="z-index: 30"><aside data-character-sidebar></aside></div>')
    const d = setup({ sideBarStore: writable(true), selectedCharID: writable(4) })
    expect(handleBack(d)).toBe(true)
    expect(get(d.sideBarClosing)).toBe(true)
    expect(get(d.selectedCharID)).toBe(4)
    // the wide layout keeps its permanent sidebar
    const wide = setup({ dynamicGUI: writable(false), sideBarStore: writable(true), selectedCharID: writable(4) })
    expect(handleBack(wide)).toBe(true)
    expect(get(wide.sideBarClosing)).toBe(false)
    expect(get(wide.selectedCharID)).toBe(-1)
})

test('chat -> home like the header back; refused while its reply is generating', () => {
    const busy = setup({ selectedCharID: writable(5), generating: () => true })
    expect(handleBack(busy)).toBe(true)
    expect(get(busy.selectedCharID)).toBe(5)
    const d = setup({ selectedCharID: writable(5) })
    expect(handleBack(d)).toBe(true)
    expect(get(d.selectedCharID)).toBe(-1)
    expect(handleBack(d)).toBe(false) // now home: leave
})

test('character gallery closes before the chat is left', () => {
    const d = setup({ selectedCharID: writable(1), galleryOpen: writable(true) })
    handleBack(d)
    expect(get(d.galleryOpen)).toBe(false)
    expect(get(d.selectedCharID)).toBe(1)
})

test('wide character grid: its own Back button', () => {
    html('<div><button title="Back" id="grid"></button></div>')
    const clicked = vi.fn()
    document.getElementById('grid')!.addEventListener('click', clicked)
    expect(handleBack(setup({ dynamicGUI: writable(false) }))).toBe(true)
    expect(clicked).toHaveBeenCalledOnce()
})

test('mobile layout: menu -> chat -> home tab; settings page -> list -> home tab', () => {
    const d = setup({ mobileGUI: writable(true), dynamicGUI: writable(false), selectedCharID: writable(2), mobileSideBar: writable(1), mobileGUIStack: writable(1) })
    handleBack(d)
    expect(get(d.mobileSideBar)).toBe(0)
    expect(get(d.selectedCharID)).toBe(2)
    handleBack(d)
    expect(get(d.selectedCharID)).toBe(-1)
    handleBack(d)
    expect(get(d.mobileGUIStack)).toBe(0)
    expect(handleBack(d)).toBe(false)

    const s = setup({ mobileGUI: writable(true), mobileGUIStack: writable(2), settingsMenuIndex: writable(3) })
    handleBack(s)
    expect(get(s.settingsMenuIndex)).toBe(-1)
    handleBack(s)
    expect(get(s.mobileGUIStack)).toBe(0)
    expect(handleBack(s)).toBe(false)
})

test('home sub screens: playground tool -> playground -> home, realm -> home', () => {
    const d = setup({ playground: writable(4) })
    handleBack(d); expect(get(d.playground)).toBe(1)
    handleBack(d); expect(get(d.playground)).toBe(0)
    const r = setup({ openRealm: writable(true) })
    handleBack(r); expect(get(r.openRealm)).toBe(false)
    expect(handleBack(r)).toBe(false)
})

test('browsers and the PC app get no hook', async () => {
    const env: any = { navigator: { userAgent: 'Mozilla/5.0 Chrome' }, document }
    expect(await installAndroidBack(env)).toBe(false)
    expect(env.__risubardAndroidBack).toBeUndefined()
    const noBridge: any = { navigator: { userAgent: 'Mozilla/5.0 RisuBardAndroid/0.9.96-ver9' }, document }
    expect(await installAndroidBack(noBridge)).toBe(false)
    expect(noBridge.__risubardAndroidBack).toBeUndefined()
    const pcBridge: any = { RisuPlay: {}, navigator: { userAgent: 'Mozilla/5.0 Chrome' }, document }
    expect(await installAndroidBack(pcBridge)).toBe(false)
})

test('the Android app gets a hook that answers with a boolean; a failure answers false (the app leaves as before)', async () => {
    const env: any = { RisuPlay: {}, navigator: { userAgent: 'Mozilla/5.0 RisuBardAndroid/0.9.96-ver9' }, document, matchMedia: () => ({ matches: false }) }
    expect(await installAndroidBack(env)).toBe(true)
    expect(env.__risubardAndroidBack()).toBe(false) // still starting: as before
    const stores = await import('../stores.svelte')
    const lang = await import('../../lang')
    const viewer = await import('../assetViewer.svelte')
    const savedLang = lang.language
    const savedKey = localStorage.getItem('risu-lang')
    stores.loadedStore.set(true)
    try {
        expect(env.__risubardAndroidBack()).toBe(false) // home, nothing open
        stores.selectedCharID.set(0)
        expect(env.__risubardAndroidBack()).toBe(true) // chat -> home
        expect(get(stores.selectedCharID)).toBe(-1)
        const broken: any = { ...env, document: null }
        await installAndroidBack(broken)
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        expect(broken.__risubardAndroidBack()).toBe(false)
        expect(warn).toHaveBeenCalled()

        // The installed hook reads the labels of the language in use at each press (changeLanguage after install).
        lang.changeLanguage('ko')
        const ko = lang.language as any
        expect(ko.chatSendPreparing).toBeTruthy()
        stores.selectedCharID.set(0)
        html(sidebar + `<button aria-label="${ko.chatSendPreparing}"></button>`)
        expect(env.__risubardAndroidBack()).toBe(true)
        expect(get(stores.selectedCharID)).toBe(0) // a send being prepared: the chat stays
        html(sidebar + `<div><button title="${ko.goback}" id="viewer"></button></div><div><button title="${ko.goback}" id="zoom"></button></div>`)
        const clicked: string[] = []
        for (const id of ['viewer', 'zoom']) document.getElementById(id)!.addEventListener('click', () => clicked.push(id))
        viewer.assetViewerStore.open = true
        expect(env.__risubardAndroidBack()).toBe(true)
        expect(clicked).toEqual(['zoom'])
        expect(viewer.assetViewerStore.open).toBe(true)
    } finally {
        stores.loadedStore.set(false); stores.selectedCharID.set(-1)
        viewer.assetViewerStore.open = false
        lang.changeLanguage('en')
        if (savedKey === null) localStorage.removeItem('risu-lang'); else localStorage.setItem('risu-lang', savedKey)
        expect(lang.language).toStrictEqual(savedLang) // back to the language the file started with
    }
}, 120_000) // first import of the real stores/alert modules is slow

test('labels are read on every press: after a language change the preparing send and the zoomed picture are still found', () => {
    let lang = 'en'
    const labels = { en: { goback: 'Go Back', busy: ['Preparing', 'Sending'] }, ko: { goback: '뒤로', busy: ['보낼 준비 중', '보내는 중'] } } as const
    const d = setup({ selectedCharID: writable(3), gobackLabel: () => labels[lang as 'en' | 'ko'].goback, sendBusyLabels: () => [...labels[lang as 'en' | 'ko'].busy] })
    lang = 'ko' // changeLanguage() after the hook was installed
    html(sidebar + '<button aria-label="보낼 준비 중"></button>')
    expect(handleBack(d)).toBe(true)
    expect(get(d.selectedCharID)).toBe(3)
    html(sidebar + '<div><button title="뒤로" id="viewer"></button></div><div><button title="뒤로" id="zoom"></button></div>')
    const clicked: string[] = []
    for (const id of ['viewer', 'zoom']) document.getElementById(id)!.addEventListener('click', () => clicked.push(id))
    d.assetViewer.open = true
    expect(handleBack(d)).toBe(true)
    expect(clicked).toEqual(['zoom'])
    expect(d.closeAssetViewer).not.toHaveBeenCalled()
})
