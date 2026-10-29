// Click-to-paint timing for risu-trigger buttons, for finding where a slow button spends its time.
// Off unless localStorage['risubard.debugTiming'] is '1' (set it in the devtools console, then reload).
// Each click prints its stages to the console as "[timing] <trigger> +<ms> <stage>", then a summary of the
// message renders and Lua runs that followed within the next two seconds.

function readFlag(): boolean {
    try {
        return globalThis.localStorage?.getItem('risubard.debugTiming') === '1'
    }
    catch {
        return false
    }
}

const enabled = readFlag()
let clickName = ''
let clickStart = 0
let summary: { renders: number, renderMs: number, luaRuns: Map<string, { n: number, ms: number }>, engines: string[] } | null = null

function since(): string {
    return (performance.now() - clickStart).toFixed(1)
}

export const debugTiming = {
    get on() { return enabled },
    // A button was pressed: starts a new measurement.
    click(name: string) {
        if (!enabled) return
        clickName = name
        clickStart = performance.now()
        summary = { renders: 0, renderMs: 0, luaRuns: new Map(), engines: [] }
        console.log(`[timing] ${clickName} +0.0 click`)
        setTimeout(() => {
            if (!summary) return
            const lua = [...summary.luaRuns.entries()].map(([mode, v]) => `${mode} x${v.n} ${v.ms.toFixed(1)}ms`).join(', ')
            console.log(`[timing] ${clickName} summary: message renders ${summary.renders} (${summary.renderMs.toFixed(1)}ms), lua: ${lua || 'none'}, new engines: ${summary.engines.join(', ') || 'none'}`)
            summary = null
        }, 2000)
    },
    stage(stage: string) {
        if (!enabled || !summary) return
        console.log(`[timing] ${clickName} +${since()} ${stage}`)
    },
    // The next two animation frames after a stage: roughly when the browser has painted it.
    afterPaint(stage: string) {
        if (!enabled || !summary) return
        requestAnimationFrame(() => requestAnimationFrame(() => debugTiming.stage(stage)))
    },
    render(idx: number, ms: number) {
        if (!enabled || !summary) return
        summary.renders += 1
        summary.renderMs += ms
        console.log(`[timing] ${clickName} +${since()} message ${idx} rendered in ${ms.toFixed(1)}ms`)
    },
    lua(mode: string, ms: number) {
        if (!enabled || !summary) return
        const v = summary.luaRuns.get(mode) ?? { n: 0, ms: 0 }
        v.n += 1
        v.ms += ms
        summary.luaRuns.set(mode, v)
    },
    engine(mode: string, ms: number) {
        if (!enabled || !summary) return
        summary.engines.push(`${mode} (${ms.toFixed(1)}ms)`)
        console.log(`[timing] ${clickName} +${since()} new Lua engine for "${mode}" took ${ms.toFixed(1)}ms`)
    },
}
