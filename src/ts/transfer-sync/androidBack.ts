// RisuBard Android: the back key / back gesture goes to the previous screen instead of leaving the app.
// The app (MainActivity.onBackPressed) asks the page through `window.__risubardAndroidBack()` and keeps its
// old behaviour (leave the app) unless the page answers `true`. The page closes only the topmost open thing,
// with the close action that thing already has on screen (its close/cancel button or the store its own
// close button sets). Nothing new is decided here:
//   - a lock (start-up, account import, transfer/NAS apply, wait/progress dialogs, loading overlay) consumes
//     the key and closes nothing;
//   - a question is answered as its "no"/"cancel" button, never as "yes";
//   - a dialog without a close button (it wants a choice) is left as it is;
//   - leaving a chat while its reply is generating is refused (nothing happens);
//   - on the home screen with nothing left to close the app leaves as before.
// Browsers, the PC app and an older app (no hook call) are untouched: the hook is only installed in the
// Android app's WebView (RisuPlay bridge + RisuBardAndroid user agent).
import { get, type Readable, type Writable } from 'svelte/store'

type Store<T> = Readable<T> & Partial<Pick<Writable<T>, 'set'>>
type Alert = { type: string, msg?: string }

export type BackDeps = {
    doc: Document
    visible: (el: Element) => boolean
    desktop: () => boolean
    loaded: Readable<boolean>
    accountImportBlocking: Readable<boolean>
    transferBusy: Readable<boolean>
    alertStore: Writable<Alert>
    loadingOverlay: Readable<{ active?: boolean }>
    pluginAlert: { open: boolean }
    popup: { children: unknown }
    assetViewer: { open: boolean }
    closeAssetViewer: () => void
    /** Labels of the current UI language, read on every press (the language can change after install). */
    gobackLabel: () => string
    sendBusyLabels: () => string[]
    hypaV3ModalOpen: Writable<boolean>
    galleryOpen: Writable<boolean>
    settingsOpen: Writable<boolean>
    settingsMenuIndex: Writable<number>
    goBackInSettings: () => boolean
    dynamicGUI: Readable<boolean>
    sideBarStore: Readable<boolean>
    sideBarClosing: Writable<boolean>
    mobileGUI: Readable<boolean>
    mobileGUIStack: Writable<number>
    mobileSideBar: Writable<number>
    selectedCharID: Writable<number>
    generating: () => boolean
    playground: Writable<number>
    openRealm: Writable<boolean>
}

// Alert answers = the values AlertComp's own buttons write (src/lib/Others/AlertComp.svelte).
// Types not listed (select, selectChar, login, pukmakkurit, wait, wait2, progress, ...) have
// no cancel button or are progress: the key is consumed and the alert stays.
const ALERT_CANCEL: Record<string, string> = {
    ask: 'no', pluginconfirm: 'no', tos: 'no',     // 「아니오」 / Do not Accept
    confirmMulti: 'cancel', addchar: 'cancel',     // 「취소」
    input: '',                                     // 「취소」
    normal: '', error: '', markdown: '',           // only 「확인」: closing it acknowledges
    requestdata: '', branches: '',                 // ✖
}
// cardexport, selectModule: their dialog's own close (X) writes the cancel value (a component-local field, or
// ModuleChatMenu's close('')): left to the dialog rule below through that close button.

const SURFACES = '[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"],[role="dialog"][aria-modal="true"]:not([data-state]),.risu-modal-overlay:not([data-state])'
const HYPA_V3_OVERLAY = '.risu-modal-overlay.fixed.inset-0.z-40.p-1'
const CLOSE_LABELS = new Set(['닫기', 'Close', '뒤로'])
// Docked panels beside the chat/settings, closed by their own 「닫기」 button (topmost first).
const PANEL_CLOSERS = [
    '[data-lorebook-dock-close]',
    'button[aria-label="BardWiki 닫기"]',
    'button[aria-label="독자 게시판 닫기"]',
    'button[aria-label="캐릭터 비서 닫기"]',
    'button[aria-label="프롬프트 비서 닫기"]',
]

const enabled = (el: Element) => !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true'

/** The outermost explicit z-index above `el` (the one that orders it against the other layers). */
function layer(el: Element): number {
    let z = 0
    for (let node: Element | null = el; node && node !== node.ownerDocument.body; node = node.parentElement) {
        const value = parseInt(node.ownerDocument.defaultView?.getComputedStyle(node).zIndex ?? '', 10)
        if (!Number.isNaN(value)) z = value
    }
    return z
}

function topSurface(d: BackDeps): Element | null {
    const open = Array.from(d.doc.querySelectorAll(SURFACES)).filter(el => d.visible(el))
    let top: Element | null = null
    let topZ = -Infinity
    for (const el of open) { // document order: a later surface of the same layer is above
        const z = layer(el)
        if (z >= topZ) { top = el; topZ = z }
    }
    return top
}

/** The surface's own close button: the shared `.risu-modal-close`, or a header button named 닫기/Close/뒤로. */
function closeButton(d: BackDeps, surface: Element): HTMLElement | null {
    const own = (el: Element) => el.closest(SURFACES) === surface
    for (const el of Array.from(surface.querySelectorAll('.risu-modal-close'))) {
        if (own(el) && d.visible(el)) return enabled(el) ? el as HTMLElement : null
    }
    for (const el of Array.from(surface.querySelectorAll('.risu-modal-header button'))) {
        const name = el.getAttribute('aria-label') ?? el.getAttribute('title') ?? ''
        if (CLOSE_LABELS.has(name.trim()) && own(el) && d.visible(el)) return enabled(el) ? el as HTMLElement : null
    }
    return null
}

const click = (el: HTMLElement) => { el.click(); return true }

/** The chat composer shows a send in preparation or in progress (DefaultChatScreen preparingInput / sendingChat):
 *  the same reading as content-updates' composerBusy (appCodeUpdate.ts), synchronous here. */
function composerBusy(d: BackDeps): boolean {
    const labels = d.sendBusyLabels().filter(label => label.length > 0)
    if (labels.some(label => d.doc.querySelector(`[aria-label="${CSS.escape(label)}"],[title="${CSS.escape(label)}"]`))) return true
    return Array.from(d.doc.querySelectorAll('[role="status"]')).some(el => labels.includes(String(el.textContent ?? '').trim()))
}

/** The topmost docked panel's own 닫기 (and the narrow-screen side menu when it is open), as an action. */
function topPanel(d: BackDeps, sideMenuOpen: boolean): (() => boolean) | null {
    let best: { z: number, act: () => boolean } | null = null
    const offer = (el: Element, act: () => boolean) => { // document order: a later one of the same layer is above
        const z = layer(el)
        if (!best || z >= best.z) best = { z, act }
    }
    for (const selector of PANEL_CLOSERS) {
        for (const el of Array.from(d.doc.querySelectorAll(selector))) {
            if (d.visible(el)) offer(el, () => enabled(el) ? click(el as HTMLElement) : true)
        }
    }
    if (sideMenuOpen) {
        const host = d.doc.querySelector('[data-responsive-sidebar-host]')
        // The side menu's own close (Sidebar.svelte): start the closing animation; its end hides the menu.
        const act = () => { if (!get(d.sideBarClosing)) d.sideBarClosing.set(true); return true }
        if (host && d.visible(host)) offer(host, act)
        else if (!best) best = { z: 0, act }
    }
    return (best as { act: () => boolean } | null)?.act ?? null
}

function firstVisible(d: BackDeps, selector: string): HTMLElement | null {
    return Array.from(d.doc.querySelectorAll(selector)).find(el => d.visible(el)) as HTMLElement ?? null
}

/** One back press. Returns true when the page used it (something closed, or a lock kept it), false when the
 *  app should do its default (leave). Synchronous: the app waits for this answer. */
export function handleBack(d: BackDeps): boolean {
    // Locks: nothing is closed (also while starting: account import screen, start-up transfer/NAS recovery).
    if (get(d.accountImportBlocking) || get(d.transferBusy)) return true
    if (!get(d.loaded)) return false // plain start-up screen: as before
    if (d.doc.getElementById('risubard-server-stopped')) return true

    const alert = get(d.alertStore)
    if (alert?.type && alert.type !== 'none') {
        if (alert.type in ALERT_CANCEL) { d.alertStore.set({ type: 'none', msg: ALERT_CANCEL[alert.type] }); return true }
        // cardexport / selectModule: their dialog's own close button writes the cancel value (dialog rule below).
        if (alert.type !== 'cardexport' && alert.type !== 'selectModule') return true
    }
    if (get(d.loadingOverlay)?.active) return true
    // Plugin risk notice: 「설치하지 않음」 (PluginAlertModal: `pluginAlertModalStore.open = false`), never 「계속 설치」.
    if (d.pluginAlert.open) { d.pluginAlert.open = false; return true }

    // Small context popup (closes on any click).
    if (d.popup.children) { d.popup.children = null; return true }
    // Asset viewer: the zoomed picture's 「뒤로」 first, then the viewer's.
    if (d.assetViewer.open) {
        const goback = d.gobackLabel()
        const buttons = Array.from(d.doc.querySelectorAll('button')).filter(el => el.getAttribute('title') === goback && d.visible(el))
        const last = buttons[buttons.length - 1] as HTMLElement | undefined
        if (last) return click(last)
        d.closeAssetViewer(); return true
    }

    // Dialogs and modal overlays: the topmost one, by its own close button.
    const surface = topSurface(d)
    if (surface) {
        const button = closeButton(d, surface)
        if (button) return click(button)
        if (!surface.matches('.risu-modal-overlay')) return true // a dialog without a close button: it wants a choice
        // The long-term memory window's 「X」 (HypaV3Modal header) only sets its store; its backdrop does nothing.
        if (get(d.hypaV3ModalOpen) && surface.matches(HYPA_V3_OVERLAY)) { d.hypaV3ModalOpen.set(false); return true }
        // Other overlays: a tap on the backdrop, their own outside-click close (popup editor, bookmarks, model lists,
        // partial edit, trigger menu...). An overlay without one stays.
        surface.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        return true
    }

    // Full-screen composer (DefaultChatScreen): its own 「minimize」 (exitFullscreen); the text stays.
    const minimize = firstVisible(d, 'button[aria-label="minimize"]')
    if (minimize) return click(minimize)
    // BardWiki's chat settings popover: its own Escape handler (toggleSettings(false), stops there), not the whole panel.
    const popover = firstVisible(d, '[data-memory-settings-popover]')
    if (popover) {
        popover.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        return true
    }

    // Settings: a sub page's own back, then the page list (narrow screens), then settings closed.
    const mobile = get(d.mobileGUI)
    if (get(d.settingsOpen) || (mobile && get(d.selectedCharID) === -1 && get(d.mobileGUIStack) === 2)) {
        // Docked assistants stay beside settings: their own 닫기 first.
        const panel = topPanel(d, false)
        if (panel) return panel()
        if (d.goBackInSettings()) return true
        if (!d.desktop() && get(d.settingsMenuIndex) !== -1) { d.settingsMenuIndex.set(-1); return true }
        if (get(d.settingsOpen)) { d.settingsOpen.set(false); return true }
        d.mobileGUIStack.set(0); return true
    }

    // Docked panels and the narrow-screen side menu (it covers the screen): the topmost one.
    const panel = topPanel(d, !mobile && get(d.dynamicGUI) && get(d.sideBarStore))
    if (panel) return panel()
    if (mobile && get(d.selectedCharID) !== -1 && get(d.mobileSideBar) > 0) { d.mobileSideBar.set(0); return true }

    // Character gallery inside the chat area: its own close.
    if (get(d.selectedCharID) !== -1 && get(d.galleryOpen)) { d.galleryOpen.set(false); return true }

    // Character grid (wide layout): its own 「Back」.
    if (!mobile && !d.doc.querySelector('[data-character-sidebar]')) {
        const back = firstVisible(d, 'button[title="Back"]')
        if (back) return click(back)
    }

    // Chat -> home (the mobile header's back / the home hotkey), not while its reply is generating or a send is
    // being prepared (the composer's preparing/sending state, before a generation is registered).
    if (get(d.selectedCharID) !== -1) {
        if (d.generating() || composerBusy(d)) return true
        d.selectedCharID.set(-1); return true
    }

    // Home sub screens.
    const playground = get(d.playground)
    if (playground > 1) { d.playground.set(1); return true }
    if (playground === 1) { d.playground.set(0); return true }
    if (get(d.openRealm)) { d.openRealm.set(false); return true }
    if (mobile && get(d.mobileGUIStack) !== 0) { d.mobileGUIStack.set(0); return true }
    return false
}

const defaultVisible = (el: Element) => typeof (el as any).checkVisibility === 'function'
    ? (el as any).checkVisibility() : el.getClientRects().length > 0

/** Installs `window.__risubardAndroidBack` in the Android app only. */
export async function installAndroidBack(env: any = globalThis): Promise<boolean> {
    if (!env?.RisuPlay || !String(env.navigator?.userAgent ?? '').includes('RisuBardAndroid/')) return false
    const [stores, transfer, generation, settingsBack, assetViewer, lang] = await Promise.all([
        import('../stores.svelte'), import('./transferState'), import('../process/generationState'),
        import('../setting/settingsBack'), import('../assetViewer.svelte'), import('../../lang'),
    ])
    const desktop = env.matchMedia?.('(min-width: 768px)')
    const deps: BackDeps = {
        doc: env.document,
        visible: defaultVisible,
        desktop: () => !!desktop?.matches && !get(stores.MobileGUI),
        loaded: stores.loadedStore,
        accountImportBlocking: stores.accountImportBlocking,
        transferBusy: transfer.transferBusy,
        alertStore: stores.alertStore as Writable<Alert>,
        loadingOverlay: stores.loadingOverlayStore,
        pluginAlert: stores.pluginAlertModalStore,
        popup: stores.popupStore,
        assetViewer: assetViewer.assetViewerStore,
        closeAssetViewer: assetViewer.closeAssetViewer,
        gobackLabel: () => String((lang.language as any)?.goback ?? ''),
        sendBusyLabels: () => [(lang.language as any)?.chatSendPreparing, (lang.language as any)?.chatSendBusy].filter((l: unknown): l is string => typeof l === 'string'),
        hypaV3ModalOpen: stores.hypaV3ModalOpen,
        galleryOpen: stores.risuBardGalleryOpen,
        settingsOpen: stores.settingsOpen,
        settingsMenuIndex: stores.SettingsMenuIndex,
        goBackInSettings: settingsBack.goBackInSettings,
        dynamicGUI: stores.DynamicGUI,
        sideBarStore: stores.sideBarStore,
        sideBarClosing: stores.sideBarClosing,
        mobileGUI: stores.MobileGUI,
        mobileGUIStack: stores.MobileGUIStack,
        mobileSideBar: stores.MobileSideBar,
        selectedCharID: stores.selectedCharID,
        generating: () => {
            if (get(generation.doingChat)) return true
            const db: any = stores.DBState?.db
            const character = db?.characters?.[get(stores.selectedCharID)]
            const chat = character?.chats?.[character.chatPage]
            return !!chat && (!!chat.isStreaming || get(generation.generationStates).has(generation.chatGenKey(chat.id)))
        },
        playground: stores.PlaygroundStore,
        openRealm: stores.OpenRealmStore,
    }
    env.__risubardAndroidBack = () => {
        try { return handleBack(deps) } catch (error) { console.warn('[AndroidBack]', error); return false }
    }
    return true
}
