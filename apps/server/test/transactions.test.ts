/**
 * P1-5 流水接口：记账、查询（筛选 / 分页 / 合计 / 时区）、修改规则、删除与恢复、权限
 */
import { type Category, type Transaction, transactionListSchema, transactionSchema } from '@bookkeepx/contracts';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { categories, ledgerMembers, transactions } from '../src/db/schema/index.ts';
import { as, registerUser, type TestUser } from './api-helpers.ts';
import { truncateAll, useMigratedDatabase } from './db-helpers.ts';

const database = useMigratedDatabase();
let app: ReturnType<typeof buildApp>;
let alice: TestUser;
let cats: Category[];

beforeEach(async () => {
  await truncateAll(database);
  app = buildApp({ database });
  alice = await registerUser(app, 'alice');
  cats = (await as(app, alice).get(`/api/ledgers/${alice.ledgerId}/categories`)).json();
});

const url = (u: TestUser, suffix = '') => `/api/ledgers/${u.ledgerId}/transactions${suffix}`;
const cat = (key: string) => cats.find((c) => c.presetKey === key)!.id;

async function add(body: Record<string, unknown>, user = alice) {
  const res = await as(app, user).post(url(user), {
    direction: 'expense',
    amount: '10',
    occurredAt: '2026-09-10T12:00:00+08:00',
    ...body,
  });
  if (res.statusCode !== 201) throw new Error(`记账失败：${res.statusCode} ${res.body}`);
  return transactionSchema.parse(res.json());
}

async function list(query = '', user = alice) {
  const res = await as(app, user).get(url(user, query ? `?${query}` : ''));
  if (res.statusCode !== 200) throw new Error(`查询失败：${res.statusCode} ${res.body}`);
  return transactionListSchema.parse(res.json());
}

/** 直接写库插入一条"导入的"流水（导入功能在 P1-6，这里只为验证修改规则） */
async function insertImported(over: Partial<typeof transactions.$inferInsert> = {}) {
  const [row] = await database.db
    .insert(transactions)
    .values({
      ledgerId: alice.ledgerId,
      direction: 'expense',
      amountCents: 2178,
      occurredAt: new Date('2026-09-10T11:07:04+08:00'),
      source: 'import',
      externalSource: 'alipay',
      externalId: '2026092422001',
      counterparty: '淘宝闪购',
      ...over,
    })
    .returning();
  return row!;
}

describe('记一笔', () => {
  it('正向：带分类与账户记一笔支出 → 201，金额为分，分类来源为手动，记账人为当前用户', async () => {
    const acc = (
      await as(app, alice).post(`/api/ledgers/${alice.ledgerId}/accounts`, { name: '微信', kind: 'wechat' })
    ).json();
    const t = await add({
      amount: '¥32.5',
      categoryId: cat('expense.food.meal'),
      accountId: acc.id,
      counterparty: ' 麦当劳 ',
    });
    expect(t).toMatchObject({
      amountCents: 3250,
      direction: 'expense',
      categorySource: 'manual',
      source: 'manual',
      createdBy: alice.id,
      counterparty: '麦当劳',
      accountId: acc.id,
    });
    expect(t.occurredAt).toBe('2026-09-10T04:00:00.000Z');
  });

  it('正向：不选分类 → 未分类（categorySource = none）', async () => {
    expect((await add({})).categorySource).toBe('none');
  });

  it.each([
    [{ amount: '0' }, 400],
    [{ amount: '1.234' }, 400],
    [{ occurredAt: '2026-09-10T12:00:00' }, 400],
  ])('反向：%j → %i', async (body, status) => {
    const res = await as(app, alice).post(url(alice), {
      direction: 'expense',
      amount: '10',
      occurredAt: '2026-09-10T12:00:00+08:00',
      ...body,
    });
    expect(res.statusCode).toBe(status);
  });

  it('反向：支出选了收入分类 → 400 CATEGORY_DIRECTION_MISMATCH', async () => {
    const res = await as(app, alice).post(url(alice), {
      direction: 'expense',
      amount: '10',
      occurredAt: '2026-09-10T12:00:00+08:00',
      categoryId: cat('income.salary'),
    });
    expect(res.json().code).toBe('CATEGORY_DIRECTION_MISMATCH');
  });

  it('反向：选了已隐藏的分类 / 已停用的账户 → 400', async () => {
    const food = cat('expense.food');
    await as(app, alice).patch(`/api/ledgers/${alice.ledgerId}/categories/${food}`, { hidden: true });
    const acc = (
      await as(app, alice).post(`/api/ledgers/${alice.ledgerId}/accounts`, { name: '旧卡', kind: 'cash' })
    ).json();
    await as(app, alice).patch(`/api/ledgers/${alice.ledgerId}/accounts/${acc.id}`, { archived: true });
    const base = { direction: 'expense', amount: '10', occurredAt: '2026-09-10T12:00:00+08:00' };
    expect((await as(app, alice).post(url(alice), { ...base, categoryId: food })).json().code).toBe('CATEGORY_HIDDEN');
    expect((await as(app, alice).post(url(alice), { ...base, accountId: acc.id })).json().code).toBe(
      'ACCOUNT_ARCHIVED',
    );
  });

  it('反向：使用其他账本的分类 → 404，且没有写入任何流水', async () => {
    const bob = await registerUser(app, 'bob');
    const bobCats: Category[] = (await as(app, bob).get(`/api/ledgers/${bob.ledgerId}/categories`)).json();
    const res = await as(app, alice).post(url(alice), {
      direction: 'expense',
      amount: '10',
      occurredAt: '2026-09-10T12:00:00+08:00',
      categoryId: bobCats.find((c) => c.presetKey === 'expense.food')!.id,
    });
    expect(res.statusCode).toBe(404);
    expect((await list()).total).toBe(0);
  });
});

describe('查询：时区与日期筛选', () => {
  it('正向：按北京时间切月——1 月 31 日 23:30 属于 1 月，2 月 1 日 00:30 属于 2 月', async () => {
    await add({ occurredAt: '2026-01-31T23:30:00+08:00', note: '一月底' });
    await add({ occurredAt: '2026-02-01T00:30:00+08:00', note: '二月初' });
    expect((await list('month=2026-01')).items.map((t) => t.note)).toEqual(['一月底']);
    expect((await list('month=2026-02')).items.map((t) => t.note)).toEqual(['二月初']);
  });

  it('正向：from / to 包含首尾两天（按北京时间）', async () => {
    await add({ occurredAt: '2026-09-01T00:00:00+08:00', note: '首日零点' });
    await add({ occurredAt: '2026-09-03T23:59:59+08:00', note: '末日最后一秒' });
    await add({ occurredAt: '2026-09-04T00:00:00+08:00', note: '次日零点' });
    await add({ occurredAt: '2026-08-31T23:59:59+08:00', note: '前一日' });
    const notes = (await list('from=2026-09-01&to=2026-09-03')).items.map((t) => t.note).sort();
    expect(notes).toEqual(['末日最后一秒', '首日零点']);
  });

  it('反向：非法查询参数 → 400', async () => {
    for (const q of ['month=2026-13', 'month=2026-09&from=2026-09-01', 'pageSize=500', 'foo=1']) {
      expect((await as(app, alice).get(url(alice, `?${q}`))).statusCode).toBe(400);
    }
  });
});

describe('查询：筛选、搜索、分页', () => {
  it('正向：选一级分类时包含其子分类', async () => {
    await add({ categoryId: cat('expense.food'), note: '一级' });
    await add({ categoryId: cat('expense.food.meal'), note: '子分类' });
    await add({ categoryId: cat('expense.transport'), note: '其他' });
    const notes = (await list(`categoryId=${cat('expense.food')}`)).items.map((t) => t.note).sort();
    expect(notes).toEqual(['一级', '子分类']);
    expect((await list(`categoryId=${cat('expense.food.meal')}`)).items.map((t) => t.note)).toEqual(['子分类']);
  });

  it('正向：按方向、账户筛选', async () => {
    const acc = (
      await as(app, alice).post(`/api/ledgers/${alice.ledgerId}/accounts`, { name: '现金', kind: 'cash' })
    ).json();
    await add({ direction: 'income', amount: '100' });
    await add({ accountId: acc.id });
    await add({});
    expect((await list('direction=income')).total).toBe(1);
    expect((await list(`accountId=${acc.id}`)).total).toBe(1);
  });

  it('正向：搜索对方、说明、备注；% 和 _ 按字面匹配', async () => {
    await add({ counterparty: '厦门地铁' });
    await add({ note: '打折 100% 返现' });
    await add({ note: '1000 返现' });
    expect((await list(`q=${encodeURIComponent('地铁')}`)).total).toBe(1);
    expect((await list(`q=${encodeURIComponent('100%')}`)).items.map((t) => t.note)).toEqual(['打折 100% 返现']);
    expect((await list(`q=${encodeURIComponent('_')}`)).total).toBe(0);
  });

  it('正向：分页与排序（发生时间倒序）', async () => {
    for (let d = 1; d <= 5; d++) await add({ occurredAt: `2026-09-0${d}T12:00:00+08:00`, note: `第${d}天` });
    const p1 = await list('pageSize=2&page=1');
    const p3 = await list('pageSize=2&page=3');
    expect(p1.total).toBe(5);
    expect(p1.items.map((t) => t.note)).toEqual(['第5天', '第4天']);
    expect(p3.items.map((t) => t.note)).toEqual(['第1天']);
  });

  it('反向：看不到其他账本的流水', async () => {
    const bob = await registerUser(app, 'bob');
    await add({ note: 'bob 的' }, bob);
    expect((await list()).total).toBe(0);
  });
});

describe('查询：合计口径', () => {
  it('正向：收入不含退款；支出 = 支出 − 退款；中性、跨来源重复、已删除都不计', async () => {
    await add({ direction: 'income', amount: '1000' });
    const buy = await add({ amount: '50' });
    await add({ direction: 'neutral', amount: '5000' });
    const deleted = await add({ amount: '999' });
    await as(app, alice).del(url(alice, `/${deleted.id}`));
    await database.db.insert(transactions).values([
      // 微信退款记为"收入"方向，但应冲减支出、不计入收入
      {
        ledgerId: alice.ledgerId,
        direction: 'income',
        amountCents: 800,
        occurredAt: new Date(),
        source: 'import',
        isRefund: true,
        refundOfId: buy.id,
      },
      // 跨来源重复的银行记录（支出方向与收入方向各一条，都不应计入）
      {
        ledgerId: alice.ledgerId,
        direction: 'expense',
        amountCents: 5000,
        occurredAt: new Date(),
        source: 'import',
        duplicateOfId: buy.id,
      },
      {
        ledgerId: alice.ledgerId,
        direction: 'income',
        amountCents: 7777,
        occurredAt: new Date(),
        source: 'import',
        duplicateOfId: buy.id,
      },
    ]);
    const s = (await list()).summary;
    expect(s).toEqual({ incomeCents: 100000, expenseCents: 5000 - 800 });
  });
});

describe('修改', () => {
  it('正向：修改金额、时间、方向（同时换成匹配的分类）', async () => {
    const t = await add({ categoryId: cat('expense.food') });
    const res = await as(app, alice).patch(url(alice, `/${t.id}`), {
      amount: '88.8',
      occurredAt: '2026-09-11T09:00:00+08:00',
      direction: 'income',
      categoryId: cat('income.other'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      amountCents: 8880,
      direction: 'income',
      categoryId: cat('income.other'),
      categorySource: 'manual',
    });
  });

  it('正向：把分类清空 → 未分类', async () => {
    const t = await add({ categoryId: cat('expense.food') });
    expect((await as(app, alice).patch(url(alice, `/${t.id}`), { categoryId: null })).json()).toMatchObject({
      categoryId: null,
      categorySource: 'none',
    });
  });

  it('反向：只改方向、不换分类，导致分类与方向不一致 → 400', async () => {
    const t = await add({ categoryId: cat('expense.food') });
    expect((await as(app, alice).patch(url(alice, `/${t.id}`), { direction: 'income' })).json().code).toBe(
      'CATEGORY_DIRECTION_MISMATCH',
    );
  });

  it('正向 + 反向：原本在用的隐藏分类可以保留（改备注不受影响），但不能新选隐藏分类', async () => {
    const t = await add({ categoryId: cat('expense.food') });
    const other = await add({ categoryId: cat('expense.transport') });
    await as(app, alice).patch(`/api/ledgers/${alice.ledgerId}/categories/${cat('expense.food')}`, { hidden: true });
    expect((await as(app, alice).patch(url(alice, `/${t.id}`), { note: '只改备注' })).statusCode).toBe(200);
    expect(
      (await as(app, alice).patch(url(alice, `/${other.id}`), { categoryId: cat('expense.food') })).json().code,
    ).toBe('CATEGORY_HIDDEN');
  });

  it('正向：导入的流水可以改分类、账户、备注；改分类后来源变为手动，规则 id 清空', async () => {
    const imported = await insertImported({ categoryId: cat('expense.food'), categorySource: 'source_hint' });
    const res = await as(app, alice).patch(url(alice, `/${imported.id}`), {
      categoryId: cat('expense.food.delivery'),
      note: '外卖',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ categorySource: 'manual', note: '外卖', amountCents: 2178 });
  });

  it('反向：导入的流水不能改金额、时间、方向、对方 → 400 IMPORTED_FIELD_READONLY', async () => {
    const imported = await insertImported();
    for (const patch of [
      { amount: '1' },
      { occurredAt: '2026-09-01T00:00:00+08:00' },
      { direction: 'income' },
      { counterparty: '改掉' },
    ]) {
      const res = await as(app, alice).patch(url(alice, `/${imported.id}`), patch);
      expect(res.json().code).toBe('IMPORTED_FIELD_READONLY');
    }
    const [row] = await database.db.select().from(transactions).where(eq(transactions.id, imported.id));
    expect(row!.amountCents).toBe(2178);
  });

  it('反向：修改已删除的流水 → 404', async () => {
    const t = await add({});
    await as(app, alice).del(url(alice, `/${t.id}`));
    expect((await as(app, alice).patch(url(alice, `/${t.id}`), { note: 'x' })).statusCode).toBe(404);
  });
});

describe('删除与恢复', () => {
  it('正向：删除后从列表消失、出现在回收站；恢复后回到列表', async () => {
    const t: Transaction = await add({ note: '误删' });
    expect((await as(app, alice).del(url(alice, `/${t.id}`))).statusCode).toBe(204);
    expect((await list()).total).toBe(0);
    expect((await list('deleted=true')).items.map((x) => x.note)).toEqual(['误删']);
    const restored = await as(app, alice).post(url(alice, `/${t.id}/restore`), {});
    expect(restored.json().deletedAt).toBeNull();
    expect((await list()).total).toBe(1);
  });

  it('反向：重复删除 → 404；恢复未删除的流水 → 404', async () => {
    const t = await add({});
    await as(app, alice).del(url(alice, `/${t.id}`));
    expect((await as(app, alice).del(url(alice, `/${t.id}`))).statusCode).toBe(404);
    await as(app, alice).post(url(alice, `/${t.id}/restore`), {});
    expect((await as(app, alice).post(url(alice, `/${t.id}/restore`), {})).statusCode).toBe(404);
  });

  it('反向：删除后同一平台单号已被重新导入 → 恢复被拒绝 409', async () => {
    const first = await insertImported();
    await as(app, alice).del(url(alice, `/${first.id}`));
    await insertImported();
    const res = await as(app, alice).post(url(alice, `/${first.id}/restore`), {});
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('TRANSACTION_DUPLICATE');
  });
});

describe('权限', () => {
  it('反向：只读成员可以查询，不能记账、修改、删除', async () => {
    const t = await add({});
    const viewer = await registerUser(app, 'viewer');
    await database.db.insert(ledgerMembers).values({ ledgerId: alice.ledgerId, userId: viewer.id, role: 'viewer' });
    expect((await as(app, viewer).get(url(alice))).statusCode).toBe(200);
    expect(
      (
        await as(app, viewer).post(url(alice), {
          direction: 'expense',
          amount: '1',
          occurredAt: '2026-09-10T12:00:00+08:00',
        })
      ).statusCode,
    ).toBe(403);
    expect((await as(app, viewer).patch(url(alice, `/${t.id}`), { note: 'x' })).statusCode).toBe(403);
    expect((await as(app, viewer).del(url(alice, `/${t.id}`))).statusCode).toBe(403);
  });

  it('反向：在自己账本的路径下操作他人流水 → 404，数据不变', async () => {
    const bob = await registerUser(app, 'bob');
    const bobTx = await add({ note: 'bob' }, bob);
    expect((await as(app, alice).get(url(alice, `/${bobTx.id}`))).statusCode).toBe(404);
    expect((await as(app, alice).patch(url(alice, `/${bobTx.id}`), { note: '篡改' })).statusCode).toBe(404);
    expect((await as(app, alice).del(url(alice, `/${bobTx.id}`))).statusCode).toBe(404);
    const [row] = await database.db.select().from(transactions).where(eq(transactions.id, bobTx.id));
    expect(row).toMatchObject({ note: 'bob', deletedAt: null });
  });

  it('反向：删除分类后仍被流水引用的情况不会发生（被使用的分类不能删）', async () => {
    const [c] = await database.db
      .insert(categories)
      .values({ ledgerId: alice.ledgerId, group: 'expense', name: '临时' })
      .returning();
    await add({ categoryId: c!.id });
    expect((await as(app, alice).del(`/api/ledgers/${alice.ledgerId}/categories/${c!.id}`)).json().code).toBe(
      'CATEGORY_IN_USE',
    );
  });
});
