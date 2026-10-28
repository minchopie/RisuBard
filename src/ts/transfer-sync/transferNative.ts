import { writable } from 'svelte/store';
import { transferStatus } from './transferState';
type Bridge = { postMessage(message: string): void; addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void };
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; touch: () => void }>();
let attached: Bridge | undefined;
let windows = false;
export async function initializeNativeTransfers() {
  const { transferRequest } = await import('./playTransfer');
  windows = (await (await transferRequest('/native-capabilities')).json()).windows === true;
}
export function androidTransferAvailable(): boolean { return !!(globalThis as any).RisuPlay; }
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
let sendGeneration = 0;
export async function sendNative(id: string, method: 'wifi' | 'usb' | 'share' | 'file', device?: string | Record<string, string>, name?: string) {
  const handle = await playNative<string>('bard.export', { id });
  if (method === 'share' || method === 'file') {
    await playNative(method === 'share' ? 'file.share' : 'file.save', { handle, name });
    transferStatus.set(method === 'share' ? '시스템 공유창을 열었어요. 대상 기기를 선택하고 수신 여부를 확인해 주세요.' : '파일 저장창을 열었어요. 저장 위치를 선택해 주세요.');
    return;
  }
  const transfer = crypto.randomUUID(), prefix = method === 'wifi' ? 'network' : 'usb';
  await playNative(prefix + '.send', { handle, transfer, device });
  const generation = ++sendGeneration;
  nativeSend.set({ state: 'sending' });
  const poll = async () => {
    if (generation !== sendGeneration) return;
    try {
      const progress = await playNative<{ state: string; sent?: number; total?: number; error?: string }>(prefix + '.progress', { transfer });
      if (generation !== sendGeneration) return;
      nativeSend.set(progress);
      if (progress.state === 'failed' || progress.state === 'cancelled') { transferStatus.set(progress.error || '전송이 취소됐어요.'); return; }
      if (progress.state === 'applied') { transferStatus.set('가져오기 완료'); return; }
      if (progress.state === 'delivered') {
        transferStatus.set('전달 완료 · 가져오기 대기');
        try {
          if (device && await playNative(prefix + '.status', { transfer, device }) === 'applied' && generation === sendGeneration) {
            nativeSend.set({ state: 'applied' }); transferStatus.set('가져오기 완료'); return;
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
