/**
 * 组装 Fastify 应用
 *
 * 依赖（数据库、时钟、限流器等）从外部传入而不是在这里创建：测试可以传入测试库和可控时钟，
 * main.ts 传入真实配置。新增业务模块时：在 modules/<模块>/ 下实现，然后在这里注册一行。
 */
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import type { Database } from './db/client.ts';
import { accountRoutes } from './modules/accounts/routes.ts';
import { type AuthLimiters, createAuthLimiters } from './modules/auth/rate-limit.ts';
import { authRoutes } from './modules/auth/routes.ts';
import { categoryRoutes } from './modules/categories/routes.ts';
import { healthRoutes } from './modules/health/routes.ts';
import { importRoutes } from './modules/imports/routes.ts';
import { MAX_FILE_BYTES } from './modules/imports/service.ts';
import { ledgerRoutes } from './modules/ledgers/routes.ts';
import { transactionRoutes } from './modules/transactions/routes.ts';
import { registerAuth } from './plugins/auth.ts';
import { registerCsrfGuard } from './plugins/csrf.ts';
import { registerErrorHandler } from './plugins/error-handler.ts';
import { registerLedgerScope } from './plugins/ledger-scope.ts';

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
  // 账单上传：单文件、大小上限（docs/import.md §7）
  app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 10 } });
  registerCsrfGuard(app);
  registerAuth(app, { db, clock, secureCookie });
  registerLedgerScope(app, db);

  healthRoutes(app, deps);
  authRoutes(app, { db, clock, secureCookie, limiters: deps.limiters ?? createAuthLimiters(clock) });
  ledgerRoutes(app, db);
  categoryRoutes(app, db);
  accountRoutes(app, db);
  transactionRoutes(app, db);
  importRoutes(app, db, clock);
  return app;
}
