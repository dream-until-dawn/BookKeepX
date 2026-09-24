/**
 * P0-2 数据库链路：迁移、bigint 金额往返、约束、按北京时间切月、退款冲减、多用户隔离
 * 连接真实 PostgreSQL（docker/compose.yaml），不 mock 数据库。
 */
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations, toSafeInt } from '../src/db/client.ts';
import { transactions } from '../src/db/schema.ts';
import { expenseByCategory, monthlyStats } from '../src/stats.ts';
import { createUser, pgError, useFreshDb } from './helpers.ts';

const ctx = useFreshDb();
let alice: string;
let bob: string;

beforeEach(async () => {
  await ctx.db.execute(sql`TRUNCATE users, transactions CASCADE`);
  alice = await createUser(ctx.db, 'alice@example.com');
  bob = await createUser(ctx.db, 'bob@example.com');
});

/** 插入一笔流水，时间用带时区的 ISO 字符串，避免依赖进程时区 */
const add = (userId: string, v: Partial<typeof transactions.$inferInsert> & { at: string; cents: number }) =>
  ctx.db
    .insert(transactions)
    .values({ userId, direction: 'expense', amountCents: v.cents, occurredAt: new Date(v.at), ...v })
    .returning()
    .then((r) => r[0]!);

describe('迁移', () => {
  it('正向：重复执行迁移是幂等的（已执行的会跳过）', async () => {
    await expect(runMigrations(ctx.db)).resolves.not.toThrow();
  });
});

describe('金额 bigint 往返', () => {
  it('正向：大金额（900 亿元 = 9e12 分）写入读出一致，类型是 number', async () => {
    const r = await add(alice, { at: '2026-01-01T00:00:00+08:00', cents: 9_000_000_000_000 });
    const [back] = await ctx.db.select().from(transactions).where(eq(transactions.id, r.id));
    expect(back!.amountCents).toBe(9_000_000_000_000);
    expect(typeof back!.amountCents).toBe('number');
  });

  it('正向：JS 最大安全整数恰好能存', async () => {
    const r = await add(alice, { at: '2026-01-01T00:00:00+08:00', cents: Number.MAX_SAFE_INTEGER });
    expect(r.amountCents).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('反向：超出安全整数 → 数据库约束拒绝（防止读回时丢精度）', async () => {
    const e = await pgError(ctx.db.execute(sql`INSERT INTO transactions (user_id, direction, amount_cents, occurred_at) VALUES (${alice}, 'expense', 9007199254740992, now())`));
    expect(e).toMatchObject({ code: '23514', constraint_name: 'amount_safe_integer' }); // 23514 = check_violation
  });

  it('反向：金额为 0 或负数 → 数据库约束拒绝', async () => {
    expect(await pgError(add(alice, { at: '2026-01-01T00:00:00+08:00', cents: 0 }))).toMatchObject({ code: '23514', constraint_name: 'amount_positive' });
    expect(await pgError(add(alice, { at: '2026-01-01T00:00:00+08:00', cents: -1 }))).toMatchObject({ code: '23514', constraint_name: 'amount_positive' });
  });

  it('反向：非法方向 → 枚举拒绝', async () => {
    const e = await pgError(ctx.db.execute(sql`INSERT INTO transactions (user_id, direction, amount_cents, occurred_at) VALUES (${alice}, 'transfer', 1, now())`));
    expect(e.code).toBe('22P02'); // invalid_text_representation：枚举值非法
  });

  it('发现：手写 SQL 的 SUM 结果是字符串，必须经 toSafeInt 转换', async () => {
    await add(alice, { at: '2026-01-01T00:00:00+08:00', cents: 150 });
    const [row] = await ctx.db.execute<{ s: unknown }>(sql`SELECT SUM(amount_cents) AS s FROM transactions`);
    expect(typeof row!.s).toBe('string');
    expect(toSafeInt(row!.s)).toBe(150);
  });

  it('反向：toSafeInt 遇到超范围 / 非数字必须抛错', () => {
    expect(() => toSafeInt('9007199254740993')).toThrow(/安全范围/);
    expect(() => toSafeInt('abc')).toThrow();
  });
});

describe('退款约束', () => {
  it('反向：非退款记录不能指向原消费', async () => {
    const o = await add(alice, { at: '2026-01-01T00:00:00+08:00', cents: 100 });
    expect(await pgError(add(alice, { at: '2026-01-02T00:00:00+08:00', cents: 10, refundOfId: o.id, isRefund: false }))).toMatchObject({ code: '23514', constraint_name: 'refund_of_requires_flag' });
  });

  it('反向：退款不能指向不存在的记录（外键）', async () => {
    expect(await pgError(add(alice, { at: '2026-01-02T00:00:00+08:00', cents: 10, isRefund: true, refundOfId: '00000000-0000-0000-0000-000000000000' }))).toMatchObject({ code: '23503', constraint_name: 'transactions_refund_of_fk' }); // 23503 = foreign_key_violation
  });
});

describe('月度统计', () => {
  it('正向：按北京时间切月 —— 1 月 31 日 23:30 属于 1 月，2 月 1 日 00:30 属于 2 月', async () => {
    await add(alice, { at: '2026-01-31T23:30:00+08:00', cents: 100 }); // UTC 15:30，仍是 1 月
    await add(alice, { at: '2026-02-01T00:30:00+08:00', cents: 200 }); // UTC 1 月 31 日 16:30，但北京时间是 2 月
    expect(await monthlyStats(ctx.db, alice)).toEqual([
      { month: '2026-01', incomeCents: 0, expenseCents: 100 },
      { month: '2026-02', incomeCents: 0, expenseCents: 200 },
    ]);
  });

  it('反向：若按 UTC 切月，这两笔会被错误地归到同一个月（证明时区处理确实起作用）', async () => {
    await add(alice, { at: '2026-01-31T23:30:00+08:00', cents: 100 });
    await add(alice, { at: '2026-02-01T00:30:00+08:00', cents: 200 });
    expect(await monthlyStats(ctx.db, alice, 'UTC')).toEqual([{ month: '2026-01', incomeCents: 0, expenseCents: 300 }]);
  });

  it('正向：中性不计、跨来源重复不计、软删除不计、退款冲减支出且不计收入', async () => {
    const at = '2026-03-10T12:00:00+08:00';
    const buy = await add(alice, { at, cents: 5000, categoryKey: 'expense.food' });
    await add(alice, { at, cents: 800, isRefund: true, refundOfId: buy.id, direction: 'income' }); // 微信退款是"收入"方向
    await add(alice, { at, cents: 100000, direction: 'neutral' });
    await add(alice, { at, cents: 3000, duplicateOfId: buy.id });
    await add(alice, { at, cents: 999, deletedAt: new Date() });
    await add(alice, { at, cents: 20000, direction: 'income' });
    expect(await monthlyStats(ctx.db, alice)).toEqual([{ month: '2026-03', incomeCents: 20000, expenseCents: 4200 }]);
  });

  it('正向：分类净支出 —— 退款冲减原消费的分类；找不到原消费的冲减"其他支出"', async () => {
    const at = '2026-03-10T12:00:00+08:00';
    const buy = await add(alice, { at, cents: 5000, categoryKey: 'expense.food' });
    await add(alice, { at, cents: 800, isRefund: true, refundOfId: buy.id, direction: 'neutral', categoryKey: 'income.refund' });
    await add(alice, { at, cents: 300, isRefund: true, direction: 'neutral' });
    expect(await expenseByCategory(ctx.db, alice)).toEqual({ 'expense.food': 4200, 'expense.other': -300 });
  });

  it('正向：没有分类的支出归到"未分类"，不丢失、不混入其他分类', async () => {
    await add(alice, { at: '2026-03-10T12:00:00+08:00', cents: 700 });
    expect(await expenseByCategory(ctx.db, alice)).toEqual({ 'expense.uncategorized': 700 });
  });

  it('反向：多用户隔离 —— 只统计本人的数据', async () => {
    await add(alice, { at: '2026-04-01T12:00:00+08:00', cents: 100 });
    await add(bob, { at: '2026-04-01T12:00:00+08:00', cents: 99999 });
    expect(await monthlyStats(ctx.db, alice)).toEqual([{ month: '2026-04', incomeCents: 0, expenseCents: 100 }]);
  });
});
