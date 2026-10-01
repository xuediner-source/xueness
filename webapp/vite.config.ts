import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
