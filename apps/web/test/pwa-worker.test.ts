/** 隔离浏览器生命周期，验证 SW 的路由、离线错误及激活协议。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const worker = vi.hoisted(() => ({
  route: vi.fn(),
  precache: vi.fn(),
  fallback: vi.fn(),
  network: vi.fn(),
  catchHandler: vi.fn(),
  claim: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock('workbox-core', () => ({ clientsClaim: worker.claim }));
vi.mock('workbox-precaching', () => ({
  precacheAndRoute: worker.precache,
  matchPrecache: worker.fallback,
  cleanupOutdatedCaches: worker.cleanup,
}));
vi.mock('workbox-routing', () => ({ registerRoute: worker.route, setCatchHandler: worker.catchHandler }));
vi.mock('workbox-strategies', () => ({
  NetworkOnly: class {
    constructor(options: unknown) {
      worker.network(options);
    }
  },
}));
const skipWaiting = vi.fn();
const addEventListener = vi.fn();
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal('self', {
    location: { origin: 'https://example.test' },
    __WB_MANIFEST: [],
    skipWaiting,
    addEventListener,
  });
  await import('../src/pwa/sw.ts');
});
afterEach(() => vi.unstubAllGlobals());
it('API 优先仅网络且禁用 HTTP 缓存；不注册 POST 重放', () => {
  expect(worker.network).toHaveBeenCalledWith({ fetchOptions: { cache: 'no-store' } });
  const [apiMatcher, , method] = worker.route.mock.calls[0] ?? [];
  expect(method).toBe('GET');
  expect(apiMatcher({ url: new URL('https://example.test/api/transactions') })).toBe(true);
  expect(apiMatcher({ url: new URL('https://example.test/assets/app.js') })).toBe(false);
  expect(worker.route).toHaveBeenCalledTimes(2);
  expect(worker.route.mock.invocationCallOrder[0] ?? 0).toBeLessThan(worker.precache.mock.invocationCallOrder[0] ?? 0);
});
it('离线导航使用公共说明页，接口导航仍返回网络错误', async () => {
  const offline = new Response('离线说明');
  worker.fallback.mockResolvedValue(offline);
  const handler = worker.catchHandler.mock.calls[0]?.[0];
  expect(await handler({ request: { mode: 'navigate', url: 'https://example.test/stats' } })).toBe(offline);
  for (const request of [
    { mode: 'navigate', url: 'https://example.test/api/me' },
    { mode: 'cors', url: 'https://example.test/api/me' },
  ]) {
    expect((await handler({ request })).type).toBe('error');
  }
  expect(worker.fallback).toHaveBeenCalledTimes(1);
});
it('缺失离线资源时保持网络错误', async () => {
  worker.fallback.mockResolvedValue(undefined);
  const handler = worker.catchHandler.mock.calls[0]?.[0];
  expect((await handler({ request: { mode: 'navigate', url: 'https://example.test/' } })).type).toBe('error');
});
it('安装时不自动跳过等待，只接受明确激活消息', () => {
  expect(skipWaiting).not.toHaveBeenCalled();
  const message = addEventListener.mock.calls.find(([name]) => name === 'message')?.[1];
  message({ data: { type: 'UNRELATED' } });
  message({});
  expect(skipWaiting).not.toHaveBeenCalled();
  message({ data: { type: 'SKIP_WAITING' } });
  expect(skipWaiting).toHaveBeenCalledTimes(1);
});
