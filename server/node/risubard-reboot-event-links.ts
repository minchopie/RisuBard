import { normalizeWikiLinkKey } from '../../src/ts/risubard/wikiLink'

interface EventLinkDocument {
    id: string
    title: string
    aliases?: readonly string[]
}

/** Repair only a known synthetic batch name, never split arbitrary titles. */
export function repairRebootEventLinks(
    content: string,
    syntheticTitle: string,
    events: readonly EventLinkDocument[],
    documents: readonly EventLinkDocument[],
): string {
    if (events.length < 2 || new Set(events.map((event) => event.id)).size !== events.length) {
        return content
    }
    const owners = (title: string) => new Set(documents.filter((document) =>
        [document.title, ...(document.aliases ?? [])].some((name) =>
            normalizeWikiLinkKey(name) === normalizeWikiLinkKey(title)
        )
    ).map((document) => document.id))
    if (owners(syntheticTitle).size > 0 || events.some((event) => {
        const matches = owners(event.title)
        return matches.size !== 1 || !matches.has(event.id)
            || /[\[\]|\r\n]/u.test(event.title) || event.title.length > 160
    })) return content

    return content.replaceAll(
        `[[${syntheticTitle}]]`,
        events.map((event) => `[[${event.title}]]`).join(', '),
    )
}
