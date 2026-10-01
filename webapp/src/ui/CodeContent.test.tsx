import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodeContent, CodeDisplayProvider, codeLanguage, normalizeCodeSettings } from './CodeContent';
import { loadHighlighter } from './CodePreview';
test('file display uses validated themes, font size, line numbers and wrap settings',()=>{
  const settings=normalizeCodeSettings({lightTheme:'unknown',darkTheme:'min-dark',fontSizePx:99,showLineNumbers:false,wrapLongLines:true});
  assert.equal(settings.lightTheme,'github-light');assert.equal(settings.fontSizePx,20);
  const html=renderToStaticMarkup(<CodeDisplayProvider settings={settings} dark><CodeContent path="file.py" text={'<script>bad</script>\nnext'}/></CodeDisplayProvider>);
  assert.match(html,/data-language="python"/);assert.match(html,/wraps-lines/);assert.doesNotMatch(html,/has-line-numbers|<script>/);assert.match(html,/font-size:20px/);
  assert.equal(codeLanguage('file.TSX'),'tsx');assert.equal(codeLanguage('file.unknown'),'text');
});
test('the actual highlighter loads the selected theme and file language without raw HTML injection',async()=>{
  const h=await loadHighlighter(['github-dark'],'json');const html=h.codeToHtml('{"markup":"<script>alert(1)</script>"}',{theme:'github-dark',lang:'json'});
  assert.match(html,/shiki github-dark/);assert.match(html,/span style="color:/);assert.doesNotMatch(html,/<script>/);assert.match(html,/&#x3C;script>|&lt;script>/);
});
