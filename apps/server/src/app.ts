/**
 * 组装 Fastify 应用
 *
 * 依赖（数据库等）从外部传入而不是在这里创建：测试可以传入测试库，main.ts 传入真实配置。
 * 新增业务模块时：在 modules/<模块>/ 下实现，然后在这里注册一行。
 */
import Fastify from 'fastify';
import type { Database } from './db/client.ts';
import { healthRoutes } from './modules/health/routes.ts';
import { registerErrorHandler } from './plugins/error-handler.ts';

export interface AppDeps {
  database: Database;
  /** 是否输出请求日志（测试时关闭） */
  logger?: boolean;
}

export function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: deps.logger ?? false });
  registerErrorHandler(app);
  healthRoutes(app, deps);
  return app;
}
