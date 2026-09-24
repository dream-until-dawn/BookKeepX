/** 账本信息接口 */
import { ledgerSchema } from '@bookkeepx/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { ledgerMembers } from '../src/db/schema/index.ts';
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

describe('GET /api/ledgers/:ledgerId', () => {
  it('正向：返回默认账本信息与当前用户角色（所有者）', async () => {
    const res = await as(app, alice).get(`/api/ledgers/${alice.ledgerId}`);
    expect(ledgerSchema.parse(res.json())).toEqual({
      id: alice.ledgerId,
      name: '我的账本',
      currency: 'CNY',
      timezone: 'Asia/Shanghai',
      role: 'owner',
    });
  });

  it('正向：只读成员看到的角色是 viewer', async () => {
    const viewer = await registerUser(app, 'viewer');
    await database.db.insert(ledgerMembers).values({ ledgerId: alice.ledgerId, userId: viewer.id, role: 'viewer' });
    expect((await as(app, viewer).get(`/api/ledgers/${alice.ledgerId}`)).json().role).toBe('viewer');
  });

  it('反向：非成员 → 404；未登录 → 401', async () => {
    const bob = await registerUser(app, 'bob');
    expect((await as(app, bob).get(`/api/ledgers/${alice.ledgerId}`)).statusCode).toBe(404);
    expect((await as(app, null).get(`/api/ledgers/${alice.ledgerId}`)).statusCode).toBe(401);
  });
});
