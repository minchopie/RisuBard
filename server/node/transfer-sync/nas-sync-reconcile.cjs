'use strict';
const { hashJson } = require('./nas-sync-core.cjs');

// Selection and its legacy mirrors describe this device, not edits to the shared persona library.
const PERSONA_MIRRORS = ['selectedPersona', 'personaPrompt', 'username', 'userIcon', 'userNote'];
const own = (o, k) => Object.hasOwn(o, k);
const equal = (a, b) => hashJson(a ?? null) === hashJson(b ?? null);
function personaContent(content) {
    const out = { ...content };
    for (const key of PERSONA_MIRRORS) delete out[key];
    if (Array.isArray(out.personas)) out.personas = [...out.personas].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return out;
}
function personaWireContent(content) {
    const out = personaContent(content), p = out.personas?.[0];
    // Older clients require these keys; their deterministic mirror is not this device's live selection.
    return { ...out, selectedPersona: 0, username: p?.name ?? '', userIcon: p?.icon ?? '', personaPrompt: p?.personaPrompt ?? '', userNote: p?.note ?? '' };
}
function personaSelection(db, personas) {
    const selected = db.personas?.[db.selectedPersona ?? 0];
    let index = personas.findIndex(p => p.id === selected?.id);
    if (index < 0) index = 0;
    const p = personas[index];
    return p ? { selectedPersona: index, username: p.name ?? '', userIcon: p.icon ?? '', personaPrompt: p.personaPrompt ?? '', userNote: p.note ?? '' } : {};
}
function personaMirrorsMatch(db) {
    const p = db.personas?.[db.selectedPersona ?? 0];
    if (!p) return true;
    return Object.entries({ username: p.name ?? '', userIcon: p.icon ?? '', personaPrompt: p.personaPrompt ?? '', userNote: p.note ?? '' })
        .every(([k, value]) => !own(db, k) || equal(db[k], value));
}
function personaMirrorIssue(db) {
    if (personaMirrorsMatch(db)) return null;
    const p = db.personas?.[db.selectedPersona ?? 0];
    return { name: p?.name || '현재 페르소나', reason: 'local-persona-edit' };
}
/** A unique latest common base; ambiguous ancestry and unknown genesis never authorize deletions. */
function commonBase(graph, heads) {
    const ancestors = heads.map(head => {
        const seen = new Set(), stack = [...head.parents];
        while (stack.length) { const id = stack.pop(); if (seen.has(id)) continue; seen.add(id); stack.push(...(graph.get(id)?.parents ?? [])); }
        return seen;
    });
    const common = [...ancestors[0]].filter(id => ancestors.every(a => a.has(id)));
    const parents = new Set(common.flatMap(id => graph.get(id)?.parents ?? []));
    const latest = common.filter(id => !parents.has(id));
    return latest.length === 1 ? graph.get(latest[0]) : latest.length ? undefined : null;
}
/** Three-way fields, including absence. No winner is inferred from clocks or device priority. */
function mergeFields(values, base, allowUnknown = false, preferred) {
    const result = {};
    for (const key of new Set([...Object.keys(base ?? {}), ...values.flatMap(Object.keys)])) {
        const variants = [];
        for (const value of values) {
            const entry = { exists: own(value, key), value: value[key] };
            if (!variants.some(v => v.exists === entry.exists && equal(v.value, entry.value))) variants.push(entry);
        }
        let chosen;
        if (variants.length === 1) chosen = variants[0];
        else if (base) {
            const edits = variants.filter(v => v.exists !== own(base, key) || !equal(v.value, base[key]));
            if (edits.length !== 1) { if (!preferred) return null; chosen = { exists: own(preferred, key), value: preferred[key] }; }
            else chosen = edits[0];
        } else if (allowUnknown) {
            const present = variants.filter(v => v.exists);
            if (present.length !== 1) { if (!preferred) return null; chosen = { exists: own(preferred, key), value: preferred[key] }; }
            else chosen = present[0];
        } else return null;
        if (chosen.exists) Object.defineProperty(result, key, { value: chosen.value, enumerable: true, configurable: true });
    }
    return result;
}
function mergePersonaHeads(graph, heads, preferredId, references) {
    if (!heads.length || heads.some(h => h.tombstone || !Array.isArray(h.content?.personas))) return null;
    // Secret references need their own field-level ownership; retain the explicit conflict instead of guessing.
    if (heads.some(h => h.content.$syncSecrets || Object.keys(h.dependencies).some(k => k.startsWith('envelope:')))) return null;
    const baseRev = commonBase(graph, heads);
    if (baseRev === undefined) return null;
    const base = baseRev && !baseRev.tombstone ? personaContent(baseRev.content) : null;
    const contents = heads.map(h => personaContent(h.content));
    const records = list => {
        const out = {};
        for (const p of list) { if (!p || typeof p.id !== 'string' || !p.id || own(out, p.id)) return null; Object.defineProperty(out, p.id, { value: p, enumerable: true }); }
        return out;
    };
    const lists = contents.map(c => records(c.personas));
    const prior = base ? records(base.personas ?? []) : null;
    if (lists.some(x => !x) || (base && !prior)) return null;
    const preferredIndex = heads.findIndex(h => h.id === preferredId);
    const merged = mergeFields(lists, prior, !base, lists[preferredIndex]);
    if (!merged) return null;
    const rest = c => Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'personas'));
    const fields = mergeFields(contents.map(rest), base ? rest(base) : null, !base, preferredIndex >= 0 ? rest(contents[preferredIndex]) : undefined);
    if (!fields) return null;
    const content = personaWireContent({ ...fields, personas: Object.values(merged) }), dependencies = {};
    const all = heads.flatMap(h => Object.entries(h.dependencies));
    if (all.length || references) {
        if (!references || all.some(([k]) => !['asset:', 'inlay:', 'inlay-metadata:'].some(p => k.startsWith(p)))) return null;
        const refs = references(content, 'settings');
        const needed = [...[...refs.assets].map(k => 'asset:' + k), ...[...refs.inlays].flatMap(k => ['inlay:' + k, 'inlay-metadata:' + k])];
        for (const key of needed) {
            const hashes = new Set(all.filter(([k]) => k === key).map(([, h]) => h));
            if (hashes.size !== 1) return null;
            dependencies[key] = [...hashes][0];
        }
    }
    return { content, dependencies };
}
module.exports = { PERSONA_MIRRORS, personaContent, personaWireContent, personaSelection, personaMirrorsMatch, personaMirrorIssue, commonBase, mergeFields, mergePersonaHeads };
