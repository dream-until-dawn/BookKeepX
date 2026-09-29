/** PWA 构建配置：明确列出可持久缓存的公共资源，不缓存入口或接口。 */
import type { VitePWAOptions } from 'vite-plugin-pwa';
export const pwaOptions: Partial<VitePWAOptions> = {
  strategies: 'injectManifest',
  srcDir: 'src/pwa',
  filename: 'sw.ts',
  registerType: 'prompt',
  injectRegister: false,
  includeAssets: ['icons/*.png', 'icons/*.svg', 'offline.html'],
  injectManifest: {
    globPatterns: ['assets/*.{js,css}', 'icons/*.{png,svg}', 'offline.html'],
    maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
  },
  manifest: {
    id: '/',
    name: 'BookKeepX 记账',
    short_name: 'BookKeepX',
    description: '手动记账、账单导入与收支统计',
    lang: 'zh-CN',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f9fafb',
    theme_color: '#2563eb',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  },
  devOptions: { enabled: false },
};
