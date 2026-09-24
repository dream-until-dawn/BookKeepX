/** P0-4（服务端侧）：Fastify 路由 → 共享 core 包 → 数据库 全链路 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createUser, useFreshDb } from './helpers.ts';

const ctx = useFreshDb();
let userId: string;

beforeEach(async () => {
  await ctx.db.execute(sql`TRUNCATE users, transactions CASCADE`);
  userId = await createUser(ctx.db, 'api@example.com');
});

const post = (body: Record<string, unknown>) => buildApp(ctx.db).inject({ method: 'POST', url: '/transactions', payload: { userId, direction: 'expense', occurredAt: '2026-05-01T12:00:00+08:00', ...body } });

describe('POST /transactions', () => {
  it('正向：金额字符串经 core 转成分入库，返回按 core 格式化的金额', async () => {
    const res = await post({ amount: '1,234.5' });
    expect(res.statusCode).toBe(201);
    expect(res.json().amount).toBe('1,234.50');
  });

  it('反向：三位小数 → 400，错误信息来自 core', async () => {
    const res = await post({ amount: '1.234' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/金额格式非法/);
  });

  it('反向：金额为 0 → 400', async () => {
    expect((await post({ amount: '0' })).statusCode).toBe(400);
  });
});

describe('GET /stats/monthly', () => {
  it('正向：记两笔后月度统计正确', async () => {
    await post({ amount: '10.00' });
    await post({ amount: '0.50' });
    const res = await buildApp(ctx.db).inject({ method: 'GET', url: `/stats/monthly?userId=${userId}` });
    expect(res.json()).toEqual([{ month: '2026-05', income: '0.00', expense: '10.50' }]);
  });
});
