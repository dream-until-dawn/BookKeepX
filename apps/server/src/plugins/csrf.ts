/**
 * CSRF 防护（docs/auth.md §4）
 *
 * 修改数据的请求必须带 X-BookKeepX-Client: web。浏览器不允许其他网站在跨站请求中自定义请求头
 * （除非服务端开放 CORS，而我们不开放），因此伪造的跨站请求一定缺少这个头。
 * 与 Cookie 的 SameSite=Lax 构成两道防线。
 */
import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from '@bookkeepx/contracts';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors.ts';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function registerCsrfGuard(app: FastifyInstance) {
  app.addHook('onRequest', async (req) => {
    if (!UNSAFE_METHODS.has(req.method) || !req.url.startsWith('/api/')) return;
    if (req.headers[CLIENT_HEADER] !== CLIENT_HEADER_VALUE) {
      throw new AppError(403, 'CSRF_REJECTED', '请求被拒绝：缺少客户端标识');
    }
  });
}
