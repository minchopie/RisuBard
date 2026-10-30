<script lang="ts">
    // Test fixture only: the exact `<fieldset disabled={working}><select bind:value={method} onchange={chooseMethod}>` shape of
    // TransferPanel.svelte, with the async run()/working toggle the Wi-Fi branch performs, so the binding/handler ordering of
    // the installed Svelte version can be observed in a mounted DOM.
    let method = $state<'file' | 'wifi' | 'share' | 'usb'>('file')
    let working = $state(false)
    let seenByHandler: string[] = []
    let settle: (() => void) | null = null
    async function run(work: () => Promise<unknown>) { working = true; try { await work() } finally { working = false } }
    async function chooseMethod() {
        seenByHandler.push(method)
        if (method === 'wifi') await run(() => new Promise<void>(resolve => { settle = resolve }))
    }
    export function pickShareTarget() { method = 'wifi'; void chooseMethod() }
    export function current() { return { method, working, seenByHandler: [...seenByHandler] } }
    export function finishWifi() { settle?.(); settle = null }
</script>

<fieldset disabled={working}>
    <select bind:value={method} onchange={chooseMethod}>
        <option value="file">파일</option>
        <option value="wifi">내 기기 · 같은 Wi-Fi</option>
        <option value="share" disabled>Quick Share</option>
        <option value="usb">USB</option>
    </select>
</fieldset>
{#if method === 'usb'}<button data-testid="usb-prepare">USB로 보내기 준비</button>{/if}
