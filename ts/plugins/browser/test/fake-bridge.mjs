// Test double for bridge.mjs: same JSON-lines protocol, behaviour picked by FAKE_BRIDGE.
import { createInterface } from 'node:readline';
const mode = process.env.FAKE_BRIDGE || 'ready';
const out = (value) => process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value)) + '\n');
if (mode === 'silent') setInterval(() => {}, 1000);
else if (mode === 'garbage') out('hello');
else if (mode === 'noready') { out({ ready: false, reason: process.env.FAKE_REASON || 'browser_missing' }); process.exit(1); }
else {
  out({ ready: true, profile: process.argv[2], cwd: process.cwd() });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake')]).toString('base64');
  let count = 0;
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const command = JSON.parse(line); count += 1;
    const url = command.url || '';
    if (url === 'https://big.example/') out('{"ok":true,"pad":"' + 'x'.repeat(1_000_000) + '"}');
    else if (url === 'https://edge.example/') out('{"ok":true,"pad":"' + 'x'.repeat(1_000_000 - 21) + '"}');
    else if (url === 'https://bad.example/') out('not json');
    else if (url === 'https://array.example/') out('[]');
    else if (url === 'https://nobool.example/') out({ ok: 'yes' });
    else if (url === 'https://hang.example/') { /* never answers */ }
    else if (url === 'https://exit.example/') process.exit(3);
    else if (command.action === 'screenshot') out({ ok: true, url: 'https://e.example/', title: 'Fake', mimeType: 'image/png', imageDataUrl: 'data:image/png;base64,' + png, untrusted: true, maxPngBytes: command.maxPngBytes });
    else if (command.action === 'snapshot') out({ ok: true, url: 'https://e.example/', title: 'Fake', nodes: [{ role: 'button', name: 'Go', ref: 'e1' }], totalNodes: 1, truncated: false, untrusted: true });
    else if (command.action === 'click' && command.selector === '#fail') out({ ok: false, error: 'browser action failed' });
    else out({ ok: true, url: url || 'https://e.example/', title: 'Fake', text: 'body', links: [], untrusted: true, echo: command, count, pid: process.pid,
      leaked: Object.keys(process.env).filter((key) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)), electron: process.env.ELECTRON_RUN_AS_NODE ?? null });
  }
}
