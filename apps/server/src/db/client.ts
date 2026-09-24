/**
 * 数据库连接
 *
 * 注意（P0-2 实测）：postgres.js 默认把 int8 / numeric（包括 SUM 的结果）返回为字符串，
 * 手写 SQL 的聚合结果需要做安全整数转换（P1-2 加入）。
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

export interface Database {
  db: ReturnType<typeof drizzle>;
  /** 关闭连接池（进程退出、测试结束时调用） */
  close: () => Promise<void>;
}

/**
 * 创建数据库连接。连接是惰性的：这里不会立即连库，第一次查询时才连接，
 * 因此数据库暂时不可用时服务端仍能启动，并通过健康检查报告 database: down。
 */
export function createDatabase(url: string): Database {
  const client = postgres(url, {
    max: 10,
    // 连接失败时尽快报错，避免健康检查长时间挂起
    connect_timeout: 3,
    onnotice: () => {},
  });
  return { db: drizzle(client), close: () => client.end({ timeout: 5 }) };
}

/** 探测数据库是否可用 */
export async function pingDatabase(database: Database): Promise<boolean> {
  try {
    await database.db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}
