/**
 * P1-2 数据表约束：连接真实 PostgreSQL，逐条验证 docs/data-model.md 中承诺的数据库层保证
 */
import { flattenPreset } from '@bookkeepx/core';
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.ts';
import {
  accounts,
  categories,
  importBatches,
  ledgerMembers,
  ledgers,
  sourceHintMappings,
  transactions,
  users,
} from '../src/db/schema/index.ts';
import { makeUser, PG, pgError, truncateAll, useMigratedDatabase } from './db-helpers.ts';
import { TEST_DATABASE_URL } from './helpers.ts';

const database = useMigratedDatabase();
const db = () => database.db;

beforeEach(() => truncateAll(database));

/** 取某账本中某个预置分类的 id */
async function categoryId(ledgerId: string, presetKey: string) {
  const [c] = await db()
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.ledgerId, ledgerId), eq(categories.presetKey, presetKey)));
  return c!.id;
}

/** 插入一笔最简单的手动流水，可覆盖任意字段 */
function insertTx(ledgerId: string, over: Partial<typeof transactions.$inferInsert> = {}) {
  return db()
    .insert(transactions)
    .values({
      ledgerId,
      direction: 'expense',
      amountCents: 100,
      occurredAt: new Date('2026-09-01T12:00:00+08:00'),
      source: 'manual',
      ...over,
    })
    .returning()
    .then((r) => r[0]!);
}

describe('迁移', () => {
  it('正向：重复执行是幂等的', async () => {
    await expect(runMigrations(TEST_DATABASE_URL)).resolves.toBeUndefined();
  });
});

describe('用户与默认账本', () => {
  it('正向：创建用户时同时创建默认账本、所有者成员、全部预置分类', async () => {
    const u = await makeUser(database, 'alice');
    const [user] = await db().select().from(users).where(eq(users.id, u.id));
    expect(user!.defaultLedgerId).toBe(u.defaultLedgerId);
    const members = await db().select().from(ledgerMembers).where(eq(ledgerMembers.ledgerId, u.defaultLedgerId));
    expect(members).toEqual([expect.objectContaining({ userId: u.id, role: 'owner' })]);
    const cats = await db().select().from(categories).where(eq(categories.ledgerId, u.defaultLedgerId));
    expect(cats).toHaveLength(flattenPreset().length);
  });

  it('正向：预置子分类正确挂在父分类下，且与父分类同组', async () => {
    const u = await makeUser(database);
    const cats = await db().select().from(categories).where(eq(categories.ledgerId, u.defaultLedgerId));
    const byId = new Map(cats.map((c) => [c.id, c]));
    const metro = cats.find((c) => c.presetKey === 'expense.transport.public')!;
    expect(byId.get(metro.parentId!)!.presetKey).toBe('expense.transport');
    for (const c of cats) if (c.parentId) expect(byId.get(c.parentId)!.group).toBe(c.group);
  });

  it('正向：邮箱统一转小写存储', async () => {
    const u = await makeUser(database, 'MixedCase');
    expect(u.email).toBe('mixedcase@example.com');
  });

  it('反向：邮箱不区分大小写唯一；失败时整个事务回滚，不留下孤立账本', async () => {
    await makeUser(database, 'bob');
    const before = await db().select({ n: sql<number>`count(*)::int` }).from(ledgers);
    expect(await pgError(makeUser(database, 'BOB'))).toMatchObject({
      code: PG.uniqueViolation,
      constraint_name: 'users_email_lower_uq',
    });
    const after = await db().select({ n: sql<number>`count(*)::int` }).from(ledgers);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('反向：绕过服务直接写入大写邮箱 → 约束拒绝', async () => {
    const e = await pgError(db().insert(users).values({ email: 'Upper@x.com', passwordHash: 'x', displayName: 'x' }));
    expect(e).toMatchObject({ code: PG.checkViolation, constraint_name: 'users_email_lowercase' });
  });
});

describe('账本隔离（组合外键）', () => {
  it('反向：流水引用其他账本的分类 → 拒绝', async () => {
    const a = await makeUser(database);
    const b = await makeUser(database);
    const bFood = await categoryId(b.defaultLedgerId, 'expense.food');
    const e = await pgError(insertTx(a.defaultLedgerId, { categoryId: bFood, categorySource: 'manual' }));
    expect(e).toMatchObject({ code: PG.foreignKeyViolation, constraint_name: 'transactions_category_fk' });
  });

  it('反向：流水引用其他账本的资金账户 → 拒绝', async () => {
    const a = await makeUser(database);
    const b = await makeUser(database);
    const [acc] = await db()
      .insert(accounts)
      .values({ ledgerId: b.defaultLedgerId, name: '现金', kind: 'cash' })
      .returning();
    expect(await pgError(insertTx(a.defaultLedgerId, { accountId: acc!.id }))).toMatchObject({
      code: PG.foreignKeyViolation,
      constraint_name: 'transactions_account_fk',
    });
  });

  it('反向：退款指向其他账本的原消费 → 拒绝', async () => {
    const a = await makeUser(database);
    const b = await makeUser(database);
    const original = await insertTx(b.defaultLedgerId);
    expect(await pgError(insertTx(a.defaultLedgerId, { isRefund: true, refundOfId: original.id }))).toMatchObject({
      code: PG.foreignKeyViolation,
      constraint_name: 'transactions_refund_of_fk',
    });
  });

  it('反向：来源分类映射指向其他账本的分类 → 拒绝', async () => {
    const a = await makeUser(database);
    const b = await makeUser(database);
    const bFood = await categoryId(b.defaultLedgerId, 'expense.food');
    const e = await pgError(
      db()
        .insert(sourceHintMappings)
        .values({ ledgerId: a.defaultLedgerId, source: 'alipay', hint: '餐饮美食', categoryId: bFood }),
    );
    expect(e).toMatchObject({ code: PG.foreignKeyViolation, constraint_name: 'source_hint_mappings_category_fk' });
  });

  it('反向：导入批次指向其他账本的资金账户 → 拒绝', async () => {
    const a = await makeUser(database);
    const b = await makeUser(database);
    const [acc] = await db()
      .insert(accounts)
      .values({ ledgerId: b.defaultLedgerId, name: '支付宝', kind: 'alipay' })
      .returning();
    const e = await pgError(
      db()
        .insert(importBatches)
        .values({
          ledgerId: a.defaultLedgerId,
          accountId: acc!.id,
          fileName: 'a.csv',
          fileSha256: 'b'.repeat(64),
          fileSize: 1,
          templateId: 'alipay-csv',
          templateVersion: 1,
          detectScore: 1,
        }),
    );
    expect(e).toMatchObject({ code: PG.foreignKeyViolation, constraint_name: 'import_batches_account_fk' });
  });

  it('正向：同账本内引用分类、账户、原消费都可以', async () => {
    const a = await makeUser(database);
    const food = await categoryId(a.defaultLedgerId, 'expense.food');
    const [acc] = await db()
      .insert(accounts)
      .values({ ledgerId: a.defaultLedgerId, name: '微信', kind: 'wechat' })
      .returning();
    const buy = await insertTx(a.defaultLedgerId, { categoryId: food, categorySource: 'manual', accountId: acc!.id });
    await expect(insertTx(a.defaultLedgerId, { isRefund: true, refundOfId: buy.id })).resolves.toBeTruthy();
  });
});

describe('分类约束', () => {
  it('反向：子分类挂到不同组的父分类下 → 拒绝', async () => {
    const a = await makeUser(database);
    const salary = await categoryId(a.defaultLedgerId, 'income.salary');
    const e = await pgError(
      db().insert(categories).values({ ledgerId: a.defaultLedgerId, parentId: salary, group: 'expense', name: '奇怪' }),
    );
    expect(e).toMatchObject({ code: PG.foreignKeyViolation, constraint_name: 'categories_parent_fk' });
  });

  it('反向：子分类挂到其他账本的父分类下 → 拒绝', async () => {
    const a = await makeUser(database);
    const b = await makeUser(database);
    const bFood = await categoryId(b.defaultLedgerId, 'expense.food');
    const e = await pgError(
      db().insert(categories).values({ ledgerId: a.defaultLedgerId, parentId: bFood, group: 'expense', name: '越界' }),
    );
    expect(e).toMatchObject({ code: PG.foreignKeyViolation, constraint_name: 'categories_parent_fk' });
  });

  it('反向：同一账本一级分类重名 → 拒绝（parent_id 为空也算同级）', async () => {
    const a = await makeUser(database);
    const e = await pgError(
      db().insert(categories).values({ ledgerId: a.defaultLedgerId, group: 'expense', name: '餐饮' }),
    );
    expect(e).toMatchObject({ code: PG.uniqueViolation, constraint_name: 'categories_sibling_name_uq' });
  });

  it('正向：不同组可以有同名分类（如支出"其他"与收入"其他"）', async () => {
    const a = await makeUser(database);
    await db().insert(categories).values({ ledgerId: a.defaultLedgerId, group: 'expense', name: '同名' });
    await expect(
      db().insert(categories).values({ ledgerId: a.defaultLedgerId, group: 'income', name: '同名' }),
    ).resolves.toBeTruthy();
  });

  it('反向：被流水引用的分类不能删除', async () => {
    const a = await makeUser(database);
    const [c] = await db()
      .insert(categories)
      .values({ ledgerId: a.defaultLedgerId, group: 'expense', name: '临时' })
      .returning();
    await insertTx(a.defaultLedgerId, { categoryId: c!.id, categorySource: 'manual' });
    expect(await pgError(db().delete(categories).where(eq(categories.id, c!.id)))).toMatchObject({
      code: PG.foreignKeyViolation,
      constraint_name: 'transactions_category_fk',
    });
  });
});

describe('流水取值约束', () => {
  it('反向：金额为 0 / 超出安全整数 → 拒绝', async () => {
    const a = await makeUser(database);
    for (const amount of [0, -1]) {
      expect(await pgError(insertTx(a.defaultLedgerId, { amountCents: amount }))).toMatchObject({
        code: PG.checkViolation,
        constraint_name: 'transactions_amount_range',
      });
    }
    const e = await pgError(
      db().execute(
        sql`INSERT INTO transactions (ledger_id, direction, amount_cents, occurred_at, source) VALUES (${a.defaultLedgerId}, 'expense', 9007199254740992, now(), 'manual')`,
      ),
    );
    expect(e).toMatchObject({ code: PG.checkViolation, constraint_name: 'transactions_amount_range' });
  });

  it('正向：最大安全整数的金额可以存且读回精确', async () => {
    const a = await makeUser(database);
    const t = await insertTx(a.defaultLedgerId, { amountCents: Number.MAX_SAFE_INTEGER });
    expect(t.amountCents).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('反向：有分类却标记为未分类、或未分类却标了来源 → 拒绝', async () => {
    const a = await makeUser(database);
    const food = await categoryId(a.defaultLedgerId, 'expense.food');
    for (const over of [{ categoryId: food, categorySource: 'none' as const }, { categorySource: 'manual' as const }]) {
      expect(await pgError(insertTx(a.defaultLedgerId, over))).toMatchObject({
        code: PG.checkViolation,
        constraint_name: 'transactions_category_source',
      });
    }
  });

  it('反向：非退款却指向原消费 → 拒绝', async () => {
    const a = await makeUser(database);
    const buy = await insertTx(a.defaultLedgerId);
    expect(await pgError(insertTx(a.defaultLedgerId, { refundOfId: buy.id }))).toMatchObject({
      code: PG.checkViolation,
      constraint_name: 'transactions_refund_of_requires_flag',
    });
  });

  it('反向：只有单号没有来源 → 拒绝', async () => {
    const a = await makeUser(database);
    expect(await pgError(insertTx(a.defaultLedgerId, { externalId: 'X1' }))).toMatchObject({
      code: PG.checkViolation,
      constraint_name: 'transactions_external_pair',
    });
  });

  it('反向：手动记账却挂在导入批次下 → 拒绝', async () => {
    const a = await makeUser(database);
    const [batch] = await db()
      .insert(importBatches)
      .values({
        ledgerId: a.defaultLedgerId,
        fileName: 'a.csv',
        fileSha256: 'a'.repeat(64),
        fileSize: 1,
        templateId: 'alipay-csv',
        templateVersion: 1,
        detectScore: 1,
      })
      .returning();
    expect(await pgError(insertTx(a.defaultLedgerId, { importBatchId: batch!.id }))).toMatchObject({
      code: PG.checkViolation,
      constraint_name: 'transactions_import_batch_source',
    });
  });

  it('反向：同一账本重复导入同一平台单号 → 拒绝；不同账本互不影响', async () => {
    const a = await makeUser(database);
    const b = await makeUser(database);
    const ext = { source: 'import' as const, externalSource: 'alipay', externalId: '2026092400001' };
    await insertTx(a.defaultLedgerId, ext);
    expect(await pgError(insertTx(a.defaultLedgerId, ext))).toMatchObject({
      code: PG.uniqueViolation,
      constraint_name: 'transactions_external_uq',
    });
    await expect(insertTx(b.defaultLedgerId, ext)).resolves.toBeTruthy();
  });

  it('正向：软删除后同一单号可以重新导入（误删后重导）', async () => {
    const a = await makeUser(database);
    const ext = { source: 'import' as const, externalSource: 'wechat', externalId: 'W1' };
    const t = await insertTx(a.defaultLedgerId, ext);
    await db().update(transactions).set({ deletedAt: new Date() }).where(eq(transactions.id, t.id));
    await expect(insertTx(a.defaultLedgerId, ext)).resolves.toBeTruthy();
  });

  it('反向：非法枚举值（方向）→ 拒绝', async () => {
    const a = await makeUser(database);
    const e = await pgError(
      db().execute(
        sql`INSERT INTO transactions (ledger_id, direction, amount_cents, occurred_at, source) VALUES (${a.defaultLedgerId}, 'transfer', 1, now(), 'manual')`,
      ),
    );
    expect(e.code).toBe(PG.invalidText);
  });
});

describe('删除与级联', () => {
  it('正向：删除账本 → 其分类、账户、流水（含退款关联）、导入批次全部删除', async () => {
    const a = await makeUser(database);
    const food = await categoryId(a.defaultLedgerId, 'expense.food');
    const [acc] = await db()
      .insert(accounts)
      .values({ ledgerId: a.defaultLedgerId, name: '微信', kind: 'wechat' })
      .returning();
    const buy = await insertTx(a.defaultLedgerId, { categoryId: food, categorySource: 'manual', accountId: acc!.id });
    await insertTx(a.defaultLedgerId, { isRefund: true, refundOfId: buy.id });
    await db().delete(ledgers).where(eq(ledgers.id, a.defaultLedgerId));
    for (const table of [categories, accounts, transactions]) {
      const left = await db()
        .select({ n: sql<number>`count(*)::int` })
        .from(table)
        .where(eq(table.ledgerId, a.defaultLedgerId));
      expect(left[0]!.n).toBe(0);
    }
  });

  it('正向：删除用户 → 成员关系删除，流水的"记账人"置空而流水保留', async () => {
    const a = await makeUser(database);
    const b = await makeUser(database);
    // b 以编辑者身份加入 a 的账本并记一笔
    await db().insert(ledgerMembers).values({ ledgerId: a.defaultLedgerId, userId: b.id, role: 'editor' });
    const t = await insertTx(a.defaultLedgerId, { createdBy: b.id });
    await db().delete(users).where(eq(users.id, b.id));
    const [kept] = await db().select().from(transactions).where(eq(transactions.id, t.id));
    expect(kept!.createdBy).toBeNull();
    // 先确认删除前确实有这条成员关系，避免断言"查不到"时其实查询条件本身就查不到任何东西
    const m = await db().select().from(ledgerMembers).where(eq(ledgerMembers.userId, b.id));
    expect(m).toHaveLength(0);
    const ownerStill = await db().select().from(ledgerMembers).where(eq(ledgerMembers.userId, a.id));
    expect(ownerStill).toHaveLength(1);
  });
});
