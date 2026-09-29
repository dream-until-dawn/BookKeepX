/** 规则仓储：所有读写都包含账本条件。 */
import type { RuleDraft } from '@bookkeepx/contracts';
import { and, asc, desc, eq, getTableColumns, isNull } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { categories, categoryRules, importBatches, transactions } from '../../db/schema/index.ts';
import type { LedgerScope } from '../ledgers/access.ts';

/** 读取全部规则，稳定排序用于列表和快照。 */
export const readRules = (db: DbOrTx, scope: LedgerScope) =>
  db
    .select()
    .from(categoryRules)
    .where(eq(categoryRules.ledgerId, scope.ledgerId))
    .orderBy(asc(categoryRules.priority), asc(categoryRules.createdAt), asc(categoryRules.id));
/** 限制单次预览的数据规模，多取一条以检测超限。 */
export const readRows = (db: DbOrTx, scope: LedgerScope) =>
  db
    .select({ ...getTableColumns(transactions), holderName: importBatches.holderName })
    .from(transactions)
    .leftJoin(
      importBatches,
      and(eq(importBatches.id, transactions.importBatchId), eq(importBatches.ledgerId, scope.ledgerId)),
    )
    .where(and(eq(transactions.ledgerId, scope.ledgerId), isNull(transactions.deletedAt)))
    .orderBy(desc(transactions.occurredAt), asc(transactions.id))
    .limit(10001);
/** 包括已删除退款的原消费也保护，避免恢复退款后出现不一致。 */
export const readRefunds = (db: DbOrTx, scope: LedgerScope) =>
  db
    .select({ refundOfId: transactions.refundOfId })
    .from(transactions)
    .where(and(eq(transactions.ledgerId, scope.ledgerId), eq(transactions.isRefund, true)));
/** 查询目标分类时不暴露其他账本数据。 */
export const readCategory = (db: DbOrTx, scope: LedgerScope, id: string) =>
  db
    .select()
    .from(categories)
    .where(and(eq(categories.ledgerId, scope.ledgerId), eq(categories.id, id)));
/** 创建或替换规则，不接收客户端命中统计。 */
export async function writeRule(db: DbOrTx, scope: LedgerScope, input: RuleDraft, id?: string) {
  const values = { ...input, conditions: input.conditions, action: input.action };
  return id
    ? db
        .update(categoryRules)
        .set(values)
        .where(and(eq(categoryRules.id, id), eq(categoryRules.ledgerId, scope.ledgerId)))
        .returning()
    : db
        .insert(categoryRules)
        .values({ ...values, ledgerId: scope.ledgerId })
        .returning();
}
/** 删除前解除规则引用，但保留已经得到的分类及其来源。 */
export async function removeRule(db: DbOrTx, scope: LedgerScope, id: string) {
  await db
    .update(transactions)
    .set({ categoryRuleId: null })
    .where(and(eq(transactions.ledgerId, scope.ledgerId), eq(transactions.categoryRuleId, id)));
  return db
    .delete(categoryRules)
    .where(and(eq(categoryRules.ledgerId, scope.ledgerId), eq(categoryRules.id, id)))
    .returning();
}
