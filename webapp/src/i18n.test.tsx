import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLocale, t, tf } from './i18n';
import { FileBrowser } from './plugins/files/FileBrowser';
import { SettingsSections } from './plugins/settings/SettingsSections';
import { XuenessCapabilityDialog } from './XuenessCapabilityDialog';

test('Office renders escaped structured contents in both languages', () => {
  try {
    setLocale('en');
    const html = renderToStaticMarkup(<FileBrowser files={[]} preview={{path:'a.docx', text:'', truncated:false, office:{kind:'docx',truncated:false,sections:[{name:'Document',blocks:[{text:'<script>alert(1)</script>'},{table:[['cell']]}]}]}}} />);
    assert.match(html, /read-only Office preview/i);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /<td>cell<\/td>/);
    assert.doesNotMatch(html, /<script>/);
    setLocale('zh');
    assert.equal(t('工作区文件'), '工作区文件');
  } finally { setLocale('zh'); }
});
test('rich Office rendering handles local slide geometry, styles, sheet merges and only embedded images', () => {
  try {
    setLocale('en');
    const html = renderToStaticMarkup(<FileBrowser files={[]} preview={{
      path: 'deck.pptx', text: '', truncated: false,
      office: { kind: 'pptx', truncated: false, sections: [{ name: 'Slide 1', layout: { width: 1000, height: 500, unit: 'emu' }, blocks: [
        { type: 'shape', text: '<safe text>', runs: [{ text: 'Title <safe text>', style: { bold: true, color: '#123456' } }], position: { x: 100, y: 50, width: 500, height: 100 }, style: { fill: '#ffffff' }, images: [
          { mime: 'image/png', dataUrl: 'data:image/png;base64,aGVsbG8=', alt: 'embedded' },
          { mime: 'image/png', dataUrl: 'https://example.invalid/tracker.png', alt: 'remote' },
        ] },
        { type: 'table', table: [['A', '']], cellStyles: [[{ bold: true }, {}]], mergedRanges: ['A1:B1'] },
      ] }] },
    }} />);
    assert.match(html, /xn-office-slide__canvas/);
    assert.match(html, /left:10%/);
    assert.match(html, /color:#123456/);
    assert.match(html, /rowSpan="1" colSpan="2"/);
    assert.match(html, /data:image\/png;base64,aGVsbG8=/);
    assert.doesNotMatch(html, /example\.invalid/);
    assert.match(html, /&lt;safe text&gt;/);
  } finally { setLocale('zh'); }
});
test('runtime locale changes translate static settings labels and resource fields', () => {
  try {
    setLocale('en');
    assert.equal(tf('已选择 {0}', ['User model']), 'Selected User model');
    let html = renderToStaticMarkup(<SettingsSections sections={[]} activeSection="shortcuts" values={{}} capabilities={{allowMcp:false,allowSubagents:false,allowHooks:false}} />);
    assert.match(html, /keyboard shortcuts/i);
    assert.match(html, /New task/);
    html = renderToStaticMarkup(<XuenessCapabilityDialog open mode="create" kind="skills" />);
    assert.match(html, /New Skills/);
    assert.match(html, /Description/);
    setLocale('zh');
    html = renderToStaticMarkup(<XuenessCapabilityDialog open mode="create" kind="skills" />);
    assert.match(html, /新建技能/);
  } finally { setLocale('zh'); }
});

test('batch B translation keys are present in English', () => {
  try {
    setLocale('en');
    assert.equal(t('连接已保存'), 'Connection saved');
    assert.equal(t('已保存的连接'), 'Saved connections');
    assert.equal(t('刷新连接列表'), 'Refresh connection list');
    assert.equal(t('正在加载连接…'), 'Loading connections...');
    assert.equal(t('还没有任何 SSH 连接，使用右侧表单添加第一个。'), 'No SSH connections yet. Use the form on the right to add the first one.');
    assert.equal(t('连接详情'), 'Connection details');
    assert.equal(t('工作流计划不是有效的 JSON，请检查括号和引号。'), 'Workflow plan is not valid JSON. Please check brackets and quotes.');
    assert.equal(t('命令参数不是有效的 JSON 数组，例如 ["python3","-c","print(1)"]。'), 'Command arguments are not a valid JSON array, e.g. ["python3","-c","print(1)"].');
    assert.equal(t('命令参数必须是字符串数组，例如 ["python3","-c","print(1)"]。'), 'Command arguments must be an array of strings, e.g. ["python3","-c","print(1)"].');
    assert.equal(t('提示参数不是有效的 JSON，请输入一个对象，例如 {"key":"value"}。'), 'Prompt arguments are not valid JSON. Please enter an object, e.g. {"key":"value"}.');
    assert.equal(t('打开 OAuth 授权页'), 'Open OAuth authorization page');
    assert.equal(t('OAuth URL 必须使用 HTTPS'), 'OAuth URL must use HTTPS');
    assert.equal(tf('将删除早于 {0} 天的日志文件。其他存储数据不会更改。', [30]), 'Log files older than 30 days will be deleted. Other stored data will not change.');
  } finally { setLocale('zh'); }
});
