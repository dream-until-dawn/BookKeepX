/** 规则接口在真实 PostgreSQL 上验证隔离、历史保护和快照失效。 */
import { categoryListSchema, historyPreviewSchema, type RuleDraft, rulePreviewSchema } from '@bookkeepx/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { categoryRules, importBatches, ledgerMembers, transactions } from '../src/db/schema/index.ts';
import { as, registerUser, type TestUser } from './api-helpers.ts';
import { truncateAll, useMigratedDatabase } from './db-helpers.ts';

const database = useMigratedDatabase();
let app: ReturnType<typeof buildApp>;
let alice: TestUser;
let categoryId: string;
let neutralId: string;
let otherId: string;
const base = () => `/api/ledgers/${alice.ledgerId}/category-rules`;
const draft = (patch: Partial<RuleDraft> = {}): RuleDraft => ({
  name: '商户归类',
  enabled: true,
  priority: 10,
  match: 'all',
  conditions: [{ field: 'counterparty', op: 'equals', values: ['测试商户'] }],
  action: { categoryId },
  origin: 'manual',
  ...patch,
});
const post = (suffix: string, payload: object) => as(app, alice).post(base() + suffix, payload);
async function create(patch: Partial<RuleDraft> = {}) {
  const res = await post('', draft(patch));
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}
async function row(patch: Partial<typeof transactions.$inferInsert> = {}) {
  const [r] = await database.db
    .insert(transactions)
    .values({
      ledgerId: alice.ledgerId,
      source: 'manual',
      direction: 'expense',
      originalDirection: 'expense',
      amountCents: 1200,
      counterparty: '测试商户',
      occurredAt: new Date('2026-09-01T00:00:00Z'),
      ...patch,
    })
    .returning();
  return r!;
}
async function history() {
  const res = await post('/history-preview', {});
  expect(res.statusCode, res.body).toBe(200);
  return historyPreviewSchema.parse(res.json());
}
beforeEach(async () => {
  await truncateAll(database);
  app = buildApp({ database });
  alice = await registerUser(app);
  const cats = categoryListSchema.parse((await as(app, alice).get(`/api/ledgers/${alice.ledgerId}/categories`)).json());
  categoryId = cats.find((c) => c.presetKey === 'expense.food')!.id;
  neutralId = cats.find((c) => c.group === 'neutral')!.id;
  otherId = cats.find((c) => c.presetKey === 'expense.transport')!.id;
});
afterEach(async () => app.close());

describe('规则 CRUD 与输入边界', () => {
  it('创建、完整更新、启停、列表、删除，试跑不保存', async () => {
    await row();
    const preview = await post('/preview', { rule: draft() });
    expect(rulePreviewSchema.parse(preview.json()).matched).toBe(1);
    expect((await as(app, alice).get(base())).json()).toEqual([]);
    const rule = await create();
    const changed = await as(app, alice).patch(`${base()}/${rule.id}`, draft({ enabled: false, name: '停用' }));
    expect(changed.json()).toMatchObject({ enabled: false, name: '停用', hitCount: 0 });
    expect((await history()).changed).toBe(0);
    expect((await as(app, alice).del(`${base()}/${rule.id}`)).statusCode).toBe(204);
    expect((await as(app, alice).del(`${base()}/${rule.id}`)).statusCode).toBe(404);
  });
  it.each([
    { conditions: [] },
    { conditions: [{ field: 'note', op: 'regex', values: ['.*'] }] },
    { conditions: [{ field: 'note', op: 'containsAny', values: ['　 '] }] },
    { conditions: [{ field: 'amount', op: 'gte', value: -1 }] },
    { conditions: [{ field: 'direction', op: 'equals', values: ['bad'] }] },
    { priority: 10001 },
    { hitCount: 500 },
  ])('拒绝非法条件或客户端统计 %j', async (patch) => {
    expect((await post('', { ...draft(), ...patch })).statusCode).toBe(400);
  });
  it('拒绝隐藏、外账本分类以及改向与分类不一致', async () => {
    const bob = await registerUser(app);
    const cats = (await as(app, bob).get(`/api/ledgers/${bob.ledgerId}/categories`)).json();
    expect((await post('', draft({ action: { categoryId: cats[0].id } }))).statusCode).toBe(404);
    expect((await post('', draft({ action: { categoryId, setDirection: 'neutral' } }))).json().code).toBe(
      'CATEGORY_DIRECTION_MISMATCH',
    );
    await as(app, alice).patch(`/api/ledgers/${alice.ledgerId}/categories/${categoryId}`, { hidden: true });
    expect((await post('', draft())).json().code).toBe('CATEGORY_HIDDEN');
  });
  it('跨用户所有操作隔离，viewer 只能读', async () => {
    const r = await create();
    const bob = await registerUser(app);
    expect((await as(app, bob).get(base())).statusCode).toBe(404);
    expect((await as(app, bob).patch(`${base()}/${r.id}`, draft())).statusCode).toBe(404);
    expect((await as(app, bob).del(`${base()}/${r.id}`)).statusCode).toBe(404);
    await database.db.insert(ledgerMembers).values({ ledgerId: alice.ledgerId, userId: bob.id, role: 'viewer' });
    expect((await as(app, bob).get(base())).statusCode).toBe(200);
    for (const suffix of ['', '/preview', '/history-preview', '/apply'])
      expect((await as(app, bob).post(base() + suffix, draft())).statusCode).toBe(403);
    expect((await as(app, bob).patch(`${base()}/${r.id}`, draft())).statusCode).toBe(403);
    expect((await as(app, bob).del(`${base()}/${r.id}`)).statusCode).toBe(403);
  });
});
describe('冲突与历史应用', () => {
  it('同优先级新草稿与保存后结果一致，停用旧规则重新启用仍保持原顺序', async () => {
    await row();
    const a = await create();
    const proposed = draft({ action: { categoryId: otherId } });
    const trial = (await post('/preview', { rule: proposed })).json();
    expect(trial.samples[0].after.ruleId).toBe(a.id);
    await create({ action: { categoryId: otherId } });
    expect((await history()).samples[0]?.after.ruleId).toBe(a.id);
    await as(app, alice).patch(`${base()}/${a.id}`, draft({ enabled: false }));
    const enabled = (await post('/preview', { rule: draft(), ruleId: a.id })).json();
    expect(enabled.samples[0].after.ruleId).toBe(a.id);
  });
  it('并发应用同一摘要只有一次写入和命中计数', async () => {
    const rule = await create();
    await row();
    const { digest } = await history();
    const results = await Promise.all([post('/apply', { digest }), post('/apply', { digest })]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await as(app, alice).get(base())).json().find((r: { id: string }) => r.id === rule.id).hitCount).toBe(1);
  });
  it('无单号账单来源与批次户名参与历史匹配', async () => {
    await create({ conditions: [{ field: 'source', op: 'equals', values: ['cmb'] }] });
    const bank = await row({ source: 'import', importSource: 'cmb' });
    expect((await history()).samples.find((r) => r.id === bank.id)?.after.categoryId).toBe(categoryId);
    const [batch] = await database.db
      .insert(importBatches)
      .values({
        ledgerId: alice.ledgerId,
        fileName: 'synthetic.csv',
        fileSha256: 'a'.repeat(64),
        fileSize: 20,
        templateId: 'cmb-pdf',
        templateVersion: 1,
        detectScore: 1,
        holderName: '测试户名',
      })
      .returning();
    const self = await row({ source: 'import', importBatchId: batch!.id, counterparty: '测试户名' });
    expect((await history()).samples.find((r) => r.id === self.id)?.after.direction).toBe('neutral');
  });
  it('规则变动后拒绝旧摘要；不存在的规则不能用草稿替换', async () => {
    const r = await create();
    await row();
    const old = await history();
    await as(app, alice).patch(`${base()}/${r.id}`, draft({ action: { categoryId: otherId } }));
    expect((await post('/apply', { digest: old.digest })).statusCode).toBe(409);
    expect((await post('/preview', { rule: draft(), ruleId: '00000000-0000-4000-8000-000000000099' })).statusCode).toBe(
      404,
    );
  });
  it('历史超过一万条拒绝而不是悄悄截断', async () => {
    await database.db.execute(sql`INSERT INTO transactions (ledger_id, source, direction, amount_cents, occurred_at)
      SELECT ${alice.ledgerId}::uuid, 'manual', 'expense', 100, now() FROM generate_series(1, 10001)`);
    const res = await post('/history-preview', {});
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('RULE_HISTORY_LIMIT');
  });
  it('多条有效规则给出不同动作才冲突，优先级胜出；编辑替换旧规则', async () => {
    await row();
    const first = await create();
    const res = await post('/preview', { rule: draft({ priority: 20, action: { categoryId: otherId } }) });
    const preview = rulePreviewSchema.parse(res.json());
    expect(preview.conflicts).toBe(1);
    expect(preview.samples[0]?.after.ruleId).toBe(first.id);
    const edit = await post('/preview', { rule: draft({ action: { categoryId: otherId } }), ruleId: first.id });
    expect(edit.json().conflicts).toBe(0);
    expect(edit.json().samples[0].after.categoryId).toBe(otherId);
  });
  it('手动、退款、原消费和已删除记录受保护，普通记录应用且重复执行不累加', async () => {
    const r = await create();
    const ordinary = await row();
    await row({ categorySource: 'manual', categoryId: otherId });
    const parent = await row();
    await row({ isRefund: true, refundOfId: parent.id, direction: 'income' });
    await row({ deletedAt: new Date() });
    const preview = await history();
    expect(preview).toMatchObject({ scanned: 4, changed: 1, protectedCount: 3 });
    expect(preview.samples[0]?.id).toBe(ordinary.id);
    expect((await post('/apply', { digest: preview.digest })).json()).toEqual({ changed: 1 });
    const again = await history();
    expect(again.changed).toBe(0);
    expect((await post('/apply', { digest: again.digest })).json()).toEqual({ changed: 0 });
    expect((await as(app, alice).get(base())).json()[0]).toMatchObject({ id: r.id, hitCount: 1 });
  });
  it('预览后修改备注、手动分类或规则使摘要失效，拒绝全部写入', async () => {
    await create();
    const original = await row();
    const preview = await history();
    await database.db.update(transactions).set({ note: '后来修改' }).where(eq(transactions.id, original.id));
    const res = await post('/apply', { digest: preview.digest });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('RULE_PREVIEW_STALE');
    const [unchanged] = await database.db.select().from(transactions).where(eq(transactions.id, original.id));
    expect(unchanged?.categoryId).toBeNull();
  });
  it('中性规则停用后从原始方向恢复；删除规则解除引用且保留分类', async () => {
    const rule = await create({ action: { categoryId: neutralId, setDirection: 'neutral' } });
    const original = await row();
    await post('/apply', { digest: (await history()).digest });
    const [neutral] = await database.db.select().from(transactions).where(eq(transactions.id, original.id));
    expect(neutral).toMatchObject({ direction: 'neutral', originalDirection: 'expense', categoryRuleId: rule.id });
    expect((await as(app, alice).del(`${base()}/${rule.id}`)).statusCode).toBe(204);
    const [retained] = await database.db.select().from(transactions).where(eq(transactions.id, original.id));
    expect(retained).toMatchObject({ direction: 'neutral', categoryId: neutralId, categoryRuleId: null });
    const preview = await history();
    expect(preview.samples[0]?.after.direction).toBe('expense');
    expect((await post('/apply', { digest: preview.digest })).statusCode).toBe(200);
  });
  it('其他账本流水不受影响，重复关系保留', async () => {
    await create();
    const a = await row();
    const b = await row({ duplicateOfId: a.id });
    const bob = await registerUser(app);
    const foreign = await row({ ledgerId: bob.ledgerId });
    await post('/apply', { digest: (await history()).digest });
    const [kept] = await database.db.select().from(transactions).where(eq(transactions.id, b.id));
    const [untouched] = await database.db.select().from(transactions).where(eq(transactions.id, foreign.id));
    expect(kept?.duplicateOfId).toBe(a.id);
    expect(untouched?.categoryId).toBeNull();
  });
  it('存量非法规则不使导入分类器或预览崩溃', async () => {
    await row();
    await database.db
      .insert(categoryRules)
      .values({ ledgerId: alice.ledgerId, name: '旧坏规则', conditions: [{ field: 'bad' }], action: { categoryId } });
    expect((await history()).changed).toBe(0);
  });
  it('同优先级按 id 稳定决策', async () => {
    const a = await create();
    const b = await create({ action: { categoryId: otherId } });
    await database.db
      .update(categoryRules)
      .set({ createdAt: new Date('2026-01-01T00:00:00Z') })
      .where(eq(categoryRules.ledgerId, alice.ledgerId));
    await row();
    const expected = [a.id, b.id].sort()[0];
    expect((await history()).samples[0]?.after.ruleId).toBe(expected);
    await database.db
      .update(categoryRules)
      .set({ name: '物理更新不改顺序' })
      .where(and(eq(categoryRules.id, a.id), eq(categoryRules.ledgerId, alice.ledgerId)));
    expect((await history()).samples[0]?.after.ruleId).toBe(expected);
  });
});
