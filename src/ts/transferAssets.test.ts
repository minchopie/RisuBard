import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ useDefaults: false, hideAllImages: false }));
vi.mock('./storage/database.svelte', () => ({ getDatabase: () => ({ characters: [], hideAllImages: state.hideAllImages }), getCurrentChat: () => state.useDefaults ? {} : ({ risuPlayContext: { assets: { 'assets/old.png': 'assets/received.png' } } }), getCurrentCharacter: () => ({ risuPlayDefaults: { assets: { 'assets/old.png': 'assets/received.png' } } }) }));
vi.mock('./globalApi.svelte', () => ({ getFileSrc: async (path: string) => 'https://local.invalid/' + path }));
import { resolvePlaySetHtml } from './transferAssets';
it('renders inline media and CSS aliases without changing literal text or saved source', async () => {
  const source = '<p>assets/old.png</p><img src="assets/old.png"><span style="background:url(assets/old.png)">text</span><style>.x{background:url(\'assets/old.png\')}</style>';
  const result = await resolvePlaySetHtml(source);
  expect(result).toContain('<p>assets/old.png</p>'); expect(result).toContain('src="https://local.invalid/assets/received.png"');
  expect(result).toContain('https://local.invalid/assets/received.png'); expect(source).not.toContain('received');
  expect(await resolvePlaySetHtml('<p>unchanged</p>')).toBe('<p>unchanged</p>');
});
it('new chats on a received character keep the character media fallback', async () => {
  state.useDefaults = true;
  try { expect(await resolvePlaySetHtml('<img src="assets/old.png">')).toContain('src="https://local.invalid/assets/received.png"'); }
  finally { state.useDefaults = false; }
});

it('round10: srcset and image-set resolve media while data URLs and CSS literal text stay intact', async () => {
  const source = `<picture><source srcset="data:image/svg+xml,assets/old.png 1x, assets/old.png 2x"><img srcset="assets/old.png 100w, assets/old.png 200w"></picture><style>.x{background:image-set("assets/old.png" 1x, url('assets/old.png') 2x);content:"assets/old.png"}</style><table background="assets/old.png"></table>`;
  const result = await resolvePlaySetHtml(source);
  const doc = document.createElement('template'); doc.innerHTML = result;
  expect(doc.content.querySelector('source')!.getAttribute('srcset')).toBe('data:image/svg+xml,assets/old.png 1x, https://local.invalid/assets/received.png 2x');
  expect(doc.content.querySelector('img')!.getAttribute('srcset')).toBe('https://local.invalid/assets/received.png 100w, https://local.invalid/assets/received.png 200w');
  expect(doc.content.querySelector('style')!.textContent).toContain('image-set("https://local.invalid/assets/received.png" 1x');
  expect(doc.content.querySelector('style')!.textContent).toContain('content:"assets/old.png"');
  expect(doc.content.querySelector('table')!.getAttribute('background')).toBe('https://local.invalid/assets/received.png');
});

it('round11: hidden-image mode does not resolve srcset, poster, CSS or background assets', async () => {
  state.hideAllImages = true;
  const source = '<img src="/none.webp" srcset="assets/old.png 2x"><video poster="assets/old.png"></video><table background="assets/old.png"></table><style>.x{background:image-set("assets/old.png" 1x)}</style>';
  try { expect(await resolvePlaySetHtml(source)).toBe(source); } finally { state.hideAllImages = false; }
});
