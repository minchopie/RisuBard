// Mounted reproduction attempt for the live .77 phone report: after pickShareTarget() switched the method to Wi-Fi, choosing
// "USB" in the select left the method on Wi-Fi. Exercises the exact `bind:value` + `onchange` + `fieldset disabled={working}`
// shape of TransferPanel.svelte in a real DOM (happy-dom) with the installed Svelte, including a change that arrives while the
// Wi-Fi branch's run() still holds `working` (fieldset disabled) and one after it settled.
import { afterEach, expect, test } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import SelectBindOrder from './__fixtures__/SelectBindOrder.svelte'

let mounted: ReturnType<typeof mount> | undefined
afterEach(async () => { if (mounted) await unmount(mounted); mounted = undefined; document.body.innerHTML = '' })

const select = () => document.querySelector('select') as HTMLSelectElement
// happy-dom 20 does not resolve `:checked` on <option>; Svelte's select binding reads the chosen option through exactly that
// selector. Answer it from selectedIndex so the binding sees what a browser would (verified: selectedIndex/option.selected are right).
const nativeQuery = HTMLSelectElement.prototype.querySelector
HTMLSelectElement.prototype.querySelector = function (this: HTMLSelectElement, sel: string) { return sel === ':checked' ? (this.options[this.selectedIndex] ?? null) : nativeQuery.call(this, sel) } as any
const chooseInDom = (value: string) => { select().value = value; select().dispatchEvent(new Event('change', { bubbles: true })); flushSync() }

test('select binding updates the state before the onchange handler runs; the USB branch renders after a user change', () => {
    mounted = mount(SelectBindOrder, { target: document.body }) as any
    flushSync()
    chooseInDom('usb')
    expect((mounted as any).current()).toMatchObject({ method: 'usb', seenByHandler: ['usb'] })
    expect(document.querySelector('[data-testid="usb-prepare"]')).not.toBeNull()
    expect(select().value).toBe('usb')
})

test('after pickShareTarget() (programmatic wifi + async run holding the fieldset disabled), a user change to USB is kept once the fieldset is enabled again; while disabled the DOM select cannot be changed by the user, but a change event that does arrive is not reverted to wifi', async () => {
    mounted = mount(SelectBindOrder, { target: document.body }) as any
    const api = mounted as any
    api.pickShareTarget(); flushSync()
    expect(api.current()).toMatchObject({ method: 'wifi', working: true, seenByHandler: ['wifi'] })
    expect((document.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
    expect(select().value).toBe('wifi')
    // A change event while run() is still pending (the Wi-Fi device scan): the binding still applies it; nothing writes wifi back.
    chooseInDom('usb')
    expect(api.current()).toMatchObject({ method: 'usb', seenByHandler: ['wifi', 'usb'] })
    expect(select().value).toBe('usb')
    api.finishWifi(); await Promise.resolve(); await Promise.resolve(); flushSync()
    expect(api.current()).toMatchObject({ method: 'usb', working: false })
    expect((document.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(false)
    expect(document.querySelector('[data-testid="usb-prepare"]')).not.toBeNull()
    // And the same after the scan settled first (the reported sequence: scan done, dropdown opened, USB tapped).
    api.pickShareTarget(); flushSync(); api.finishWifi(); await Promise.resolve(); await Promise.resolve(); flushSync()
    expect(api.current()).toMatchObject({ method: 'wifi', working: false })
    chooseInDom('usb')
    expect(api.current()).toMatchObject({ method: 'usb' }); expect(select().value).toBe('usb')
})
