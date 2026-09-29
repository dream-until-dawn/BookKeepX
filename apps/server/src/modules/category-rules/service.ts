/** 规则管理与历史应用：复用导入分类器，不信任客户端提交的分类结果。 */
import { createHash } from 'node:crypto';
import { type CategoryRule, categoryRuleSchema, type RuleDraft, type RuleSample } from '@bookkeepx/contracts';
import { type Classifiable, type ClassifierConfig, classify } from '@bookkeepx/core';
import { and, eq, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.ts';
import { categoryRules, transactions } from '../../db/schema/index.ts';
import { AppError } from '../../errors.ts';
import { loadClassifierConfig, loadSelfNames } from '../imports/index.ts';
import type { LedgerScope } from '../ledgers/access.ts';
import { readCategory, readRefunds, readRows, readRules, removeRule, writeRule } from './repository.ts';

const notFound = () => new AppError(404, 'RULE_NOT_FOUND', '规则不存在');
const DRAFT_ID = '00000000-0000-4000-8000-000000000000';
type Row = typeof transactions.$inferSelect & { holderName?: string | null };
type Saved = typeof categoryRules.$inferSelect;
function dto(r: Saved): CategoryRule {
  const { ledgerId: _ledgerId, ...value } = r;
  return categoryRuleSchema.parse({
    ...value,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    lastHitAt: r.lastHitAt?.toISOString() ?? null,
  });
}

/** 获取账本规则列表。 */
export async function listRules(db: DbOrTx, scope: LedgerScope) {
  return (await readRules(db, scope)).map(dto);
}
async function validateTarget(db: DbOrTx, scope: LedgerScope, input: RuleDraft) {
  const [c] = await readCategory(db, scope, input.action.categoryId);
  if (!c) throw new AppError(404, 'CATEGORY_NOT_FOUND', '分类不存在');
  if (c.hidden) throw new AppError(400, 'CATEGORY_HIDDEN', '规则不能使用隐藏分类');
  if (input.action.setDirection && c.group !== 'neutral')
    throw new AppError(400, 'CATEGORY_DIRECTION_MISMATCH', '改为中性时必须选择中性分类');
}
/** 保存完整草稿；创建上限防止规则数量无限增长。 */
export async function saveRule(db: Db, scope: LedgerScope, input: RuleDraft, id?: string) {
  return db.transaction(async (tx) => {
    // 同账本规则变更串行，创建上限不会被并发请求绕过。
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${scope.ledgerId}))`);
    const rules = await readRules(tx, scope);
    if (id && !rules.some((r) => r.id === id)) throw notFound();
    if (!id && rules.length >= 200) throw new AppError(400, 'RULE_LIMIT', '每个账本最多 200 条规则');
    await validateTarget(tx, scope, input);
    const [r] = await writeRule(tx, scope, input, id);
    return dto(r!);
  });
}
/** 删除不重新分类历史数据。 */
export async function deleteRule(db: Db, scope: LedgerScope, id: string) {
  await db.transaction(async (tx) => {
    const removed = await removeRule(tx, scope, id);
    if (removed.length === 0) throw notFound();
  });
}
function inputOf(r: Row, selfNames: string[]): Classifiable {
  return {
    direction: r.originalDirection ?? r.direction,
    amountCents: r.amountCents,
    counterparty: r.counterparty,
    description: r.description,
    note: r.note,
    paymentMethod: r.paymentMethod,
    sourceHint: r.sourceCategory,
    source: r.importSource ?? r.externalSource ?? r.source,
    selfNames: r.holderName ? [...selfNames, r.holderName] : selfNames,
  };
}
function beforeOf(r: Row) {
  return { categoryId: r.categoryId, direction: r.direction, ruleId: r.categoryRuleId, source: r.categorySource };
}
async function context(db: DbOrTx, scope: LedgerScope) {
  const rows = await readRows(db, scope);
  if (rows.length > 10000)
    throw new AppError(400, 'RULE_HISTORY_LIMIT', '有效流水超过 10000 笔，请等待分批应用功能；本次未改动任何流水');
  const cfg = await loadClassifierConfig(db, scope);
  const selfNames = await loadSelfNames(db, scope);
  const refundParents = new Set((await readRefunds(db, scope)).map((r) => r.refundOfId));
  return { rows, cfg, selfNames, refundParents };
}
function sample(r: Row, cfg: ClassifierConfig, selfNames: string[], protectedRow: boolean): RuleSample {
  const t = inputOf(r, selfNames);
  const result = classify(t, cfg);
  // 用同一个分类器逐条试跑，避免把方向不匹配或隐藏分类误报成冲突。
  const matching = cfg.userRules.filter(
    (rule) => classify(t, { ...cfg, userRules: [rule], systemRules: [], sourceHints: {} }).ruleId === rule.id,
  );
  const actions = new Set(
    matching.map((rule) => `${rule.action.categoryId}:${rule.action.setDirection ?? t.direction}`),
  );
  return {
    id: r.id,
    counterparty: r.counterparty,
    occurredAt: r.occurredAt.toISOString(),
    amountCents: r.amountCents,
    before: beforeOf(r),
    after: protectedRow
      ? beforeOf(r)
      : { categoryId: result.categoryId, direction: result.direction, ruleId: result.ruleId, source: result.source },
    protected: protectedRow,
    matchingRules: matching.map(({ id, name }) => ({ id, name })),
    conflict: actions.size > 1,
  };
}
/** 草稿试跑：替换原规则而不是让草稿和旧版本互相冲突。 */
export async function previewRule(db: Db, scope: LedgerScope, rule: RuleDraft, ruleId?: string) {
  return db.transaction(
    async (tx) => {
      await validateTarget(tx, scope, rule);
      const savedRule = ruleId ? (await readRules(tx, scope)).find((r) => r.id === ruleId) : undefined;
      if (ruleId && !savedRule) throw notFound();
      const c = await context(tx, scope);
      const id = ruleId ?? DRAFT_ID;
      const createdAt = savedRule?.createdAt.toISOString() ?? '9999';
      c.cfg.userRules = [...c.cfg.userRules.filter((r) => r.id !== id), { ...rule, id, createdAt }];
      const samples = c.rows
        .map((r) =>
          sample(r, c.cfg, c.selfNames, r.categorySource === 'manual' || r.isRefund || c.refundParents.has(r.id)),
        )
        .filter((s) => s.matchingRules.some((r) => r.id === id));
      return {
        scanned: c.rows.length,
        matched: samples.length,
        conflicts: samples.filter((r) => r.conflict).length,
        samples: samples.slice(0, 100),
      };
    },
    { isolationLevel: 'repeatable read' },
  );
}
async function history(db: DbOrTx, scope: LedgerScope) {
  const c = await context(db, scope);
  const changes = c.rows.map((r) =>
    sample(r, c.cfg, c.selfNames, r.categorySource === 'manual' || r.isRefund || c.refundParents.has(r.id)),
  );
  const modified = changes.filter((s) => JSON.stringify(s.before) !== JSON.stringify(s.after));
  // 摘要覆盖输入与结果；包括手动保护、分类隐藏、规则优先级、本人姓名等变化。
  const digest = createHash('sha256')
    .update(JSON.stringify({ ledgerId: scope.ledgerId, rows: c.rows, cfg: c.cfg, selfNames: c.selfNames, changes }))
    .digest('hex');
  return {
    digest,
    scanned: changes.length,
    changed: modified.length,
    protectedCount: changes.filter((s) => s.protected).length,
    samples: modified.slice(0, 100),
    modified,
    rows: c.rows,
  };
}
/** 历史预览是只读的一致快照，不产生分类副作用。 */
export async function previewHistory(db: Db, scope: LedgerScope) {
  return db.transaction(
    async (tx) => {
      const { modified: _modified, rows: _rows, ...preview } = await history(tx, scope);
      return preview;
    },
    { isolationLevel: 'repeatable read' },
  );
}
/** 锁住相关表后重新核验快照，任何失败都回滚全部变更。 */
export async function applyHistory(db: Db, scope: LedgerScope, digest: string) {
  return db.transaction(async (tx) => {
    // MVP 的有界批处理采用表锁，阻止校验与写入之间的新增/修改；后续分批任务可替换为版本控制。
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await tx.execute(
      sql`LOCK TABLE transactions, category_rules, categories, users, import_batches IN SHARE ROW EXCLUSIVE MODE`,
    );
    const preview = await history(tx, scope);
    if (preview.digest !== digest) throw new AppError(409, 'RULE_PREVIEW_STALE', '规则或流水已变化，请重新预览');
    const byId = new Map(preview.rows.map((r) => [r.id, r]));
    const hits = new Map<string, number>();
    for (const s of preview.modified) {
      const r = byId.get(s.id)!;
      await tx
        .update(transactions)
        .set({
          categoryId: s.after.categoryId,
          direction: s.after.direction,
          categorySource: s.after.source as Row['categorySource'],
          categoryRuleId: s.after.ruleId,
          originalDirection: r.originalDirection ?? r.direction,
        })
        .where(and(eq(transactions.id, s.id), eq(transactions.ledgerId, scope.ledgerId)));
      if (s.after.ruleId) hits.set(s.after.ruleId, (hits.get(s.after.ruleId) ?? 0) + 1);
    }
    for (const [id, count] of hits)
      await tx
        .update(categoryRules)
        .set({ hitCount: sql`${categoryRules.hitCount} + ${count}`, lastHitAt: new Date() })
        .where(and(eq(categoryRules.id, id), eq(categoryRules.ledgerId, scope.ledgerId)));
    return { changed: preview.changed };
  });
}
