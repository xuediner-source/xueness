/** Native script workflows use the same authorized application service as HTTP. */
import { readFileSync } from 'node:fs';
import { type Cli } from './host.ts';
import type { Parser } from './argparse.ts';

export function register(sub: ReturnType<Parser['subparsers']>): void {
  const group = sub.add('workflow-script', 'native typed script workflows; start/resume waits for settlement').subparsers('action', true);
  for (const action of ['check', 'create']) {
    const cmd = group.add(action).add('file').add('--session', { required: true });
    if (action === 'create') cmd.add('--name').add('--concurrency', { type: 'int', default: 2 }).add('--writable', { action: 'store_true' });
  }
  group.add('list').add('--session', { required: true });
  for (const action of ['show', 'start', 'resume', 'cancel', 'recover', 'concurrency', 'resolve', 'amend']) {
    const cmd = group.add(action).add('id').add('--session', { required: true });
    if (action === 'start' || action === 'resume') cmd.add('--digest', { required: true }).add('--approve', { action: 'store_true' }).add('--allow-real', { action: 'store_true' });
    if (action === 'concurrency') cmd.add('limit', { type: 'int' });
    if (action === 'resolve') cmd.add('node').add('answer', { help: 'JSON value for a hole; JSON string for an actor answer' });
    if (action === 'amend') cmd.add('file');
  }
}
export async function execute(cli: Cli): Promise<number | null> {
  const a = cli.args;
  if (a.cmd !== 'workflow-script') return null;
  const base = `/api/sessions/${encodeURIComponent(String(a.session))}/workflow-scripts`;
  if (a.action === 'list') return cli.report(await cli.api('GET', base));
  if (a.action === 'check') return cli.report(await cli.api('POST', base + '/compile', { source: readFileSync(String(a.file), 'utf8') }));
  if (a.action === 'create') return cli.report(await cli.api('POST', base, { source: readFileSync(String(a.file), 'utf8'), maxConcurrency: a.concurrency, writable: a.writable === true, ...a.name ? { name: String(a.name) } : {} }));
  const target = base + '/' + encodeURIComponent(String(a.id));
  if (a.action === 'show') return cli.report(await cli.api('GET', target));
  const body = a.action === 'start' || a.action === 'resume' ? { digest: a.digest, confirmed: a.approve === true, allowReal: a.allow_real === true }
    : a.action === 'amend' ? { source: readFileSync(String(a.file), 'utf8') }
      : a.action === 'concurrency' ? { maxConcurrency: a.limit }
        : a.action === 'resolve' ? { nodeId: a.node, answer: JSON.parse(String(a.answer)) } : {};
  const reply = await cli.api('POST', target + '/' + String(a.action), body);
  if (reply[0] >= 400) return cli.report(reply);
  if (a.action === 'start' || a.action === 'resume') {
    const app = await cli.host();
    await app.dynamicWorkflows.wait(String(a.id));
    return cli.report(await cli.api('GET', target));
  }
  return cli.report(reply);
}
