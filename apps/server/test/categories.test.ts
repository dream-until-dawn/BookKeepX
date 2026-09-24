/**
 * P1-4 分类接口：列表、新增、修改、隐藏、删除规则、权限
 */
import { type Category, categoryListSchema, categorySchema } from '@bookkeepx/contracts';
import { flattenPreset } from '@bookkeepx/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { ledgerMembers, transactions } from '../src/db/schema/index.ts';
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

const url = (u: TestUser, suffix = '') => `/api/ledgers/${u.ledgerId}/categories${suffix}`;
const list = async (u: TestUser) => categoryListSchema.parse((await as(app, u).get(url(u))).json());
const byPreset = async (u: TestUser, key: string) => (await list(u)).find((c) => c.presetKey === key)!;

/** 在账本里插入一笔引用该分类的流水 */
async function useCategory(u: TestUser, categoryId: string, deleted = false) {
  await database.db.insert(transactions).values({
    ledgerId: u.ledgerId,
    direction: 'expense',
    amountCents: 100,
    occurredAt: new Date(),
    source: 'manual',
    categoryId,
    categorySource: 'manual',
    deletedAt: deleted ? new Date() : null,
  });
}

describe('查询', () => {
  it('正向：新账本包含全部预置分类，结构符合契约，使用次数为 0', async () => {
    const cats = await list(alice);
    expect(cats).toHaveLength(flattenPreset().length);
    expect(cats.every((c) => c.transactionCount === 0)).toBe(true);
  });

  it('正向：使用次数统计包含已软删除的流水（它们同样阻止删除）', async () => {
    const food = await byPreset(alice, 'expense.food');
    await useCategory(alice, food.id);
    await useCategory(alice, food.id, true);
    expect((await byPreset(alice, 'expense.food')).transactionCount).toBe(2);
  });
});

describe('新增', () => {
  it('正向：新增一级分类，排在同组最后', async () => {
    const res = await as(app, alice).post(url(alice), { group: 'expense', name: '宠物' });
    expect(res.statusCode).toBe(201);
    const c = categorySchema.parse(res.json());
    expect(c).toMatchObject({ name: '宠物', parentId: null, presetKey: null, hidden: false });
    const tops = (await list(alice)).filter((x) => x.group === 'expense' && !x.parentId);
    expect(Math.max(...tops.map((x) => x.sort))).toBe(c.sort);
  });

  it('正向：在一级分类下新增子分类', async () => {
    const food = await byPreset(alice, 'expense.food');
    const res = await as(app, alice).post(url(alice), { group: 'expense', parentId: food.id, name: '夜宵' });
    expect(res.statusCode).toBe(201);
    expect(res.json().parentId).toBe(food.id);
  });

  it('反向：在子分类下再建分类 → 400 CATEGORY_TOO_DEEP', async () => {
    const meal = await byPreset(alice, 'expense.food.meal');
    const res = await as(app, alice).post(url(alice), { group: 'expense', parentId: meal.id, name: '三级' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('CATEGORY_TOO_DEEP');
  });

  it('反向：子分类组别与父分类不同 → 400 CATEGORY_GROUP_MISMATCH', async () => {
    const food = await byPreset(alice, 'expense.food');
    const res = await as(app, alice).post(url(alice), { group: 'income', parentId: food.id, name: '错组' });
    expect(res.json().code).toBe('CATEGORY_GROUP_MISMATCH');
  });

  it('反向：同级重名 → 409；不同组可以同名', async () => {
    expect((await as(app, alice).post(url(alice), { group: 'expense', name: '餐饮' })).json().code).toBe(
      'CATEGORY_NAME_TAKEN',
    );
    expect((await as(app, alice).post(url(alice), { group: 'income', name: '餐饮' })).statusCode).toBe(201);
  });

  it('反向：父分类是其他账本的 → 404（不泄露其他账本的数据）', async () => {
    const bob = await registerUser(app, 'bob');
    const bobFood = await byPreset(bob, 'expense.food');
    const res = await as(app, alice).post(url(alice), { group: 'expense', parentId: bobFood.id, name: '越界' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('CATEGORY_NOT_FOUND');
  });

  it('反向：名称为空 → 400', async () => {
    expect((await as(app, alice).post(url(alice), { group: 'expense', name: ' ' })).statusCode).toBe(400);
  });
});

describe('修改与隐藏', () => {
  it('正向：改名、隐藏、恢复', async () => {
    const pet = (await as(app, alice).post(url(alice), { group: 'expense', name: '宠物' })).json() as Category;
    const renamed = await as(app, alice).patch(url(alice, `/${pet.id}`), { name: '猫猫狗狗' });
    expect(renamed.json()).toMatchObject({ name: '猫猫狗狗' });
    expect((await as(app, alice).patch(url(alice, `/${pet.id}`), { hidden: true })).json().hidden).toBe(true);
    expect((await as(app, alice).patch(url(alice, `/${pet.id}`), { hidden: false })).json().hidden).toBe(false);
  });

  it('正向：预置分类可以改名和隐藏（只是不能删除）', async () => {
    const food = await byPreset(alice, 'expense.food');
    const res = await as(app, alice).patch(url(alice, `/${food.id}`), { name: '吃饭', hidden: true });
    expect(res.json()).toMatchObject({ name: '吃饭', hidden: true, presetKey: 'expense.food' });
  });

  it('反向：改成同级已有的名字 → 409', async () => {
    const pet = (await as(app, alice).post(url(alice), { group: 'expense', name: '宠物' })).json() as Category;
    expect((await as(app, alice).patch(url(alice, `/${pet.id}`), { name: '餐饮' })).json().code).toBe(
      'CATEGORY_NAME_TAKEN',
    );
  });

  it('反向：空修改、试图修改组别 → 400', async () => {
    const pet = (await as(app, alice).post(url(alice), { group: 'expense', name: '宠物' })).json() as Category;
    expect((await as(app, alice).patch(url(alice, `/${pet.id}`), {})).statusCode).toBe(400);
    expect((await as(app, alice).patch(url(alice, `/${pet.id}`), { group: 'income' })).statusCode).toBe(400);
  });
});

describe('删除', () => {
  it('正向：未使用的自建分类可以删除', async () => {
    const pet = (await as(app, alice).post(url(alice), { group: 'expense', name: '宠物' })).json() as Category;
    expect((await as(app, alice).del(url(alice, `/${pet.id}`))).statusCode).toBe(204);
    expect((await list(alice)).some((c) => c.id === pet.id)).toBe(false);
  });

  it('反向：预置分类不能删除 → 409 CATEGORY_PRESET', async () => {
    const other = await byPreset(alice, 'expense.other');
    const res = await as(app, alice).del(url(alice, `/${other.id}`));
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('CATEGORY_PRESET');
  });

  it('反向：有子分类 → 409 CATEGORY_HAS_CHILDREN', async () => {
    const pet = (await as(app, alice).post(url(alice), { group: 'expense', name: '宠物' })).json() as Category;
    await as(app, alice).post(url(alice), { group: 'expense', parentId: pet.id, name: '猫粮' });
    expect((await as(app, alice).del(url(alice, `/${pet.id}`))).json().code).toBe('CATEGORY_HAS_CHILDREN');
  });

  it('反向：被流水使用（包括已软删除的流水）→ 409 CATEGORY_IN_USE', async () => {
    const pet = (await as(app, alice).post(url(alice), { group: 'expense', name: '宠物' })).json() as Category;
    await useCategory(alice, pet.id, true);
    const res = await as(app, alice).del(url(alice, `/${pet.id}`));
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('CATEGORY_IN_USE');
  });
});

describe('权限', () => {
  it('反向：未登录 → 401', async () => {
    expect((await as(app, null).get(url(alice))).statusCode).toBe(401);
  });

  it('反向：非成员访问他人账本 → 404，且看不到任何数据', async () => {
    const bob = await registerUser(app, 'bob');
    const res = await as(app, bob).get(url(alice));
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('LEDGER_NOT_FOUND');
  });

  it('反向：在自己账本的路径下操作他人账本的分类 id → 404', async () => {
    const bob = await registerUser(app, 'bob');
    const bobFood = await byPreset(bob, 'expense.food');
    expect((await as(app, alice).patch(url(alice, `/${bobFood.id}`), { name: '篡改' })).statusCode).toBe(404);
    expect((await as(app, alice).del(url(alice, `/${bobFood.id}`))).statusCode).toBe(404);
    expect((await byPreset(bob, 'expense.food')).name).toBe('餐饮');
  });

  it('正向 + 反向：只读成员可以查看，但不能新增、修改、删除 → 403', async () => {
    const viewer = await registerUser(app, 'viewer');
    await database.db.insert(ledgerMembers).values({ ledgerId: alice.ledgerId, userId: viewer.id, role: 'viewer' });
    expect((await as(app, viewer).get(url(alice))).statusCode).toBe(200);
    const food = await byPreset(alice, 'expense.food');
    for (const res of [
      await as(app, viewer).post(url(alice), { group: 'expense', name: 'x' }),
      await as(app, viewer).patch(url(alice, `/${food.id}`), { name: 'x' }),
      await as(app, viewer).del(url(alice, `/${food.id}`)),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('LEDGER_FORBIDDEN');
    }
  });

  it('正向：可编辑成员可以新增', async () => {
    const editor = await registerUser(app, 'editor');
    await database.db.insert(ledgerMembers).values({ ledgerId: alice.ledgerId, userId: editor.id, role: 'editor' });
    expect((await as(app, editor).post(url(alice), { group: 'expense', name: '共同' })).statusCode).toBe(201);
  });

  it('反向：路径中的账本 id / 分类 id 不是合法 uuid → 404 而不是 500', async () => {
    expect((await as(app, alice).get('/api/ledgers/not-a-uuid/categories')).statusCode).toBe(404);
    expect((await as(app, alice).patch(url(alice, '/not-a-uuid'), { name: 'x' })).statusCode).toBe(404);
  });
});
