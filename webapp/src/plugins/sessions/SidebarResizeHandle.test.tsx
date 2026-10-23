import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { clampSidebarWidth, decodeSidebarWidths, sidebarWidthLimits } from './SidebarResizeHandle';

test('sidebar sizing keeps a usable main pane, finite limits and different appearance defaults', () => {
  assert.deepEqual(sidebarWidthLimits('xueness', 1280), { min:220, max:480 });
  assert.deepEqual(sidebarWidthLimits('claudex', 1280), { min:280, max:560 });
  assert.equal(clampSidebarWidth(600,'claudex',940),460);
  assert.equal(clampSidebarWidth(250,'claudex',1280),280);
  assert.equal(clampSidebarWidth(NaN,'xueness',1280),270);
  assert.equal(clampSidebarWidth(Infinity,'claudex',1280),340);
  assert.equal(clampSidebarWidth(340,'claudex',420),280);
});

test('stored sidebar widths are validated per appearance without trusting unknown fields', () => {
  assert.deepEqual(decodeSidebarWidths('{"xueness":320,"claudex":420,"extra":999}'),{xueness:320,claudex:420});
  assert.deepEqual(decodeSidebarWidths('{"xueness":"320","claudex":true}'),{});
  assert.deepEqual(decodeSidebarWidths('{"xueness":-500,"claudex":10000}'),{xueness:220,claudex:560});
  for (const raw of [null,'broken','null','[]','"a"']) assert.deepEqual(decodeSidebarWidths(raw),{});
});

test('drag cursor is keyed by a shell attribute instead of a document-wide :has() restyle', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/plugins/sessions/sidebar-resize.css'), 'utf8');
  assert.match(css, /\.xn-shell-layout\[data-sidebar-resizing="true"\] \*/);
  // A shell-level :has() with a descendant branch restyled every element on each keystroke and stream tick.
  assert.doesNotMatch(css, /\.xn-shell-layout:has\(/);
});
