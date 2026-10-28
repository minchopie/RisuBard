import { afterEach, expect, test, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import { localAI } from 'src/ts/localAI.svelte'
const api = vi.hoisted(() => ({ request: vi.fn(), refresh: vi.fn() }))
vi.mock('src/ts/localAI', () => ({ localAIRequest: api.request, refreshLocalAI: api.refresh }))
import LocalAISettings from './LocalAISettings.svelte'
let component: ReturnType<typeof mount>
afterEach(async () => { if (component) await unmount(component); document.body.innerHTML = ''; vi.resetAllMocks() })

test('mode toggle preserves fresh server limits and Apply alone saves edited limits', async () => {
    Object.assign(localAI, { available: true, enabled: true, context: 4096, output: 512 })
    let saved = { enabled: true, context: 2048, output: 128 }
    api.refresh.mockImplementation(async () => { Object.assign(localAI, saved) })
    api.request.mockImplementation(async (_path, init) => {
        saved = JSON.parse(init.body)
        return Response.json(saved)
    })
    component = mount(LocalAISettings, { target: document.body }); flushSync()
    const click = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text)!.click()
    click('온라인 설정으로 전환')
    await vi.waitFor(() => expect(saved).toEqual({ enabled: false, context: 2048, output: 128 }))
    flushSync()
    const context = document.getElementById('local-ai-context') as HTMLInputElement
    const output = document.getElementById('local-ai-output') as HTMLInputElement
    expect(context.value).toBe('2048'); expect(output.value).toBe('128')
    context.value = '1024'; context.dispatchEvent(new Event('input', { bubbles: true }))
    output.value = '64'; output.dispatchEvent(new Event('input', { bubbles: true })); flushSync()
    click('적용')
    await vi.waitFor(() => expect(saved).toEqual({ enabled: false, context: 1024, output: 64 }))
})
