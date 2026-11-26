import { writable } from 'svelte/store';
import { transferStatus } from './transferState';
type Bridge = { postMessage(message: string): void; addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void };
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; touch: () => void }>();
let attached: Bridge | undefined;
let windows = false;
export async function initializeNativeTransfers() {
  if (androidTransferAvailable()) {
    try { (await import('./androidNotification')).installAndroidNotifications(); } catch { /* notifications stay unavailable */ }
  }
  const { transferRequest } = await import('./playTransfer');
  windows = (await (await transferRequest('/native-capabilities')).json()).windows === true;
}
export function androidTransferAvailable(): boolean { return !!(globalThis as any).RisuPlay; }
// Android back key: installed when the app code loads (bootstrap imports this module), so it also answers on the account
// import screen and during start-up recovery. Browsers and the PC app: no bridge, nothing happens.
if (androidTransferAvailable()) void import('./androidBack').then(m => m.installAndroidBack()).catch(() => { /* the back key keeps leaving the app */ });
export function playSetAvailable(): boolean { return windows || androidTransferAvailable(); }
export const playNative = async <T>(op: string, args: Record<string, unknown> = {}): Promise<T> => {
  const bridge: Bridge = (globalThis as any).RisuPlay;
  if (!bridge && windows) {
    const { transferRequest } = await import('./playTransfer');
    return (await (await transferRequest('/native-rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, args }) })).json()).value;
  }
  if (!bridge) throw new Error('플레이 세트 기능을 지원하는 앱에서 열어 주세요.');
  if (attached !== bridge) {
    attached = bridge;
    bridge.addEventListener('message', event => {
      if (typeof event.data !== 'string') return;
      let reply: any; try { reply = JSON.parse(event.data); } catch { return; }
      const waiter = pending.get(reply.id); if (!waiter) return;
      if (reply.pending === true) { waiter.touch(); return; }
      clearTimeout(waiter.timer); pending.delete(reply.id);
      if (typeof reply.error === 'string') waiter.reject(new Error(reply.error)); else waiter.resolve(reply.value);
    });
  }
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    const expired = () => { pending.delete(id); reject(new Error('플레이 세트 저장소 응답을 기다리는 중 연결이 끊겼습니다.')); };
    const timer = setTimeout(expired, 120_000);
    const waiter = { resolve: resolve as (v: unknown) => void, reject, timer, touch: () => {
      clearTimeout(waiter.timer); waiter.timer = setTimeout(expired, 120_000);
    } };
    pending.set(id, waiter);
    try { const message = JSON.stringify({ id, op, args }); if (message.length > 12 * 1024 * 1024) throw new Error('플레이 세트 요청 크기가 너무 큽니다.'); bridge.postMessage(message); }
    catch (error) { pending.delete(id); clearTimeout(waiter.timer); reject(error); }
  });
};

export const nativeSend = writable<{ state: string; sent?: number; total?: number; error?: string } | null>(null);
/** 0.9.103-ver4 (Codex R2 #2): until when this device's own transferer may hold a local copy (`bard.export` writes a `.part` in the
 *  same folder as an arriving file). The arrival line stays hidden until then: while the copy runs and 3 s after it ends. */
export const nativeLocalCopyUntil = writable(0);
let localCopies = 0;
/** Overlapping hand-over copies (a background key reply and a panel send): the window ends 3 s after the LAST one (Codex R2b #2). */
export function beginLocalCopy() { localCopies++; nativeLocalCopyUntil.set(Number.POSITIVE_INFINITY); }
export function endLocalCopy() { localCopies = Math.max(0, localCopies - 1); if (!localCopies) nativeLocalCopyUntil.set(Date.now() + 3000); }
let sendGeneration = 0;
/** 0.9.103-ver4 (보낸 묶음 목록): where a package went, recorded on its send entry (display only, never fails the send). */
async function note(id: string, method: string, state: string, target?: string, transfer?: string) {
  try { await (await import('./playTransfer')).noteSent(id, { method, state, ...(target ? { target } : {}), ...(transfer ? { transfer } : {}) }); } catch { /* display only */ }
}
export async function sendNative(id: string, method: 'wifi' | 'usb' | 'share' | 'file', device?: string | Record<string, string>, name?: string, label?: string) {
  transferStatus.set('보낼 파일을 기기 전송기로 넘기는 중…'); // 0.9.103-ver4: the large copy below had no status
  beginLocalCopy();
  let handle: string;
  try { handle = await playNative<string>('bard.export', { id }); }
  finally { endLocalCopy(); }
  const target = label ?? (typeof device === 'string' ? device : device?.model ?? device?.serial);
  if (method === 'share' || method === 'file') {
    await playNative(method === 'share' ? 'file.share' : 'file.save', { handle, name });
    void note(id, method, 'requested');
    transferStatus.set(method === 'share' ? '시스템 공유창을 열었어요. 대상 기기를 선택하고 수신 여부를 확인해 주세요.' : '파일 저장창을 열었어요. 저장 위치를 선택해 주세요.');
    return;
  }
  const transfer = crypto.randomUUID(), prefix = method === 'wifi' ? 'network' : 'usb';
  await playNative(prefix + '.send', { handle, transfer, device });
  void note(id, method, 'sending', target, transfer);
  const generation = ++sendGeneration;
  nativeSend.set({ state: 'sending' });
  let delivered = false;
  const poll = async () => {
    if (generation !== sendGeneration) return;
    try {
      const progress = await playNative<{ state: string; sent?: number; total?: number; error?: string }>(prefix + '.progress', { transfer });
      if (generation !== sendGeneration) return;
      nativeSend.set(progress);
      if (progress.state === 'failed' || progress.state === 'cancelled') { transferStatus.set(progress.error || '전송이 취소됐어요.'); void note(id, method, 'failed', target, transfer); return; }
      if (progress.state === 'applied') { transferStatus.set('가져오기 완료'); void note(id, method, 'applied', target, transfer); return; }
      if (progress.state === 'delivered') {
        transferStatus.set('전달 완료 · 가져오기 대기');
        if (!delivered) { delivered = true; void note(id, method, 'delivered', target, transfer); }
        try {
          if (device && await playNative(prefix + '.status', { transfer, device }) === 'applied' && generation === sendGeneration) {
            nativeSend.set({ state: 'applied' }); transferStatus.set('가져오기 완료'); void note(id, method, 'applied', target, transfer); return;
          }
        } catch { if (generation === sendGeneration) transferStatus.set('전달 완료 · 받는 앱이 열리면 가져오기 상태를 다시 확인해요.'); }
      } else transferStatus.set(progress.state === 'ready' ? 'USB 전송 준비 완료 · PC 전송기에서 받아 주세요.' : '전송 중…');
      setTimeout(poll, 2000);
    } catch (error) {
      if (generation !== sendGeneration) return;
      nativeSend.set({ state: 'unknown', error: String(error) });
      transferStatus.set(`상대 기기 상태를 확인하지 못했어요. ${String(error)}`);
    }
  };
  void poll();
}
