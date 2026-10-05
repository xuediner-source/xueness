import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLocale, t } from '../../i18n';
import { SettingsAccountCard, SettingsEmptyState, SettingsGroup, SettingsRow } from './SettingsPrimitives';

test('settings group renders a titled card and keeps the header out when unnamed', () => {
  const html = renderToStaticMarkup(
    <SettingsGroup title="语言" description="选择应用 UI 的显示语言。">
      <SettingsRow label="界面语言" description="只影响界面文字。" control={<button type="button">English</button>} />
    </SettingsGroup>,
  );
  assert.match(html, /<section class="xn-settings-card-group">/);
  assert.match(html, /<header class="xn-settings-card-group__header"><h2>语言<\/h2><p>选择应用 UI 的显示语言。<\/p><\/header>/);
  assert.match(html, /<div class="xn-settings-group"><div class="xn-setting-row">/);
  assert.match(html, /<h3>界面语言<\/h3><p>只影响界面文字。<\/p>/);
  assert.match(html, /<div class="xn-setting-control"><button type="button">English<\/button><\/div>/);

  const unnamed = renderToStaticMarkup(<SettingsGroup><SettingsRow label="界面主题" control={<span />} /></SettingsGroup>);
  assert.doesNotMatch(unnamed, /<header/);
  assert.doesNotMatch(unnamed, /<p><\/p>|界面主题<\/h3><p>/);
});

test('settings empty state offers the primary action and a documentation link', () => {
  const html = renderToStaticMarkup(
    <SettingsEmptyState
      icon={<span data-testid="empty-icon" />}
      title="还没有自定义模型配置"
      description="添加一个 API 配置后即可切换。"
      actionLabel="添加配置"
      onAction={() => undefined}
      linkLabel="查看文档"
      href="docs/xueness-local-lightweight-mode.md"
    />,
  );
  assert.match(html, /<div class="xn-settings-empty" data-testid="xn-settings-empty">/);
  assert.match(html, /<span class="xn-settings-empty__icon" aria-hidden="true"><span data-testid="empty-icon"><\/span><\/span>/);
  assert.match(html, /<p class="xn-settings-empty__title">还没有自定义模型配置<\/p>/);
  assert.match(html, /<p class="xn-settings-empty__description">添加一个 API 配置后即可切换。<\/p>/);
  assert.match(html, /<button type="button" class="xn-btn xn-btn--primary xn-btn--md">添加配置<\/button>/);
  assert.match(html, /<a class="xn-settings-empty__link" href="docs\/xueness-local-lightweight-mode\.md">查看文档<\/a>/);
});

test('settings empty state omits actions it cannot perform', () => {
  const titleOnly = renderToStaticMarkup(<SettingsEmptyState title="还没有数据" />);
  assert.doesNotMatch(titleOnly, /xn-settings-empty__actions/);

  const withoutHandler = renderToStaticMarkup(<SettingsEmptyState title="还没有数据" actionLabel="添加配置" />);
  assert.match(withoutHandler, /<button[^>]*disabled="">添加配置<\/button>/);

  const linkOnly = renderToStaticMarkup(<SettingsEmptyState title="还没有数据" linkLabel="查看文档" href="docs/xueness-local-lightweight-mode.md" />);
  assert.doesNotMatch(linkOnly, /<button/);
});

test('settings account card shows an initial, the workspace tail and badges', () => {
  const html = renderToStaticMarkup(
    <SettingsAccountCard
      name="xueness"
      path="/home/box/projects/xueness"
      badges={[{ label: 'main', title: '当前 Git 分支' }, { label: 'v1.0.0', title: '配置设置插件版本' }]}
    />,
  );
  assert.match(html, /<div class="xn-settings-account" data-testid="xn-settings-account">/);
  assert.match(html, /<span class="xn-settings-account__avatar" aria-hidden="true">X<\/span>/);
  assert.match(html, /<span class="xn-settings-account__name" title="xueness">xueness<\/span>/);
  assert.match(html, /<span class="xn-settings-account__path" title="\/home\/box\/projects\/xueness">…\/projects\/xueness<\/span>/);
  assert.match(html, /<span class="xn-settings-account__badge" title="当前 Git 分支">main<\/span>/);
  assert.match(html, /<span class="xn-settings-account__badge" title="配置设置插件版本">v1\.0\.0<\/span>/);
});

test('settings account card keeps short paths whole and falls back to a subtitle', () => {
  assert.match(
    renderToStaticMarkup(<SettingsAccountCard name="webapp" path="webapp/src" />),
    /<span class="xn-settings-account__path" title="webapp\/src">webapp\/src<\/span>/,
  );
  const empty = renderToStaticMarkup(<SettingsAccountCard name="未选择工作区" subtitle="选择项目目录后显示在这里" />);
  assert.match(empty, /<span class="xn-settings-account__path">选择项目目录后显示在这里<\/span>/);
  assert.doesNotMatch(empty, /xn-settings-account__badges/);
});

test('settings presentation strings carry English translations', () => {
  try {
    setLocale('en');
    assert.equal(t('还没有自定义模型配置'), 'No custom model profiles yet');
    assert.equal(t('添加一个 API 配置后，可随时切换当前运行使用的模型。'), 'Add an API profile to switch the model used by the current run at any time.');
    assert.equal(t('查看文档'), 'View docs');
    assert.equal(t('未选择工作区'), 'No workspace selected');
    assert.equal(t('当前 Git 分支'), 'Current Git branch');
    assert.equal(t('配置设置插件版本'), 'Config settings plugin version');
  } finally {
    setLocale('zh');
  }
});
