/**
 * P1-4 资金账户接口：新增、修改、停用 / 恢复、删除规则、权限
 */
import { type Account, accountListSchema, accountSchema } from '@bookkeepx/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { importBatches, ledgerMembers, transactions } from '../src/db/schema/index.ts';
import { as, registerUser, type TestUser } from './api-helpers.ts';
import { truncateAll, useMigratedDatabase } from './db-helpers.ts';

const database = useMigratedDatabase();
let app: ReturnType<typeof buildApp>;
let alice: TestUser;

beforeEach(async () => {
  await truncateAll(database);
  app = buildApp({ database });
  alice = await registerUser(app, 'alice');
});

const url = (u: TestUser, suffix = '') => `/api/ledgers/${u.ledgerId}/accounts${suffix}`;
const create = async (u: TestUser, body: object) => (await as(app, u).post(url(u), body)).json() as Account;

describe('新增与查询', () => {
  it('正向：新增储蓄卡（含机构与卡号后四位），列表中可见', async () => {
    const res = await as(app, alice).post(url(alice), {
      name: '招行储蓄卡',
      kind: 'bank_debit',
      institution: '招商银行',
      cardLast4: '1032',
    });
    expect(res.statusCode).toBe(201);
    expect(accountSchema.parse(res.json())).toMatchObject({ cardLast4: '1032', archived: false, transactionCount: 0 });
    expect(accountListSchema.parse((await as(app, alice).get(url(alice))).json())).toHaveLength(1);
  });

  it('反向：同名账户 → 409 ACCOUNT_NAME_TAKEN；不同账本可以同名', async () => {
    await create(alice, { name: '微信', kind: 'wechat' });
    expect((await as(app, alice).post(url(alice), { name: '微信', kind: 'wechat' })).json().code).toBe(
      'ACCOUNT_NAME_TAKEN',
    );
    const bob = await registerUser(app, 'bob');
    expect((await as(app, bob).post(url(bob), { name: '微信', kind: 'wechat' })).statusCode).toBe(201);
  });

  it('反向：卡号后四位不合法 → 400', async () => {
    const res = await as(app, alice).post(url(alice), { name: '卡', kind: 'bank_debit', cardLast4: '12' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('卡号后四位必须是 4 位数字');
  });
});

describe('修改、停用与恢复', () => {
  it('正向：停用后仍在列表中（标记 archived），可以恢复；停用的排在后面', async () => {
    const a = await create(alice, { name: '旧卡', kind: 'bank_debit' });
    await create(alice, { name: '现金', kind: 'cash' });
    expect((await as(app, alice).patch(url(alice, `/${a.id}`), { archived: true })).json().archived).toBe(true);
    const listed = accountListSchema.parse((await as(app, alice).get(url(alice))).json());
    expect(listed.map((x) => x.name)).toEqual(['现金', '旧卡']);
    expect((await as(app, alice).patch(url(alice, `/${a.id}`), { archived: false })).json().archived).toBe(false);
  });

  it('正向：改名、改类型、清空卡号', async () => {
    const a = await create(alice, { name: '卡', kind: 'bank_debit', cardLast4: '1234' });
    const res = await as(app, alice).patch(url(alice, `/${a.id}`), {
      name: '信用卡',
      kind: 'credit_card',
      cardLast4: '',
    });
    expect(res.json()).toMatchObject({ name: '信用卡', kind: 'credit_card', cardLast4: null });
  });

  it('反向：改成已有的名字 → 409', async () => {
    await create(alice, { name: '微信', kind: 'wechat' });
    const b = await create(alice, { name: '支付宝', kind: 'alipay' });
    expect((await as(app, alice).patch(url(alice, `/${b.id}`), { name: '微信' })).statusCode).toBe(409);
  });
});

describe('删除', () => {
  it('正向：未使用的账户可以删除', async () => {
    const a = await create(alice, { name: '现金', kind: 'cash' });
    expect((await as(app, alice).del(url(alice, `/${a.id}`))).statusCode).toBe(204);
    expect((await as(app, alice).get(url(alice))).json()).toHaveLength(0);
  });

  it('反向：被流水使用 → 409 ACCOUNT_IN_USE，并提示可以停用', async () => {
    const a = await create(alice, { name: '微信', kind: 'wechat' });
    await database.db.insert(transactions).values({
      ledgerId: alice.ledgerId,
      accountId: a.id,
      direction: 'expense',
      amountCents: 100,
      occurredAt: new Date(),
      source: 'manual',
    });
    const res = await as(app, alice).del(url(alice, `/${a.id}`));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'ACCOUNT_IN_USE' });
    expect(res.json().error).toContain('停用');
  });

  it('反向：只被导入批次使用（还没有流水）也不能删除', async () => {
    const a = await create(alice, { name: '支付宝', kind: 'alipay' });
    await database.db.insert(importBatches).values({
      ledgerId: alice.ledgerId,
      accountId: a.id,
      fileName: 'a.csv',
      fileSha256: 'c'.repeat(64),
      fileSize: 1,
      templateId: 'alipay-csv',
      templateVersion: 1,
      detectScore: 1,
    });
    expect((await as(app, alice).del(url(alice, `/${a.id}`))).json().code).toBe('ACCOUNT_IN_USE');
  });
});

describe('权限', () => {
  it('反向：非成员 → 404；他人账户 id → 404 且数据不被修改', async () => {
    const bob = await registerUser(app, 'bob');
    const bobAcc = await create(bob, { name: '微信', kind: 'wechat' });
    expect((await as(app, alice).get(url(bob))).statusCode).toBe(404);
    expect((await as(app, alice).patch(url(alice, `/${bobAcc.id}`), { name: '篡改' })).statusCode).toBe(404);
    expect((await as(app, alice).del(url(alice, `/${bobAcc.id}`))).statusCode).toBe(404);
    expect((await as(app, bob).get(url(bob))).json()[0].name).toBe('微信');
  });

  it('反向：只读成员不能新增 → 403', async () => {
    const viewer = await registerUser(app, 'viewer');
    await database.db.insert(ledgerMembers).values({ ledgerId: alice.ledgerId, userId: viewer.id, role: 'viewer' });
    expect((await as(app, viewer).post(url(alice), { name: 'x', kind: 'cash' })).statusCode).toBe(403);
  });
});
