import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { resolveToolRenderer, TOOL_RENDERER_REGISTRY, ToolStatusShell } from './toolRenderers';

test('tool renderer registry resolves stable identities and falls back safely', () => {
  const effective = new Set(['sessions', 'files', 'shell']);
  assert.equal(resolveToolRenderer('read_file').id, 'read');
  assert.equal(resolveToolRenderer('file_edit_apply').id, 'edit');
  assert.equal(resolveToolRenderer('exec_poll').id, 'exec');
  assert.equal(resolveToolRenderer('read_file', effective).id, 'read');
  assert.equal(resolveToolRenderer('file_edit_apply', effective).id, 'edit');
  assert.equal(resolveToolRenderer('exec_poll', effective).id, 'exec');
  assert.equal(resolveToolRenderer('TodoWrite').id, 'fallback');
  assert.equal(resolveToolRenderer('read_file', new Set(['sessions', 'shell'])).id, 'fallback');
  assert.equal(resolveToolRenderer('exec', new Set(['sessions', 'files'])).id, 'fallback');
  assert.equal(resolveToolRenderer('unknown_tool', new Set(['sessions', 'files', 'shell'])).id, 'fallback');
  assert.equal(Object.isFrozen(TOOL_RENDERER_REGISTRY), true);
  assert.equal(Object.isFrozen(TOOL_RENDERER_REGISTRY.read.requiredPlugins), true);
});

test('tool status shell exposes approval and stable status markers', () => {
  const approval = renderToStaticMarkup(<ToolStatusShell status="running" pendingApproval>等待批准</ToolStatusShell>);
  assert.match(approval, /data-tool-status-shell="true"/);
  assert.match(approval, /data-status="pendingApproval"/);
  assert.doesNotMatch(renderToStaticMarkup(<ToolStatusShell status="error" pendingApproval />), /data-failed="true"/);
  const failed = renderToStaticMarkup(<ToolStatusShell status="error" />);
  assert.match(failed, /data-status="error"/);
  assert.match(failed, /data-failed="true"/);
  const cancelled = renderToStaticMarkup(<ToolStatusShell status="cancelled" />);
  assert.match(cancelled, /data-status="cancelled"/);
  assert.match(cancelled, /已取消/);
  assert.doesNotMatch(renderToStaticMarkup(<ToolStatusShell status="ok">成功</ToolStatusShell>), /data-tool-status-shell/);
});
