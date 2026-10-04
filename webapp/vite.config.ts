import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

export default defineConfig({
  plugins: [react(), {
    name: 'xueness-prepaint-theme',
    transformIndexHtml(html, context) {
      if (context.filename.endsWith('tray.html')) return html;
      const source = readFileSync(resolve(import.meta.dirname, 'src/plugins/settings/themeBoot.ts'), 'utf8');
      const { code } = transformSync(source, { loader: 'ts', format: 'iife', minify: true, target: 'es2020' });
      return [{ tag: 'script', children: code, injectTo: 'head' }];
    },
  }],
  build: { rollupOptions: {
    input: { workbench: resolve(import.meta.dirname, 'index.html'), tray: resolve(import.meta.dirname, 'tray.html') },
    output: { manualChunks(id) {
      // Give the shared React runtime a stable cache identity across plugin chunks.
      if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react-vendor';
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
