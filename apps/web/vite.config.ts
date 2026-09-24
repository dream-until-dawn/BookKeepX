/**
 * Vite 配置
 * - 开发时把 /api 代理到本地服务端（默认 3000 端口），前后端同源，Cookie 会话无需跨域配置
 */
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.API_TARGET ?? 'http://localhost:3000', changeOrigin: true } },
  },
});
