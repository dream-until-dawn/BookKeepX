/**
 * 数据库连接
 *
 * 注意（P0-2 实测）：postgres.js 默认把 int8 / numeric（包括 SUM 的结果）返回为字符串，
 * Drizzle 只对声明了 mode:'number' 的列做转换，手写 SQL 的聚合结果仍是字符串 —— 必须用 toSafeInt 转换。
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { join } from 'node:path';
import * as schema from './schema.ts';

export const DEFAULT_URL = 'postgres://bookkeepx:probe-only-password@localhost:55432/bookkeepx_probe';

export function createDb(url = process.env.DATABASE_URL ?? DEFAULT_URL) {
  const client = postgres(url, { max: 5, onnotice: () => {} });
  return { db: drizzle(client, { schema }), client };
}

export type Db = ReturnType<typeof createDb>['db'];

/** 执行 drizzle/ 目录下的 SQL 迁移（已执行过的会自动跳过） */
export async function runMigrations(db: Db) {
  await migrate(db, { migrationsFolder: join(import.meta.dirname, '../../drizzle') });
}

/**
 * 把数据库返回的整数（可能是字符串 / bigint）安全地转成 JS number
 * @throws 超出安全整数范围时抛错，而不是静默丢精度
 */
export function toSafeInt(v: unknown): number {
  const n = typeof v === 'bigint' ? Number(v) : typeof v === 'string' ? Number(v) : (v as number);
  if (!Number.isSafeInteger(n)) throw new Error(`数据库返回的整数超出安全范围或非法: ${String(v)}`);
  return n;
}
