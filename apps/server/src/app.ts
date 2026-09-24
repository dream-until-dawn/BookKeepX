/**
 * 组装 Fastify 应用
 *
 * 依赖（数据库、时钟、限流器等）从外部传入而不是在这里创建：测试可以传入测试库和可控时钟，
 * main.ts 传入真实配置。新增业务模块时：在 modules/<模块>/ 下实现，然后在这里注册一行。
 */
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import type { Database } from './db/client.ts';
import { type AuthLimiters, createAuthLimiters } from './modules/auth/rate-limit.ts';
import { authRoutes } from './modules/auth/routes.ts';
import { healthRoutes } from './modules/health/routes.ts';
import { registerAuth } from './plugins/auth.ts';
import { registerCsrfGuard } from './plugins/csrf.ts';
import { registerErrorHandler } from './plugins/error-handler.ts';

export interface AppDeps {
  database: Database;
  /** 是否输出请求日志（测试时关闭） */
  logger?: boolean;
  /** 当前时间；测试中注入可控时钟以验证过期、续期、限流窗口 */
  clock?: () => Date;
  /** Cookie 是否加 Secure（生产环境 HTTPS 下为 true） */
  secureCookie?: boolean;
  /** 限流器；不传则按 docs/auth.md §5 的默认规则创建 */
  limiters?: AuthLimiters;
}

export function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: deps.logger ?? false });
  const clock = deps.clock ?? (() => new Date());
  const secureCookie = deps.secureCookie ?? false;
  const db = deps.database.db;

  registerErrorHandler(app);
  app.register(cookie);
  registerCsrfGuard(app);
  registerAuth(app, { db, clock, secureCookie });

  healthRoutes(app, deps);
  authRoutes(app, { db, clock, secureCookie, limiters: deps.limiters ?? createAuthLimiters(clock) });
  return app;
}
