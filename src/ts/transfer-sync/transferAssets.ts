import { getDatabase, getCurrentCharacter } from '../storage/database.svelte';
import { getFileSrc } from '../globalApi.svelte';

/** Resolve only rendered media references. Never rewrite saved prose, Lua, or JavaScript strings. */
export function transferMediaScope(character?: ReturnType<typeof getCurrentCharacter>): Record<string, any> | undefined {
  if (!character && Array.isArray(getDatabase()?.characters)) character = getCurrentCharacter();
  const chat = character?.chats?.[character.chatPage];
  return (chat as any)?.risuTransferMedia ?? (chat as any)?.risuPlayContext ?? (character as any)?.risuTransferMedia ?? (character as any)?.risuPlayDefaults;
}

export async function resolvePlaySetHtml(html: string, scope = transferMediaScope()): Promise<string> {
  if (getDatabase().hideAllImages) return html;
  const aliases = scope ? { ...scope.assets, ...scope.resolvedAssets } as Record<string, string> : undefined;
  if (!aliases || !Object.keys(aliases).some(path => html.includes(path))) return html;
  const template = document.createElement('template'); template.innerHTML = html;
  const urls = new Map<string, string>();
  const url = async (path: string) => { if (!urls.has(path)) urls.set(path, await getFileSrc(aliases[path])); return urls.get(path)!; };
  const css = async (value: string): Promise<string> => {
    const matches = [...value.matchAll(/url\(\s*(["']?)(assets\/[^\s"'()]+)\1\s*\)/g)];
    for (const match of matches) if (Object.hasOwn(aliases, match[2])) { const mapped = await url(match[2]); value = value.replace(match[0], () => 'url(' + JSON.stringify(mapped) + ')'); }
    // Only quoted image candidates in image-set(), not content: strings or script text.
    const tokens = /\/\*[\s\S]*?\*\/|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|([-\w]+)\s*\(|([(),])/g;
    const functions: string[] = []; let candidate = false, cursor = 0, result = '';
    for (const token of value.matchAll(tokens)) {
      if (token[1]) {
        const path = token[1].slice(1, -1);
        if (candidate && /^(?:-webkit-)?image-set$/i.test(functions.at(-1) ?? '') && Object.hasOwn(aliases, path)) {
          result += value.slice(cursor, token.index) + JSON.stringify(await url(path)); cursor = token.index! + token[0].length;
        }
        candidate = false;
      } else if (token[2]) { functions.push(token[2]); candidate = true; }
      else if (token[3] === '(') { functions.push(''); candidate = true; }
      else if (token[3] === ')') { functions.pop(); candidate = false; }
      else if (token[3] === ',') candidate = true;
    }
    return result + value.slice(cursor);
  };
  const srcset = async (value: string): Promise<string> => {
    // URL tokens end at ASCII whitespace; commas inside data URLs stay inside the URL.
    let cursor = 0, written = 0, result = '';
    while (cursor < value.length) {
      while (cursor < value.length && /[\t\n\f\r ,]/.test(value[cursor])) cursor++;
      const start = cursor;
      while (cursor < value.length && !/[\t\n\f\r ]/.test(value[cursor])) cursor++;
      const token = value.slice(start, cursor), path = token.replace(/,+$/, '');
      if (Object.hasOwn(aliases, path)) { result += value.slice(written, start) + await url(path); written = start + path.length; }
      if (token.endsWith(',')) continue;
      let nesting = 0;
      while (cursor < value.length) {
        const char = value[cursor++];
        if (char === '(') nesting++; else if (char === ')') nesting--; else if (char === ',' && nesting === 0) break;
      }
    }
    return result + value.slice(written);
  };
  for (const element of template.content.querySelectorAll('*')) {
    for (const name of ['src', 'poster', 'href', 'xlink:href', 'background']) {
      const value = element.getAttribute(name); if (value && Object.hasOwn(aliases, value)) element.setAttribute(name, await url(value));
    }
    const candidates = element.getAttribute('srcset'); if (candidates) element.setAttribute('srcset', await srcset(candidates));
    const style = element.getAttribute('style'); if (style) element.setAttribute('style', await css(style));
    if (element.tagName.toLowerCase() === 'style') element.textContent = (await css(element.textContent ?? '')).replace(/<\/(?=style)/gi, '<\\/');
  }
  return template.innerHTML;
}
