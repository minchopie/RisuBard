import { describe, expect, test } from 'vitest'
import { retainedChatHtml } from './retainedChatHtml'

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const render = (html: string) => ({ content: Promise.resolve(html), format: (value: string) => value, onRender: () => {} })

describe('retainedChatHtml', () => {
    test('keeps comparison copies out of the live document and patches in place', async () => {
        const node = document.createElement('span')
        const audio = '<audio autoplay loop><source src="a.mp3"></audio>'
        const action = retainedChatHtml(node, render(audio))
        await flush()
        const live = node.querySelector('audio')
        action.update(render(audio + '<p>x</p>'))
        await flush()

        expect(node.querySelectorAll('audio')).toHaveLength(1)
        expect(node.querySelector('audio')).toBe(live)
        expect(live!.ownerDocument).toBe(document)
        expect(node.querySelector('p')?.textContent).toBe('x')
    })

    test.each([
        ['inserts', '<p>Alpha</p>', '<p>Alpha</p><p>New</p>'],
        ['deletes', '<p>Alpha</p><p>Old</p>', '<p>Alpha</p>'],
        ['inserts after a repeated tag', '<p>Tail</p>', '<p>Tail</p><p>New</p>'],
    ])('%s paragraphs and keeps equal following nodes', async (_label, before, after) => {
        const node = document.createElement('span')
        const suffix = '<p>Tail</p><details><summary>Panel</summary><img src="same.png"></details><audio src="same.mp3"></audio>'
        const action = retainedChatHtml(node, render(before + suffix))
        await flush()
        const tail = node.querySelector('details')!.previousElementSibling
        const details = node.querySelector('details')!
        const audio = node.querySelector('audio')
        action.update(render(after + suffix))
        await flush()

        expect(details.previousElementSibling).toBe(tail)
        expect(node.querySelector('details')).toBe(details)
        expect(node.querySelector('audio')).toBe(audio)
        const fresh = document.createElement('span')
        retainedChatHtml(fresh, render(after + suffix))
        await flush()
        expect(node.isEqualNode(fresh)).toBe(true)
    })

    test.each([false, true])('preserves the first open details when an identical one is added (changed prefix: %s)', async changed => {
        const node = document.createElement('span')
        const details = '<details><summary>Panel</summary></details>'
        const prefix = '<p>First</p>'
        const action = retainedChatHtml(node, render(prefix + details + '<aside>End</aside>'))
        await flush()
        const open = node.querySelector('details')!
        open.open = true
        action.update(render((changed ? '<p>Changed</p>' : prefix) + details + details + '<aside>End</aside>'))
        await flush()
        const result = node.querySelectorAll('details')
        expect(result).toHaveLength(2)
        expect(result[0]).toBe(open)
        expect(result[0].open).toBe(true)
        expect(result[1].open).toBe(false)
    })

    test('preserves live media resolution in the retained suffix and replaces a changed source', async () => {
        const node = document.createElement('span')
        const suffix = '<img src="asset.png">'
        const action = retainedChatHtml(node, render('<p>Start</p>' + suffix))
        await flush()
        const img = node.querySelector('img')!
        img.setAttribute('src', '/resolved/asset.png')
        action.update(render('<p>Start</p><p>New</p>' + suffix))
        await flush()
        expect(node.querySelector('img')).toBe(img)
        expect(img.getAttribute('src')).toBe('/resolved/asset.png')

        action.update(render('<p>Start</p><p>New</p><img src="changed.png">'))
        await flush()
        expect(node.querySelector('img')).not.toBe(img)
        expect(node.querySelector('img')!.getAttribute('src')).toBe('changed.png')
    })

    test('rebuilds when a renderer changes the number of live children', async () => {
        const node = document.createElement('span')
        const action = retainedChatHtml(node, render('<p>Before</p><aside>Tail</aside>'))
        await flush()
        const oldTail = node.querySelector('aside')
        node.prepend(document.createElement('p'))
        const html = '<p>Before</p><p>New</p><aside>Tail</aside>'
        action.update(render(html))
        await flush()
        const fresh = document.createElement('span')
        retainedChatHtml(fresh, render(html))
        await flush()
        expect(node.querySelector('aside')).not.toBe(oldTail)
        expect(node.isEqualNode(fresh)).toBe(true)
    })

    test('parses comparison HTML outside the live document', async () => {
        const parsed: Element[] = []
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!
        Object.defineProperty(Element.prototype, 'innerHTML', {
            ...descriptor,
            set(value: string) {
                descriptor.set!.call(this, value)
                parsed.push(this)
            },
        })
        try {
            retainedChatHtml(document.createElement('span'), render('<audio autoplay></audio>'))
            await flush()
        } finally {
            Object.defineProperty(Element.prototype, 'innerHTML', descriptor)
        }
        expect(parsed).toHaveLength(1)
        expect(parsed[0].ownerDocument).not.toBe(document)
        expect(parsed[0].querySelector('audio')).not.toBeNull()
    })

    test('keeps <div> parsing rules for stray table cells', async () => {
        const node = document.createElement('span')
        retainedChatHtml(node, render('<td>cell</td>'))
        await flush()
        expect(node.querySelector('td')).toBeNull()
        expect(node.textContent).toBe('cell')
    })
})
