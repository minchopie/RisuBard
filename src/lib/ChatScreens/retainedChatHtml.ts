interface ChatHtmlUpdate {
    content: Promise<string>
    format: (html: string) => string
    onRender: () => void
    onError?: () => void
    pendingHtml?: string
}

// Compare parser output with the previous parser output, not the live DOM:
// asset loading and inlay resolution deliberately modify that DOM themselves.
function patchChildren(live: Element, previous: Node, next: Node) {
    const oldChildren = Array.from(previous.childNodes)
    const liveChildren = Array.from(live.childNodes)
    const nextChildren = Array.from(next.childNodes)

    if (oldChildren.length !== liveChildren.length) {
        // A custom renderer changed the structure. Rebuild this changed subtree
        // instead of applying a positional patch to unrelated nodes.
        live.replaceChildren(...nextChildren.map(child => child.cloneNode(true)))
        return
    }

    let oldEnd = oldChildren.length
    let nextEnd = nextChildren.length
    if (oldEnd !== nextEnd) {
        // Keep equal trailing blocks aligned when body paragraphs grow or shrink.
        while (oldEnd > 0 && nextEnd > 0 && oldChildren[oldEnd - 1].isEqualNode(nextChildren[nextEnd - 1])) {
            oldEnd--
            nextEnd--
        }
    }
    const tail = liveChildren[oldEnd] ?? null
    for (let index = 0; index < Math.max(oldEnd, nextEnd); index++) {
        const oldChild = index < oldEnd ? oldChildren[index] : undefined
        const nextChild = index < nextEnd ? nextChildren[index] : undefined
        const liveChild = liveChildren[index]
        if (!nextChild) {
            live.removeChild(liveChild)
        } else if (!oldChild) {
            live.insertBefore(nextChild.cloneNode(true), tail)
        } else if (!oldChild.isEqualNode(nextChild)) {
            patchNode(liveChild, oldChild, nextChild)
        }
    }
}

function patchNode(live: Node, previous: Node, next: Node) {
    if (previous.nodeType !== next.nodeType || previous.nodeName !== next.nodeName
        || live.nodeType !== next.nodeType || live.nodeName !== next.nodeName) {
        live.parentNode!.replaceChild(next.cloneNode(true), live)
        return
    }

    if (next instanceof Element && previous instanceof Element && live instanceof Element) {
        // A different media source/inlay is a different resource, even if its tag matches.
        if (['src', 'data-inlay-id', 'data-inlay-type'].some(name =>
            previous.getAttribute(name) !== next.getAttribute(name))) {
            live.replaceWith(next.cloneNode(true))
            return
        }
        for (const attribute of Array.from(previous.attributes)) {
            if (!next.hasAttribute(attribute.name)) live.removeAttribute(attribute.name)
        }
        for (const attribute of Array.from(next.attributes)) {
            if (previous.getAttribute(attribute.name) !== attribute.value) {
                live.setAttribute(attribute.name, attribute.value)
            }
        }
        patchChildren(live, previous, next)
    } else if (live.nodeValue !== next.nodeValue) {
        live.nodeValue = next.nodeValue
    }
}

// Comparison copies are parsed with the same rules as a <div>, but in a document
// without a browsing context: a detached <div> of the live document would load
// media, and Firefox plays its <audio autoplay> copies forever since they are
// never removed from a document.
let parserDocument: Document | null = null
function createParserElement() {
    parserDocument ??= document.implementation.createHTMLDocument('')
    return parserDocument.createElement('div')
}

/** Svelte action for already-sanitized chat HTML. Keeps the last committed DOM while parsing. */
export function retainedChatHtml(node: HTMLElement, initial: ChatHtmlUpdate) {
    let previous: Node = createParserElement()
    let revision = 0

    function commit(html: string) {
        const next = createParserElement()
        next.innerHTML = html
        patchChildren(node, previous, next)
        previous = next
    }

    function update(options: ChatHtmlUpdate) {
        const request = ++revision
        if (options.pendingHtml) commit(options.format(options.pendingHtml))
        void options.content.then(html => {
            if (request !== revision) return
            commit(options.format(html))
            options.onRender()
        }).catch(error => {
            if (request === revision) {
                options.onError?.()
                console.error('Failed to render chat HTML', error)
            }
        })
    }

    update(initial)
    return {
        update,
        destroy() { revision += 1 },
    }
}
