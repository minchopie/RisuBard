'use strict';
/**
 * Home / external NAS route. One account, one vault, one sync namespace, reached through the internal HTTPS URL on the registered
 * home Wi-Fi networks (or on a PC whose *verified* wired adapter reaches the internal endpoint within a bounded probe) and through
 * the external URL anywhere else. An unknown or redacted SSID, an unknown transport, a stale client report or a failed adapter
 * detection all resolve to external — never "home" by default. The decision is taken once per run (a publish, a pull, a manual
 * upload) and carried in an async context, so concurrent runs are isolated and one run never mixes endpoints. Strict TLS
 * throughout: both URLs pass the same `folder()` validation and request helper. Nothing here logs an SSID, a URL or a credential.
 */
const { execFile } = require('node:child_process');
const { AsyncLocalStorage } = require('node:async_hooks');
const { folder, request, validateHomeSsids } = require('./transfer-remote.cjs');

const TRANSPORTS = new Set(['wifi', 'ethernet', 'cellular', 'none', 'unknown']);
const cleanSsid = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;

/** Pure decision. `probeOk`: outcome of probing the internal URL on a verified wired transport (true/false), else undefined. */
function decide(config, network, probeOk) {
    const url = config?.url || '', homeUrl = config?.homeUrl || '';
    if (!homeUrl) return { url, route: 'single', reason: 'single-url' };
    const transport = TRANSPORTS.has(network?.transport) ? network.transport : 'unknown';
    const ssid = cleanSsid(network?.ssid);
    if (transport === 'wifi') {
        if (ssid && (config.homeSsids ?? []).includes(ssid)) return { url: homeUrl, route: 'home', reason: 'home-ssid' };
        return { url, route: 'external', reason: ssid ? 'other-ssid' : 'unknown-ssid' };
    }
    if (transport === 'ethernet') return probeOk === true ? { url: homeUrl, route: 'home', reason: 'probe-ok' } : { url, route: 'external', reason: probeOk === false ? 'probe-failed' : 'probe-pending' };
    return { url, route: 'external', reason: transport === 'unknown' ? 'unknown-transport' : 'no-lan' };
}
const needsProbe = (config, network) => !!config?.homeUrl && network?.transport === 'ethernet';

/** `netsh wlan show interfaces`: the SSID line of a connected adapter (BSSID lines never match), any locale; null when absent/redacted. */
function parseNetsh(text) { const m = String(text ?? '').match(/^[ \t]*SSID[ \t]*:[ \t]*(.+?)[ \t]*$/m); return m ? cleanSsid(m[1]) : null; }
/** `Get-NetAdapter -Physical` media types of adapters that are Up: "Native 802.11" = Wi-Fi, "802.3" = wired. Anything else is not a verified transport. */
function classifyAdapters(mediaTypes, netshText) {
    const types = (Array.isArray(mediaTypes) ? mediaTypes : String(mediaTypes ?? '').split(/\r?\n/)).map(t => String(t).trim()).filter(Boolean);
    if (types.some(t => /802\.11/i.test(t))) return { transport: 'wifi', ssid: parseNetsh(netshText) };
    if (types.some(t => /^802\.3$/i.test(t))) return { transport: 'ethernet', ssid: null };
    return { transport: 'unknown', ssid: null };
}
const exec = (file, args) => new Promise(resolve => execFile(file, args, { timeout: 5000, windowsHide: true }, (error, stdout) => resolve(error ? null : String(stdout))));
async function detectWindows() {
    const media = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | ForEach-Object { $_.PhysicalMediaType }"]);
    if (media === null) return { transport: 'unknown', ssid: null }; // detection failed: not a verified wired transport
    const classified = classifyAdapters(media, null);
    return classified.transport === 'wifi' ? { transport: 'wifi', ssid: parseNetsh(await exec('netsh', ['wlan', 'show', 'interfaces'])) } : classified;
}
/** Bounded reachability probe of the internal endpoint: any HTTP answer (401 included) over a valid certificate counts. */
async function probeUrl(url, { fetch = request, timeoutMs = 4000, servername = '' } = {}) {
    let timer;
    const attempt = fetch(folder(url), { method: 'PROPFIND', headers: { Depth: '0', 'Content-Length': '0' }, servername });
    attempt.then(response => response?.destroy?.(), () => {}); // a late answer after the timeout is dropped, never left open
    try {
        await Promise.race([attempt, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('probe timeout')), timeoutMs); })]);
        return true;
    } catch { return false; } finally { clearTimeout(timer); }
}

function createNasRoute({ secrets, probe = probeUrl, detect = null, now = Date.now, reportTtlMs = 120_000, probeTtlMs = 60_000, detectTtlMs = 20_000 }) {
    const context = new AsyncLocalStorage();
    let reported = null, detected = null, probeCache = null;
    /** The client's live view (Android native bridge), refreshed every sync cycle; older than the TTL it is not trusted. */
    function report(input) {
        reported = { transport: TRANSPORTS.has(input?.transport) ? input.transport : 'unknown', ssid: cleanSsid(input?.ssid), at: now() };
        return reported;
    }
    async function network() {
        if (reported && now() - reported.at <= reportTtlMs) return reported;
        if (reported) return { transport: 'unknown', ssid: null, at: now() }; // a stale client report: unknown, never wired, never home
        if (detect) {
            if (detected && now() - detected.at <= detectTtlMs) return detected;
            try { detected = { ...await detect(), at: now() }; return detected; } catch { /* fall through */ }
        }
        return { transport: 'unknown', ssid: null, at: now() };
    }
    async function resolve(config = null) {
        config ??= await secrets.get('nas');
        const net = await network();
        let ok;
        if (needsProbe(config, net)) {
            const servername = config.homeCertHost || ''; // the internal URL may be a literal IP: the probe validates TLS against the saved certificate name
            if (probeCache && probeCache.url === config.homeUrl && probeCache.servername === servername && now() - probeCache.at <= probeTtlMs) ok = probeCache.ok;
            else { ok = await probe(config.homeUrl, { servername }); probeCache = { url: config.homeUrl, servername, ok, at: now() }; }
        }
        const decision = decide(config, net, ok);
        // The TLS server name is part of the decision, taken from the SAME config as the URL: a run pins both together, so a
        // certificate-name or home-URL change saved mid-operation never pairs a pinned URL with another side's name.
        return { ...decision, servername: (decision.route === 'home' ? config.homeCertHost : config.certHost) || '', network: { transport: net.transport, ssidKnown: !!net.ssid } };
    }
    /** URL for the next request: this run's decision when inside `run`, else a fresh one. Credentials never change with the route. */
    async function urlFor(config) { return folder((context.getStore()?.decision ?? await resolve(config)).url); }
    /** URL plus the TLS server name of the same pinned decision ('' when the URL's host is the certificate name itself). */
    async function endpointFor(config) { const d = context.getStore()?.decision ?? await resolve(config); return { url: folder(d.url), servername: d.servername || '' }; }
    /** One decision for a whole operation, carried in the async context: concurrent runs are isolated, nested runs share the outer one. */
    async function run(fn) {
        const outer = context.getStore();
        if (outer) return fn();
        const decision = await resolve();
        return context.run({ decision }, fn);
    }
    async function status() { const d = context.getStore()?.decision ?? await resolve(); return { route: d.route, reason: d.reason, pinned: !!context.getStore(), network: d.network }; }
    /** Register the current Wi-Fi as home: only a known SSID on Wi-Fi (the client reports the underlying Wi-Fi under a VPN). */
    async function registerCurrent() {
        const net = await network();
        if (net.transport !== 'wifi' || !net.ssid) throw Object.assign(new Error('지금 연결된 Wi-Fi 이름을 알 수 없어요. Wi-Fi에 연결하고 위치 권한을 허용한 뒤 다시 시도해 주세요.'), { status: 409 });
        const saved = await secrets.get('nas');
        const homeSsids = validateHomeSsids([...(saved.homeSsids ?? []).filter(s => s !== net.ssid), net.ssid]);
        await secrets.set('nas', { ...saved, homeSsids }); probeCache = null;
        return { registered: true, count: homeSsids.length };
    }
    async function forget(ssid) {
        const saved = await secrets.get('nas'), homeSsids = (saved.homeSsids ?? []).filter(s => s !== ssid);
        await secrets.set('nas', { ...saved, homeSsids });
        return { count: homeSsids.length };
    }
    return { decide, report, network, resolve, urlFor, endpointFor, run, status, registerCurrent, forget, invalidate: () => { probeCache = null; detected = null; } };
}
module.exports = { createNasRoute, decide, parseNetsh, classifyAdapters, probeUrl, detectWindows };
