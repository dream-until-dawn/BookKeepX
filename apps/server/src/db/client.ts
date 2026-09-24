/**
 * 数据库连接
 *
 * 注意（P0-2 实测）：postgres.js 默认把 int8 / numeric（包括 SUM 的结果）返回为字符串，
 * 手写 SQL 的聚合结果需要做安全整数转换（P1-2 加入）。
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

export type Db = ReturnType<typeof drizzle>;
/** 事务对象：与 Db 用法相同，但所有操作在同一个事务中 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** 既可以传普通连接也可以传事务：仓储函数统一接收它，由调用方决定是否在事务中执行 */
export type DbOrTx = Db | Tx;

export interface Database {
  db: Db;
  /** 关闭连接池（进程退出、测试结束时调用） */
  close: () => Promise<void>;
}

/**
 * 把数据库返回的整数（聚合结果可能是字符串或 bigint）安全地转成 JS number
 * @throws Error 超出安全整数范围或不是整数时抛错，而不是静默丢精度（P0-2 实测发现）
 */
export function toSafeInt(value: unknown): number {
  const n = typeof value === 'bigint' || typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n))
    throw new Error(`数据库返回的整数超出安全范围或非法：${String(value)}`);
  return n;
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
