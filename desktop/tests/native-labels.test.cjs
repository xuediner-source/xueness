const test = require('node:test');
const assert = require('node:assert/strict');
const { buildApplicationMenu, getNativeLabels } = require('../src/native-labels.cjs');

function item(menu, label) {
  for (const entry of menu) {
    if (entry.label === label) return entry;
    const nested = entry.submenu && item(entry.submenu, label);
    if (nested) return nested;
  }
  return null;
}

test('native menus use Chinese labels and retain Electron role shortcuts', () => {
  const menu = buildApplicationMenu('zh', 'darwin');
  assert.deepEqual(menu.map(entry => entry.label), ['Xueness', '编辑', '视图', '窗口']);
  assert.equal(item(menu, '撤销').role, 'undo');
  assert.equal(item(menu, '重新载入').role, 'reload');
  assert.equal(item(menu, '最小化').role, 'minimize');
  assert.equal(item(menu, '全部置于最前面').role, 'front');
  assert.equal(item(menu, '关于 Xueness').role, 'about');
  assert.equal(item(menu, '退出 Xueness').role, 'quit');
  assert.equal(getNativeLabels('zh').projectFolderTitle, '选择项目文件夹');
});

test('native menus use English labels on Windows and expose a localized File menu', () => {
  const menu = buildApplicationMenu('en', 'win32');
  assert.deepEqual(menu.map(entry => entry.label), ['Edit', 'View', 'Window', 'File']);
  assert.equal(item(menu, 'Undo').role, 'undo');
  assert.equal(item(menu, 'Reload').role, 'reload');
  assert.equal(item(menu, 'Minimize').role, 'minimize');
  assert.equal(item(menu, 'Close Window').role, 'close');
  assert.equal(item(menu, 'Quit Xueness').role, 'quit');
  assert.equal(getNativeLabels('en').projectFolderTitle, 'Choose project folder');
  assert.match(getNativeLabels('en').startupErrorMessage, /built-in backend/);
});

test('unknown locale falls back to Chinese', () => {
  assert.equal(getNativeLabels('fr').edit, getNativeLabels('zh').edit);
});
