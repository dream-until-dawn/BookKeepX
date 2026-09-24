/** 测试公共：每个测试文件开始时重建一个干净的数据库并执行迁移 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll } from 'vitest';
import { createDb, runMigrations, type Db } from '../src/db/client.ts';
import { users } from '../src/db/schema.ts';

export function useFreshDb() {
  const ctx = {} as { db: Db; client: ReturnType<typeof createDb>['client'] };
  beforeAll(async () => {
    const { db, client } = createDb();
    await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
    await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
    await db.execute(sql`CREATE SCHEMA public`);
    await runMigrations(db);
    Object.assign(ctx, { db, client });
  });
  afterAll(async () => {
    await ctx.client?.end();
  });
  return ctx;
}

/**
 * 取出 PostgreSQL 的原始错误（Drizzle 会把它包在 cause 里）。
 * 测试断言具体的错误码 / 约束名，确保"被拒绝"是因为我们期望的那条约束，而不是别的原因。
 */
export async function pgError(p: Promise<unknown>): Promise<{ code?: string; constraint_name?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const cause = (e as { cause?: { code?: string; constraint_name?: string; message: string } }).cause;
    if (cause) return cause;
    throw e;
  }
  throw new Error('期望数据库拒绝，但语句执行成功了');
}

export async function createUser(db: Db, email: string): Promise<string> {
  const [u] = await db.insert(users).values({ email, passwordHash: 'x' }).returning({ id: users.id });
  return u!.id;
}
