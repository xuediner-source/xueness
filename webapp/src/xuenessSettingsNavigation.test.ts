import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsNavigation } from './xuenessSettingsNavigation';
import { getLocale, setLocale } from './i18n';

test('all installed settings destinations have English labels, descriptions and groups', () => {
  const previous = getLocale();
  try {
    setLocale('en');
    const sections = settingsNavigation(new Set([
      'settings', 'files', 'providers', 'browser', 'network', 'memory', 'subagents',
      'mcp', 'skills', 'commands', 'hooks', 'usage', 'extensions', 'remote',
      'automation', 'desktop', 'updates', 'diagnostics',
    ]));
    assert.ok(sections.some(section => section.id === 'network'));
    assert.ok(sections.some(section => section.id === 'updates'));
    for (const section of sections) {
      assert.doesNotMatch(`${section.label} ${section.description} ${section.group}`, /[\u3400-\u9fff]/, section.id);
    }
  } finally {
    setLocale(previous);
  }
});

test('settings navigation hides ineffective plugin routes and keeps plugin management reachable', () => {
  assert.deepEqual(settingsNavigation(new Set()).map(section => section.id), ['plugins', 'modules']);
  const sections = settingsNavigation(new Set(['settings', 'files', 'providers', 'mcp']));
  assert.ok(sections.some(section => section.id === 'workspace'));
  assert.ok(sections.some(section => section.id === 'providers'));
  assert.ok(sections.some(section => section.id === 'mcp'));
  assert.equal(sections.some(section => section.id === 'browser'), false);
  assert.deepEqual(
    sections.filter(section => section.group === '基础设置' || section.group === 'Agent 能力' || section.group === '数据与统计')
      .map(section => section.id),
    ['general', 'appearance', 'providers', 'shortcuts', 'plugins', 'mcp'],
  );
  assert.equal(sections.find(section => section.id === 'workspace')?.group, '扩展与维护');
});

test('primary settings destinations use the upstream Chinese labels and order', () => {
  const labels = settingsNavigation(new Set(['settings', 'providers', 'browser', 'memory', 'subagents', 'mcp', 'skills', 'commands', 'hooks', 'usage']))
    .filter(section => section.group !== '扩展与维护')
    .map(({ id, label }) => [id, label]);
  assert.deepEqual(labels, [
    ['general', '常规'],
    ['appearance', '外观'],
    ['providers', '模型设置'],
    ['browser', '浏览器控制'],
    ['shortcuts', '键盘快捷键'],
    ['memory', '记忆'],
    ['subagents', '子智能体'],
    ['plugins', '插件'],
    ['mcp', 'MCP 服务器'],
    ['skills', '技能'],
    ['commands', '命令'],
    ['hooks', '钩子'],
    ['usage', '使用统计'],
  ]);
});
