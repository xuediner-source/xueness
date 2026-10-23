/** Bounded concurrent requests keep cancellation responsive during a durable run. */
import type { Readable } from 'node:stream';
import { isDict } from '@xueness/contracts';

interface InputPort {
  input: Readable;
  handle(line: Buffer): Promise<void>;
  error(id: unknown, code: number, message: string, data?: Record<string, unknown>): Promise<void>;
  shutdown(): Promise<unknown>;
  stopping(): boolean;
  closed?: AbortSignal;
}
const MAX_FRAME = 1024 * 1024;
function descriptor(line: Buffer): { id: unknown; barrier: boolean; control: boolean } {
  try {
    const p: unknown = JSON.parse(line.toString('utf8'));
    if (isDict(p)) {
      const method = typeof p.method === 'string' ? p.method : '', params = isDict(p.params) ? p.params : {};
      return { id: p.id ?? null, barrier: ['initialize', 'shutdown', 'exit'].includes(method),
        control: ['shutdown', 'exit', 'turn/cancel', 'command/query', 'connection/flow'].includes(method)
          || method === 'command/execute' && params.type === 'stop' || /\/(?:resync|unsubscribe)$/.test(method) };
    }
  } catch { /* The request decoder produces the parse error. */ }
  return { id: null, barrier: false, control: false };
}
export function serveAppServerInput(port: InputPort): Promise<number> {
  return new Promise((resolve, reject) => {
    let parts: Buffer[] = [], size = 0, oversized = false, chain = Promise.resolve(), ended = false, finishing = false;
    let ordinary = 0, controls = 0;
    const pending = new Set<Promise<void>>(), ids = new Set<unknown>();
    const fail = (error: unknown) => { port.input.pause(); reject(error); };
    const finish = (): void => {
      if (finishing) return; finishing = true; ended = true; port.input.pause();
      chain = chain.then(async () => { await port.shutdown(); await Promise.allSettled([...pending]); resolve(0); }); chain.catch(fail);
    };
    const frame = (line: Buffer): void => {
      chain = chain.then(async () => {
        if (port.stopping()) { finish(); return; }
        const { id, barrier, control } = descriptor(line);
        if (id !== null && ids.has(id)) { await port.error(id, -32600, 'request id already in flight'); return; }
        if (!barrier && (control ? controls >= 8 : ordinary >= 16)) {
          await port.error(id, -32001, 'request capacity reached', { reasonCode: 'request_capacity', admitted: false }); return;
        }
        if (id !== null) ids.add(id);
        if (control) controls++; else ordinary++;
        const task = port.handle(line).finally(() => { pending.delete(task); ids.delete(id); if (control) controls--; else ordinary--; });
        pending.add(task); task.catch(fail);
        if (barrier) await task;
        if (port.stopping()) finish();
      }); chain.catch(fail);
    };
    port.input.on('data', (chunk: Buffer) => {
      if (ended) return;
      let rest = chunk;
      for (let at = rest.indexOf(10); at >= 0; at = rest.indexOf(10)) {
        const head = rest.subarray(0, at + 1); rest = rest.subarray(at + 1);
        if (oversized || size + head.length > MAX_FRAME) {
          chain = chain.then(() => port.error(null, -32700, 'Parse error', { reason: `frame exceeds ${MAX_FRAME} bytes` })); chain.catch(fail);
        } else frame(Buffer.concat([...parts, head]));
        parts = []; size = 0; oversized = false;
      }
      if (rest.length) { size += rest.length; if (size > MAX_FRAME) { oversized = true; parts = []; } else parts.push(Buffer.from(rest)); }
    });
    port.input.on('end', () => { if (size && !oversized) frame(Buffer.concat(parts)); finish(); });
    port.input.on('error', finish);
    port.closed?.addEventListener('abort', finish, { once: true });
    if (port.closed?.aborted) finish();
  });
}
