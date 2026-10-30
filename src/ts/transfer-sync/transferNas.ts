export interface NasConfig { url: string; username: string; hasPassword: boolean; homeUrl?: string; homeSsids?: string[]; certHost?: string; homeCertHost?: string }
export interface NasFile { name: string; bytes: number; modified: string; etag: string }
// Remote hrefs are data, never request targets. Native code rebuilds requests from
// a validated basename under the configured collection.
export function parseNasListing(xml: string, folder: string): NasFile[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('NAS 목록에 허용되지 않은 XML 선언이 있습니다.');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('NAS 목록 형식이 올바르지 않습니다.');
  if (doc.documentElement?.namespaceURI !== 'DAV:' || doc.documentElement.localName !== 'multistatus') throw new Error('NAS 목록 응답 형식이 올바르지 않습니다.');
  const base = new URL(folder);
  let directory: string;
  try { directory = decodeURIComponent(base.pathname); } catch { throw new Error('NAS 폴더 주소의 문자 인코딩을 확인해 주세요. % 문자는 %25로 입력해 주세요.'); }
  if (!directory.endsWith('/')) directory += '/';
  let foreignOrigin = false;
  const files = new Map<string, NasFile>();
  const dav = (node: Document | Element, name: string) => Array.from(node.getElementsByTagName('*')).filter(e => e.namespaceURI === 'DAV:' && e.localName === name);
  const text = (node: Element, name: string) => (dav(node, name)[0]?.textContent ?? '').trim();
  for (const response of dav(doc, 'response')) {
    const href = text(response, 'href');
    let target: URL; try { target = new URL(href, base); } catch { continue; }
    if (target.origin !== base.origin) { foreignOrigin = true; continue; }
    if (target.search || target.hash || target.username || target.password) continue;
    let path: string;
    try { path = decodeURIComponent(target.pathname); } catch { continue; }
    if (!path.startsWith(directory)) continue;
    const name = path.slice(directory.length);
    if (!validNasName(name)) continue;
    const prop = dav(response, 'propstat').find(p => /^HTTP\/\S+ 200(?:\s|$)/.test(text(p, 'status')));
    if (!prop || dav(prop, 'collection').length) continue;
    const bytes = Number(text(prop, 'getcontentlength'));
    if (!Number.isSafeInteger(bytes) || bytes < 0) continue;
    files.set(name, { name, bytes, modified: text(prop, 'getlastmodified'), etag: text(prop, 'getetag') });
  }
  if (!files.size && foreignOrigin) throw new Error('NAS가 설정과 다른 주소의 파일 목록을 반환했습니다. WebDAV 주소와 프록시 설정을 확인해 주세요.');
  return [...files.values()].sort((a,b) => a.name < b.name ? 1 : a.name > b.name ? -1 : 0);
}
export function validNasName(name: string): boolean {
  return name.length <= 200 && name.endsWith('.risuplay') && !/[\/\\\x00-\x1f\x7f-\x9f]/.test(name) && name !== '.risuplay';
}
export function nasFilename(label: string): string {
  let safe = ''; let bytes = 0;
  const encoder = new TextEncoder();
  for (const point of Array.from(label.replace(/[\/\\\x00-\x1f\x7f-\x9f]/g, '_')).slice(0, 60)) {
    const size = encoder.encode(point).length;
    if (bytes + size > 180) break;
    safe += point; bytes += size;
  }
  safe = safe.trim() || 'chat';
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${safe}-${crypto.randomUUID()}.risuplay`;
}
