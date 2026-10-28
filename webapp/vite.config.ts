import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { createHash } from 'node:crypto';

const appearances = Object.fromEntries(Object.entries({
  xueness: 'xueness-superposition.css', claudex: 'claudex-scheme.css',
}).map(([palette, file]) => {
  const source = transformSync(readFileSync(resolve(import.meta.dirname, 'src/styles', file), 'utf8'), { loader: 'css', minify: true }).code;
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 10);
  return [palette, { source, file, asset: `assets/appearance-${palette}-${hash}.css` }];
}));

export default defineConfig({
  plugins: [react(), {
    name: 'xueness-prepaint-theme',
    generateBundle() {
      for (const appearance of Object.values(appearances)) {
        this.emitFile({ type: 'asset', fileName: appearance.asset, source: appearance.source });
      }
    },
    transformIndexHtml(html, context) {
      if (context.filename.endsWith('tray.html')) return html;
      const source = readFileSync(resolve(import.meta.dirname, 'src/plugins/settings/themeBoot.ts'), 'utf8');
      const { code } = transformSync(source, { loader: 'ts', format: 'iife', minify: true, target: 'es2020' });
      const hrefs = Object.fromEntries(Object.entries(appearances).map(([palette, appearance]) =>
        [palette, context.server ? `/src/styles/${appearance.file}` : `/${appearance.asset}`]));
      return [
        ...Object.entries(hrefs).map(([palette, href]) => ({ tag: 'meta', attrs: { name: `xn-appearance-${palette}`, content: href }, injectTo: 'head' as const })),
        { tag: 'script', children: code, injectTo: 'head' },
        { tag: 'script', children: `document.write('<link id="xn-appearance" rel="stylesheet" href="'+document.querySelector('meta[name="xn-appearance-'+(document.documentElement.dataset.xnPalette||'xueness')+'"]').content+'">')`, injectTo: 'head' },
      ];
    },
  }],
  build: { rollupOptions: {
    input: { workbench: resolve(import.meta.dirname, 'index.html'), tray: resolve(import.meta.dirname, 'tray.html') },
    output: { onlyExplicitManualChunks: true, manualChunks(id) {
      const optional = /\/src\/plugins\/(subscriptions|model_monitor|workbuddy)\//.exec(id.replaceAll('\\', '/'));
      if (optional) return `optional-${optional[1]}`;
      // Give the shared React runtime a stable cache identity across plugin chunks.
      if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react-vendor';
      if (/node_modules\/(micromark|mdast|unist|unified|vfile|hast|property-information|remark|react-markdown)/.test(id)) return 'markdown-vendor';
      if (/node_modules\/(@radix-ui|@floating-ui)/.test(id)) return 'radix-vendor';
    } },
  } },
  // Keep ES workers enabled for the dynamically loaded Office/PPTX renderer.
  worker: {
    format: "es",
    rollupOptions: {
      treeshake: false,
    },
  },
  server: {
    port: 5174,
    // 本地开发时把 /api 转发到真正的后端（compose 容器 8137）。
    // 没有它时 vite 会用 index.html 兜底，`response.json()` 抛 SyntaxError，
    // 前端一律降级成空结果——那样就复现不出“后端有数据”时的真实启动路径。
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8137",
        changeOrigin: false,
      },
    },
  },
});
