/**
 * Vite 配置
 * - 开发时把 /api 代理到本地服务端（默认 3000 端口），前后端同源，Cookie 会话无需跨域配置
 */
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { pwaOptions } from './pwa.config.ts';

export default defineConfig({
  plugins: [react(), tailwindcss(), VitePWA(pwaOptions)],
  preview: {
    proxy: { '/api': { target: process.env.API_TARGET ?? 'http://localhost:3000', changeOrigin: true } },
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.API_TARGET ?? 'http://localhost:3000', changeOrigin: true } },
  },
});
