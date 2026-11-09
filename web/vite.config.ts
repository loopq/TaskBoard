import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  server: {
    // 页面与 API 同域名：开发时把 /api 原样代理到本地 Node 服务（cd api && npm run dev）。
    // 手机用 `npm run dev -- --host` 走局域网访问也能连上 API
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
});
