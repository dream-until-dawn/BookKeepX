/** 测试公共工具 */
import { createDatabase } from '../src/db/client.ts';

/** 测试库连接串：本地来自 .env / 默认值，CI 由工作流注入 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://bookkeepx:bookkeepx-dev@localhost:54320/bookkeepx_test';

/** 一个必然连不上的数据库（端口 1 无服务），用于测试"数据库不可用"的分支 */
export const UNREACHABLE_DATABASE_URL = 'postgres://nobody:nothing@127.0.0.1:1/none';

export const testDatabase = () => createDatabase(TEST_DATABASE_URL);
