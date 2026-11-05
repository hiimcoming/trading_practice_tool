// 前端打包与开发服务器配置（Vite）。
// 开发模式：npm run dev 后访问 http://127.0.0.1:5173 ；网页里所有 /api 请求转给本机后端（127.0.0.1:8000）。
// 日常使用：npm run build 打包到 dist/，由后端在同一个端口直接提供网页（规格书第 4 节「一个程序，一个端口」）。
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// 画线库 B 用项目里复制的源码（web_frontend/vendor/，规格书 D23），不再从 npm 安装
const DRAWING_LIB_ENTRY = resolve(import.meta.dirname, 'vendor', 'lightweight-charts-drawing', 'src', 'index.ts');
const BACKEND_URL = process.env.TPT_BACKEND_URL ?? 'http://127.0.0.1:8000';

export default defineConfig({
  resolve: { alias: { 'lightweight-charts-drawing': DRAWING_LIB_ENTRY } },
  // 画线库 B 的源码里引用了构建时注入的版本号常量（上游 vite.config 里定义）
  define: { __VERSION__: JSON.stringify('0.6.2-vendored') },
  // 界面框架 Preact：JSX 按 Preact 方式编译
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: BACKEND_URL, changeOrigin: false } },
    // 允许读取项目根目录下的 common_settings/（前后端共用的设置文件）
    fs: { allow: [resolve(import.meta.dirname, '..')] },
  },
  // 画线库 B 自带的单元测试 + 本项目前端测试（npm test）
  test: { include: ['vendor/**/test/**/*.test.ts', 'src/**/*.test.ts'] },
});
