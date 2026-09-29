/** 真实 PostgreSQL 统计测试：不以接口自身的聚合函数计算期望值。 */
import { categoryListSchema, statsResponseSchema } from '@bookkeepx/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { categories, ledgerMembers, ledgers, transactions } from '../src/db/schema/index.ts';
import { as, registerUser, type TestUser } from './api-helpers.ts';
import { truncateAll, useMigratedDatabase } from './db-helpers.ts';

const database = useMigratedDatabase();
let app: ReturnType<typeof buildApp>, alice: TestUser;
let food: string, meal: string, other: string;
const url = (month = '2026-02') => `/api/ledgers/${alice.ledgerId}/stats?month=${month}`;
async function row(patch: Partial<typeof transactions.$inferInsert> = {}) {
  const [r] = await database.db
    .insert(transactions)
    .values({
      ledgerId: alice.ledgerId,
      source: 'manual',
      direction: 'expense',
      amountCents: 1000,
      occurredAt: new Date('2026-02-10T04:00:00Z'),
      ...patch,
    })
    .returning();
  return r!;
}
async function stats(month = '2026-02') {
  const result = await as(app, alice).get(url(month));
  expect(result.statusCode, result.body).toBe(200);
  return statsResponseSchema.parse(result.json());
}
beforeEach(async () => {
  await truncateAll(database);
  app = buildApp({ database });
  alice = await registerUser(app);
  const cats = categoryListSchema.parse((await as(app, alice).get(`/api/ledgers/${alice.ledgerId}/categories`)).json());
  food = cats.find((c) => c.presetKey === 'expense.food')!.id;
  meal = cats.find((c) => c.presetKey === 'expense.food.meal')!.id;
  other = cats.find((c) => c.presetKey === 'expense.other')!.id;
});
afterEach(async () => app.close());

describe('收支口径与分类', () => {
  it('普通中性、重复、删除不计；退款不计收入，月/日/分类合计一致', async () => {
    const original = await row({ categoryId: meal, categorySource: 'manual', amountCents: 10000 });
    await row({ direction: 'income', amountCents: 30000 });
    await row({ isRefund: true, direction: 'income', refundOfId: original.id, amountCents: 2500 });
    await row({ isRefund: true, direction: 'neutral', amountCents: 300 });
    await row({ direction: 'neutral', amountCents: 80000 });
    await row({ duplicateOfId: original.id, amountCents: 10000 });
    await row({ deletedAt: new Date(), amountCents: 90000 });
    const s = await stats();
    expect(s.summary).toEqual({
      incomeCents: 30000,
      grossExpenseCents: 10000,
      refundCents: 2800,
      expenseCents: 7200,
      balanceCents: 22800,
      transactionCount: 4,
    });
    expect(s.categories.find((c) => c.categoryId === food)).toMatchObject({ expenseCents: 7500, refundCents: 2500 });
    expect(s.categories.find((c) => c.categoryId === other)).toMatchObject({ expenseCents: -300 });
    for (const key of [
      'incomeCents',
      'grossExpenseCents',
      'refundCents',
      'expenseCents',
      'balanceCents',
      'transactionCount',
    ] as const) {
      expect(s.daily.reduce((sum, d) => sum + d[key], 0)).toBe(s.summary[key]);
      expect(s.categories.reduce((sum, c) => sum + c[key], 0)).toBe(s.summary[key]);
      expect(s.monthly[11]?.[key]).toBe(s.summary[key]);
    }
    const list = (await as(app, alice).get(`/api/ledgers/${alice.ledgerId}/transactions?month=2026-02`)).json();
    expect(list.summary).toEqual({ incomeCents: s.summary.incomeCents, expenseCents: s.summary.expenseCents });
  });
  it('跨月退款跟随原消费当前分类，软删除原消费不丢分类；隐藏分类仍统计', async () => {
    const original = await row({
      occurredAt: new Date('2026-01-02T00:00:00Z'),
      categoryId: meal,
      categorySource: 'manual',
      deletedAt: new Date(),
    });
    await row({
      isRefund: true,
      refundOfId: original.id,
      direction: 'income',
      categoryId: other,
      categorySource: 'system_rule',
      amountCents: 700,
    });
    await database.db.update(categories).set({ hidden: true }).where(eq(categories.id, food));
    const s = await stats();
    expect(s.summary).toMatchObject({ incomeCents: 0, expenseCents: -700, balanceCents: 700 });
    expect(s.categories).toHaveLength(1);
    expect(s.categories[0]).toMatchObject({ categoryId: food, expenseCents: -700 });
    await database.db.update(transactions).set({ categoryId: other }).where(eq(transactions.id, original.id));
    expect((await stats()).categories[0]?.categoryId).toBe(other);
  });
  it('未分类收入/支出分开，原消费未分类的退款归其他支出', async () => {
    const original = await row();
    await row({ direction: 'income', amountCents: 1500 });
    await row({ isRefund: true, refundOfId: original.id, direction: 'income', amountCents: 200 });
    const s = await stats();
    expect(
      s.categories
        .filter((c) => c.categoryId === null)
        .map((c) => c.group)
        .sort(),
    ).toEqual(['expense', 'income']);
    expect(s.categories.find((c) => c.categoryId === other)?.expenseCents).toBe(-200);
  });
  it('贷款与信用卡还款的普通支出正常计入', async () => {
    const cats = categoryListSchema.parse(
      (await as(app, alice).get(`/api/ledgers/${alice.ledgerId}/categories`)).json(),
    );
    const repay = cats.find((c) => c.presetKey === 'expense.repay')!;
    await row({ categoryId: repay.id, categorySource: 'manual', amountCents: 200000 });
    expect((await stats()).categories[0]).toMatchObject({ categoryId: repay.id, expenseCents: 200000 });
  });
  it('重复和删除的退款同样不冲减支出', async () => {
    const r = await row();
    await row({ direction: 'income', isRefund: true, duplicateOfId: r.id, amountCents: 800 });
    await row({ direction: 'income', isRefund: true, deletedAt: new Date(), amountCents: 900 });
    expect((await stats()).summary).toMatchObject({ expenseCents: 1000, refundCents: 0, transactionCount: 1 });
  });
});
describe('时区、日期与补零', () => {
  it('北京时间上下月半开边界精确到毫秒', async () => {
    await row({ occurredAt: new Date('2026-01-31T15:59:59.999Z'), amountCents: 1 });
    await row({ occurredAt: new Date('2026-01-31T16:00:00Z'), amountCents: 2 });
    await row({ occurredAt: new Date('2026-02-28T15:59:59.999Z'), amountCents: 4 });
    await row({ occurredAt: new Date('2026-02-28T16:00:00Z'), amountCents: 8 });
    const s = await stats();
    expect(s.summary.expenseCents).toBe(6);
    expect(s.daily[0]?.expenseCents).toBe(2);
    expect(s.daily[27]?.expenseCents).toBe(4);
    expect((await stats('2026-01')).summary.expenseCents).toBe(1);
    expect((await stats('2026-03')).summary.expenseCents).toBe(8);
  });
  it('夏令时时区按本地日期归日，不使用固定 UTC 偏移', async () => {
    await database.db.update(ledgers).set({ timezone: 'America/New_York' }).where(eq(ledgers.id, alice.ledgerId));
    await row({ occurredAt: new Date('2026-03-09T03:59:59Z'), amountCents: 3 });
    await row({ occurredAt: new Date('2026-03-09T04:00:00Z'), amountCents: 7 });
    const s = await stats('2026-03');
    expect(s.daily[7]?.expenseCents).toBe(3);
    expect(s.daily[8]?.expenseCents).toBe(7);
    expect(s.timezone).toBe('America/New_York');
  });
  it('闰年空月补 29 天，12 个月跨年有序；无数据是零', async () => {
    const s = await stats('2024-02');
    expect(s.daily).toHaveLength(29);
    expect(s.daily[28]?.date).toBe('2024-02-29');
    expect(s.monthly).toHaveLength(12);
    expect(s.monthly[0]?.month).toBe('2023-03');
    expect(s.monthly[11]?.month).toBe('2024-02');
    expect(s.summary.expenseCents).toBe(0);
    expect(s.categories).toEqual([]);
    expect(s.daily.every((d) => d.transactionCount === 0)).toBe(true);
  });
  it('月份范围两端合法，趋势左边界之外不计入', async () => {
    expect((await stats('1901-01')).monthly[0]?.month).toBe('1900-02');
    expect((await stats('9998-12')).daily).toHaveLength(31);
    await row({ occurredAt: new Date('2025-02-28T15:59:59Z'), amountCents: 11 });
    await row({ occurredAt: new Date('2025-02-28T16:00:00Z'), amountCents: 13 });
    expect((await stats()).monthly[0]?.expenseCents).toBe(13);
  });
});
describe('权限、输入与精度', () => {
  it.each([
    '',
    '2026-00',
    '2026-13',
    '2026-2',
    '0000-01',
    '1900-12',
    '9999-01',
    '2026-02&timezone=UTC',
    '2026-02&month=2026-03',
  ])('非法月份或参数 %s 返回400', async (month) => {
    expect((await as(app, alice).get(url(month))).statusCode).toBe(400);
  });
  it('未登录401、非成员404、viewer可读；其他账本数据不混入', async () => {
    const bob = await registerUser(app);
    await row({ ledgerId: bob.ledgerId, amountCents: 99999 });
    await row({ amountCents: 123 });
    expect((await as(app, null).get(url())).statusCode).toBe(401);
    expect((await as(app, bob).get(url())).statusCode).toBe(404);
    await database.db.insert(ledgerMembers).values({ ledgerId: alice.ledgerId, userId: bob.id, role: 'viewer' });
    const result = await as(app, bob).get(url());
    expect(result.statusCode).toBe(200);
    expect(result.json().summary.expenseCents).toBe(123);
  });
  it('单笔安全整数上限仍精确，聚合超限明确422', async () => {
    await row({ amountCents: Number.MAX_SAFE_INTEGER });
    expect((await stats()).summary.expenseCents).toBe(Number.MAX_SAFE_INTEGER);
    await row({ amountCents: 1 });
    const res = await as(app, alice).get(url());
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('STATS_AMOUNT_OVERFLOW');
  });
  it('收入与负净支出各自合法，但结余超限也拒绝', async () => {
    await row({ direction: 'income', amountCents: Number.MAX_SAFE_INTEGER });
    await row({ direction: 'income', isRefund: true, amountCents: 1 });
    expect((await as(app, alice).get(url())).json().code).toBe('STATS_AMOUNT_OVERFLOW');
  });
});
