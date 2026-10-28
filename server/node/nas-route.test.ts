// Home/external NAS route: pure decision matrix, Windows adapter classification, bounded probe, per-run async-context pinning
// (concurrent runs isolated), stale reports. Synthetic names and hosts only.
import { test, expect, vi } from 'vitest'
const { createNasRoute, decide, parseNetsh, classifyAdapters, probeUrl } = require('./nas-route.cjs')

const cfg = { url: 'https://nas.invalid/home/RisuAI/', homeUrl: 'https://nas-home.invalid:5006/home/RisuAI/', homeSsids: ['Fixture Home 2G', 'Fixture Home 5G'] }

test('decision matrix: registered SSIDs → home; other/unknown/redacted SSID → external; cellular/none/unknown transport → external without probing; only a verified wired transport probes', () => {
    expect(decide(cfg, { transport: 'wifi', ssid: 'Fixture Home 2G' })).toMatchObject({ url: cfg.homeUrl, route: 'home', reason: 'home-ssid' })
    expect(decide(cfg, { transport: 'wifi', ssid: 'Fixture Home 5G' })).toMatchObject({ route: 'home' }) // both bands of the same router
    expect(decide(cfg, { transport: 'wifi', ssid: 'Cafe' })).toMatchObject({ url: cfg.url, route: 'external', reason: 'other-ssid' })
    expect(decide(cfg, { transport: 'wifi', ssid: null })).toMatchObject({ route: 'external', reason: 'unknown-ssid' })
    expect(decide(cfg, { transport: 'wifi', ssid: '' })).toMatchObject({ route: 'external', reason: 'unknown-ssid' })
    expect(decide(cfg, { transport: 'wifi', ssid: 'fixture home 2g' })).toMatchObject({ route: 'external' }) // exact match only
    expect(decide(cfg, { transport: 'cellular', ssid: null })).toMatchObject({ route: 'external', reason: 'no-lan' })
    expect(decide(cfg, { transport: 'none', ssid: null })).toMatchObject({ route: 'external', reason: 'no-lan' })
    expect(decide(cfg, { transport: 'unknown', ssid: null }, true)).toMatchObject({ route: 'external', reason: 'unknown-transport' }) // never home by default
    expect(decide(cfg, { transport: 'ethernet', ssid: null }, true)).toMatchObject({ route: 'home', reason: 'probe-ok' })
    expect(decide(cfg, { transport: 'ethernet', ssid: null }, false)).toMatchObject({ route: 'external', reason: 'probe-failed' })
    expect(decide(cfg, { transport: 'ethernet', ssid: null }, undefined)).toMatchObject({ route: 'external', reason: 'probe-pending' })
    expect(decide(cfg, { transport: 'ethernet', ssid: 'Fixture Home 2G' }, false)).toMatchObject({ route: 'external' }) // an SSID only counts on Wi-Fi
    expect(decide({ url: cfg.url }, { transport: 'wifi', ssid: 'Fixture Home 2G' })).toMatchObject({ url: cfg.url, route: 'single' })
})

test('Windows detection: adapter media types decide the transport (802.11 → Wi-Fi + netsh SSID, 802.3 → wired); netsh without an SSID is not "wired"; nothing verified → unknown', () => {
    expect(classifyAdapters('Native 802.11\r\n', null)).toEqual({ transport: 'wifi', ssid: null }) // Wi-Fi up but SSID unreadable (permission/redaction): unknown-ssid → external
    expect(classifyAdapters(['Native 802.11'], 'Interface name : Wi-Fi\n    State : connected\n    SSID : Fixture Home 2G\n    BSSID : aa:bb\n')).toEqual({ transport: 'wifi', ssid: 'Fixture Home 2G' })
    expect(classifyAdapters(['802.3'], 'There is no wireless interface on the system.')).toEqual({ transport: 'ethernet', ssid: null })
    expect(classifyAdapters(['802.3', 'Native 802.11'], 'SSID : Fixture Home 5G')).toEqual({ transport: 'wifi', ssid: 'Fixture Home 5G' }) // Wi-Fi wins when both are up: the SSID rule applies
    expect(classifyAdapters('', 'SSID : Fixture Home 5G')).toEqual({ transport: 'unknown', ssid: null }) // no verified adapter: netsh text alone never makes a transport
    expect(classifyAdapters(['Unspecified'], null)).toEqual({ transport: 'unknown', ssid: null })
    expect(parseNetsh('인터페이스 이름 : Wi-Fi\n    상태 : 연결됨\n    SSID : Fixture Home 5G\n    BSSID : aa:bb\n')).toBe('Fixture Home 5G')
    expect(parseNetsh('    BSSID : aa:bb\n')).toBeNull()
})

test('probe is bounded and strict: any HTTPS answer counts, a hanging endpoint fails within the timeout, a late answer is destroyed, plain HTTP is refused', async () => {
    const destroyed = vi.fn()
    expect(await probeUrl(cfg.homeUrl, { fetch: async () => ({ statusCode: 401, destroy: destroyed }) })).toBe(true); expect(destroyed).toHaveBeenCalled()
    let late: (v: any) => void = () => {}
    const started = Date.now()
    expect(await probeUrl(cfg.homeUrl, { fetch: () => new Promise(resolve => { late = resolve }), timeoutMs: 60 })).toBe(false)
    expect(Date.now() - started).toBeLessThan(2000)
    const lateDestroy = vi.fn(); late({ destroy: lateDestroy }); await new Promise(r => setTimeout(r, 0)); expect(lateDestroy).toHaveBeenCalled()
    expect(await probeUrl(cfg.homeUrl, { fetch: async () => { throw new Error('ECONNREFUSED') } })).toBe(false)
    await expect(probeUrl('http://nas-home.invalid/x', { fetch: async () => ({}) })).rejects.toThrow()
})

test('route object: fresh reports decide; a stale report is unknown (external, no probe); only a detected wired adapter probes (cached, invalidate re-probes); a detector failure is unknown', async () => {
    let now = 1_000_000; const probe = vi.fn(async () => true)
    const secrets = { get: async () => cfg }
    const r = createNasRoute({ secrets, probe, now: () => now, detect: async () => ({ transport: 'ethernet', ssid: null }) })
    r.report({ transport: 'wifi', ssid: 'Fixture Home 2G' })
    expect(await r.urlFor(cfg)).toBe(cfg.homeUrl); expect(probe).not.toHaveBeenCalled()
    now += 121_000 // the client stopped reporting (app hidden): the old "home" is not trusted and the detector is NOT consulted for a client-reporting host
    expect(await r.resolve()).toMatchObject({ route: 'external', reason: 'unknown-transport' }); expect(probe).not.toHaveBeenCalled()
    const wired = createNasRoute({ secrets, probe, now: () => now, detect: async () => ({ transport: 'ethernet', ssid: null }) })
    expect(await wired.resolve()).toMatchObject({ route: 'home', reason: 'probe-ok' }); expect(probe).toHaveBeenCalledTimes(1)
    await wired.resolve(); expect(probe).toHaveBeenCalledTimes(1) // cached
    wired.invalidate(); await wired.resolve(); expect(probe).toHaveBeenCalledTimes(2)
    const failing = createNasRoute({ secrets, probe, now: () => now, detect: async () => { throw new Error('no adapter api') } })
    expect(await failing.resolve()).toMatchObject({ route: 'external', reason: 'unknown-transport' })
    const unknownAdapters = createNasRoute({ secrets, probe, now: () => now, detect: async () => ({ transport: 'unknown', ssid: null }) })
    expect(await unknownAdapters.resolve()).toMatchObject({ route: 'external', reason: 'unknown-transport' })
})

test('pinning is per run in an async context: nested runs keep one URL while the network flips; a run suspended inside its probe does not leak an unpinned or shared decision to concurrent runs', async () => {
    const secrets = { get: async () => cfg }
    const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
    const probeStarted = deferred<void>(), probeAnswer = deferred<boolean>()
    let probes = 0
    const r = createNasRoute({ secrets, probe: async () => { probes++; probeStarted.resolve(); return probeAnswer.promise } })
    // Nested runs and a flip inside one run: one URL throughout.
    r.report({ transport: 'wifi', ssid: 'Fixture Home 2G' })
    const urls: string[] = []
    await r.run(async () => {
        urls.push(await r.urlFor(cfg)); r.report({ transport: 'wifi', ssid: 'Cafe' })
        await r.run(async () => { urls.push(await r.urlFor(cfg)) })
        urls.push(await r.urlFor(cfg)); expect((await r.status()).pinned).toBe(true)
    })
    expect(new Set(urls)).toEqual(new Set([cfg.homeUrl])); expect((await r.status()).pinned).toBe(false)
    // Overlap with explicit barriers. A: wired → must probe; the probe is held open so A is suspended inside resolve.
    r.report({ transport: 'ethernet', ssid: null })
    const holdA = deferred<void>(), aUrls: string[] = []
    const a = r.run(async () => { aUrls.push(await r.urlFor(cfg)); await holdA.promise; aUrls.push(await r.urlFor(cfg)) })
    await probeStarted.promise // A is now inside its (unresolved) probe: no decision exists for it yet
    // B starts on another network while A is suspended: B must get its own, pinned decision (old code: depth 1 but pinned null → B ran unpinned).
    r.report({ transport: 'wifi', ssid: 'Cafe' })
    const bSeen: any[] = []
    const b = await r.run(async () => { const first = await r.urlFor(cfg); bSeen.push((await r.status()).pinned); r.report({ transport: 'wifi', ssid: 'Fixture Home 2G' }); return [first, await r.urlFor(cfg)] })
    expect(b).toEqual([cfg.url, cfg.url]); expect(bSeen).toEqual([true]); expect(probes).toBe(1) // B never probed and never waited for A
    // Release A's probe: A decides home and keeps running (held). C starts meanwhile on a cafe network: its own decision, not A's.
    probeAnswer.resolve(true); await new Promise(resolve => setTimeout(resolve, 0)); expect(aUrls).toEqual([cfg.homeUrl])
    r.report({ transport: 'wifi', ssid: 'Cafe' })
    expect(await r.run(() => r.urlFor(cfg))).toBe(cfg.url) // old code: shared A's pin → home (wrong)
    r.report({ transport: 'wifi', ssid: 'Fixture Home 5G' })
    holdA.resolve(); await a
    expect(aUrls).toEqual([cfg.homeUrl, cfg.homeUrl]) // A's second request still uses A's own decision
    expect((await r.status()).pinned).toBe(false)
    await expect(r.run(async () => { throw new Error('boom') })).rejects.toThrow('boom'); expect((await r.status()).pinned).toBe(false)
})

test('registering the current Wi-Fi stores the name next to the same account; unknown SSID or non-Wi-Fi refuses; forget removes', async () => {
    let saved: any = { ...cfg, username: 'u', password: 'p', homeSsids: ['Fixture Home 2G'] }
    const secrets = { get: async () => saved, set: async (_k: string, v: any) => { saved = v } }
    const r = createNasRoute({ secrets, probe: async () => false })
    r.report({ transport: 'ethernet', ssid: null }); await expect(r.registerCurrent()).rejects.toThrow()
    r.report({ transport: 'wifi', ssid: null }); await expect(r.registerCurrent()).rejects.toThrow()
    r.report({ transport: 'wifi', ssid: 'Fixture Home 5G' }); expect(await r.registerCurrent()).toEqual({ registered: true, count: 2 })
    expect(saved.homeSsids).toEqual(['Fixture Home 2G', 'Fixture Home 5G']); expect(saved.password).toBe('p'); expect(saved.url).toBe(cfg.url)
    expect(await r.registerCurrent()).toEqual({ registered: true, count: 2 }) // idempotent
    expect(await r.forget('Fixture Home 2G')).toEqual({ count: 1 }); expect(saved.homeSsids).toEqual(['Fixture Home 5G'])
    expect(await r.urlFor(saved)).toBe(cfg.homeUrl) // currently on the registered 5G network
    r.report({ transport: 'wifi', ssid: 'Fixture Home 2G' }); expect(await r.urlFor(saved)).toBe(cfg.url) // forgotten → external
})

test('direct-IP home URL: the wired probe validates TLS against the saved home certificate name and caches by it; endpointFor pins URL + servername from ONE decision, so a certificate-name or home-URL change saved mid-run never reaches a running operation; DNS configs carry no name', async () => {
    let now = 5_000_000; const probe = vi.fn(async () => true)
    const ipCfg = { url: 'https://203.0.113.10:64470/home/RisuAI/', homeUrl: 'https://192.0.2.5:15006/home/RisuAI/', homeSsids: ['Fixture Home 2G'], certHost: 'nas.example', homeCertHost: 'home.nas.example' }
    let current: any = ipCfg
    const r = createNasRoute({ secrets: { get: async () => current }, probe, now: () => now, detect: async () => ({ transport: 'ethernet', ssid: null }) })
    expect(await r.endpointFor()).toEqual({ url: ipCfg.homeUrl, servername: 'home.nas.example' })
    expect(probe).toHaveBeenCalledWith(ipCfg.homeUrl, { servername: 'home.nas.example' })
    await r.endpointFor(); expect(probe).toHaveBeenCalledTimes(1) // cached for the same url + name
    current = { ...ipCfg, homeCertHost: 'renamed.nas.example' }; expect(await r.endpointFor()).toEqual({ url: ipCfg.homeUrl, servername: 'renamed.nas.example' }); expect(probe).toHaveBeenCalledTimes(2) // a changed name is a different probe
    // Mid-run change: inside run() the first decision is pinned; the secrets then change name AND home URL; later endpointFor/urlFor calls keep the pinned pair.
    current = ipCfg
    await r.run(async () => {
        expect(await r.endpointFor()).toEqual({ url: ipCfg.homeUrl, servername: 'home.nas.example' })
        current = { ...ipCfg, homeUrl: 'https://192.0.2.99:15006/home/RisuAI/', homeCertHost: 'other.nas.example', certHost: 'other-ext.example' }
        expect(await r.endpointFor(current)).toEqual({ url: ipCfg.homeUrl, servername: 'home.nas.example' })
        expect(await r.urlFor(current)).toBe(ipCfg.homeUrl)
    })
    expect(await r.endpointFor()).toEqual({ url: 'https://192.0.2.99:15006/home/RisuAI/', servername: 'other.nas.example' }) // outside the run the new config applies
    const wifi = createNasRoute({ secrets: { get: async () => ipCfg }, probe: vi.fn(async () => false), now: () => now })
    wifi.report({ transport: 'wifi', ssid: 'Cafe' }); expect(await wifi.endpointFor()).toEqual({ url: ipCfg.url, servername: 'nas.example' })
    wifi.report({ transport: 'wifi', ssid: 'Fixture Home 2G' }); expect(await wifi.endpointFor()).toEqual({ url: ipCfg.homeUrl, servername: 'home.nas.example' })
    const single = createNasRoute({ secrets: { get: async () => ({ url: ipCfg.url, certHost: 'nas.example' }) }, probe: vi.fn(async () => true), now: () => now })
    expect(await single.endpointFor()).toEqual({ url: ipCfg.url, servername: 'nas.example' })
    const dns = createNasRoute({ secrets: { get: async () => cfg }, probe: vi.fn(async () => true), now: () => now, detect: async () => ({ transport: 'ethernet', ssid: null }) })
    expect(await dns.endpointFor()).toEqual({ url: cfg.homeUrl, servername: '' })
    const probed: any[] = []
    expect(await probeUrl(cfg.homeUrl, { fetch: async (_url: string, init: any) => { probed.push(init.servername); return { statusCode: 401, destroy: () => {} } }, servername: 'home.nas.example' })).toBe(true)
    expect(probed).toEqual(['home.nas.example'])
})
