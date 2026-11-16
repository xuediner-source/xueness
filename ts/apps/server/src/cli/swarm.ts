/**
 * `xueness swarm`: list, inspect and steer a conversation's swarms through the
 * same authorized routes as the Swarm pane. A swarm runs in the process that
 * started it; when a CLI run ends, its swarm is interrupted, and
 * `swarm resume <id> --session <sid> --wait` continues it in this process
 * until it settles.
 */
import { type Cli } from './host.ts';
import type { Parser } from './argparse.ts';

export function register(sub: ReturnType<Parser['subparsers']>): void {
  const group = sub.add('swarm', 'coordinator, workers and verifier on a shared board').subparsers('action', true);
  group.add('list').add('--session', { required: true });
  for (const action of ['show', 'board', 'post', 'stop', 'resume', 'kill', 'model', 'reassign']) {
    const cmd = group.add(action).add('id').add('--session', { required: true });
    if (action === 'board') cmd.add('--after', { type: 'int', default: 0 });
    if (action === 'post') cmd.add('text').add('--to', { help: 'comma-separated names or groups; default @coordinator' }).add('--channel', { help: 'target channel name (default main)' });
    if (action === 'stop' || action === 'kill') cmd.add('--reason');
    if (action === 'kill') cmd.add('member');
    if (action === 'model') cmd.add('member').add('--provider').add('--model').add('--inherit', { action: 'store_true' });
    if (action === 'reassign') cmd.add('member').add('to').add('--task').add('--fork', { action: 'store_true' });
    if (action === 'resume') cmd.add('--wait', { action: 'store_true', help: 'keep running here until the swarm settles' });
  }
}

export async function execute(cli: Cli): Promise<number | null> {
  const a = cli.args;
  if (a.cmd !== 'swarm') return null;
  const base = `/api/sessions/${encodeURIComponent(String(a.session))}/swarms`;
  if (a.action === 'list') return cli.report(await cli.api('GET', base));
  const target = `${base}/${encodeURIComponent(String(a.id))}`;
  if (a.action === 'show') return cli.report(await cli.api('GET', target));
  if (a.action === 'board') return cli.report(await cli.api('GET', `${target}/board?after=${Number(a.after ?? 0)}`));
  if (a.action === 'post') return cli.report(await cli.api('POST', `${target}/post`, { text: String(a.text), to: a.to ? String(a.to).split(',').map((item) => item.trim()).filter(Boolean) : [], ...(a.channel ? { channel: String(a.channel) } : {}) }));
  if (a.action === 'stop') return cli.report(await cli.api('POST', `${target}/stop`, a.reason ? { reason: String(a.reason) } : {}));
  if (a.action === 'kill') return cli.report(await cli.api('POST', `${target}/members/${encodeURIComponent(String(a.member))}/kill`, a.reason ? { reason: String(a.reason) } : {}));
  if (a.action === 'model') return cli.report(await cli.api('POST', `${target}/members/${encodeURIComponent(String(a.member))}/model`, { model: a.inherit === true ? 'inherit' : { provider_id: String(a.provider ?? ''), ...(a.model ? { model: String(a.model) } : {}) } }));
  if (a.action === 'reassign') return cli.report(await cli.api('POST', `${target}/members/${encodeURIComponent(String(a.member))}/reassign`, { to: String(a.to), ...(a.task ? { task: String(a.task) } : {}), ...(a.fork === true ? { fork: true } : {}) }));
  const reply = await cli.api('POST', `${target}/resume`, {});
  if (reply[0] >= 400 || a.wait !== true) return cli.report(reply);
  const app = await cli.host();
  await app.swarms.wait(String(a.id));
  return cli.report(await cli.api('GET', target));
}
