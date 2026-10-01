import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLocale, t, tf } from './i18n';
import { FileBrowser } from './XuenessWorkbenchView2';
import { SettingsSections } from './XuenessPanels';
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
