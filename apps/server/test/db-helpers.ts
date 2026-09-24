/**
 * 数据库测试工具：每个测试文件开始时重建测试库结构并执行正式迁移
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll } from 'vitest';
import type { Database } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { createUserWithDefaultLedger } from '../src/modules/users/service.ts';
import { TEST_DATABASE_URL, testDatabase } from './helpers.ts';

/** 清空测试库并执行迁移；返回的对象在 beforeAll 之后可用 */
export function useMigratedDatabase(): Database {
  const holder = {} as Database;
  beforeAll(async () => {
    const database = testDatabase();
    await database.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
    await database.db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
    await database.db.execute(sql`CREATE SCHEMA public`);
    await runMigrations(TEST_DATABASE_URL);
    Object.assign(holder, database);
  });
  afterAll(async () => {
    await holder.close?.();
  });
  return holder;
}

/** 清空所有业务数据（保留表结构），每个测试之间调用 */
export async function truncateAll(database: Database) {
  await database.db.execute(sql`TRUNCATE users, ledgers CASCADE`);
}

let seq = 0;
/** 创建一个测试用户（带默认账本和预置分类） */
export function makeUser(database: Database, name = `user${++seq}`) {
  return createUserWithDefaultLedger(database.db, {
    email: `${name}@example.com`,
    passwordHash: '$argon2id$test',
    displayName: name,
  });
}

/**
 * 取出 PostgreSQL 的原始错误（Drizzle 会包在 cause 里）。
 * 断言具体错误码 / 约束名，确保"被拒绝"的原因是我们期望的那条约束。
 */
export async function pgError(p: Promise<unknown>): Promise<{ code?: string; constraint_name?: string }> {
  try {
    await p;
  } catch (e) {
    const cause = (e as { cause?: { code?: string; constraint_name?: string } }).cause;
    if (cause) return cause;
    throw e;
  }
  throw new Error('期望数据库拒绝，但语句执行成功了');
}

/** PostgreSQL 错误码 */
export const PG = {
  checkViolation: '23514',
  foreignKeyViolation: '23503',
  uniqueViolation: '23505',
  invalidText: '22P02',
} as const;
