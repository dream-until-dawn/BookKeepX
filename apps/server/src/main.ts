/**
 * 服务端入口：读取配置 → 连接数据库 → 启动 HTTP 服务，收到退出信号时优雅关闭
 */
import { buildApp } from './app.ts';
import { loadEnv } from './config/env.ts';
import { createDatabase } from './db/client.ts';

const env = loadEnv();
const database = createDatabase(env.DATABASE_URL);
const app = buildApp({ database, logger: env.NODE_ENV !== 'test' });

async function shutdown(signal: string) {
  app.log.info(`收到 ${signal}，正在关闭…`);
  await app.close();
  await database.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: env.PORT, host: env.HOST });
