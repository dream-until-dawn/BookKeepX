/// <reference lib="webworker" />
/** 公共资源预缓存，账单接口和所有写入始终走网络；不做后台重放。 */
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from 'workbox-precaching';
import { registerRoute, setCatchHandler } from 'workbox-routing';
import { NetworkOnly } from 'workbox-strategies';
import { canShowOfflinePage, isApiRequest } from './policy.ts';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: { url: string; revision: string | null }[] };
const networkOnly = new NetworkOnly({ fetchOptions: { cache: 'no-store' } });
// 先注册 API 路由，避免任何预缓存规则接管接口。
registerRoute(({ url }) => isApiRequest(url, self.location.origin), networkOnly, 'GET');
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(({ request }) => request.mode === 'navigate', networkOnly);
setCatchHandler(async ({ request }) =>
  canShowOfflinePage(request) ? ((await matchPrecache('/offline.html')) ?? Response.error()) : Response.error(),
);
// 只有页面明确请求更新才激活新版本，不在安装时自动跳过等待。
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});
clientsClaim();
