/**
 * 流水（核心表，归属账本）
 *
 * 数据库层面的保证：
 *   - 金额 0 < x ≤ 2^53−1（ADR-0002）
 *   - 引用的账户、分类、导入批次、规则、原消费、重复对象都属于同一账本（组合外键）
 *   - 只有退款才能指向原消费；不能指向自己
 *   - 未分类 ⇔ category_source = 'none'
 *   - 平台单号在账本内唯一（已软删除的不算），防止重复导入
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.ts';
import { categories } from './categories.ts';
import { MAX_SAFE_CENTS, timestamps } from './common.ts';
import { ledgers, users } from './identity.ts';
import { importBatches } from './imports.ts';
import { categoryRules } from './rules.ts';

export const directionEnum = pgEnum('direction', ['income', 'expense', 'neutral']);
export const timePrecisionEnum = pgEnum('time_precision', ['second', 'day']);
export const transactionSourceEnum = pgEnum('transaction_source', ['manual', 'import']);
export const categorySourceEnum = pgEnum('category_source', [
  'manual',
  'user_rule',
  'system_rule',
  'source_hint',
  'none',
]);

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ledgerId: uuid('ledger_id')
      .notNull()
      .references(() => ledgers.id, { onDelete: 'cascade' }),
    /** 谁记的；用户删除后置空 */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    accountId: uuid('account_id'),
    categoryId: uuid('category_id'),
    direction: directionEnum('direction').notNull(),
    /** 金额（分），恒为正；mode:'number' 让 Drizzle 返回 JS number（范围由约束保证安全） */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('CNY'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** 银行流水只有日期 */
    timePrecision: timePrecisionEnum('time_precision').notNull().default('second'),
    counterparty: text('counterparty').notNull().default(''),
    /** 商品说明 / 交易摘要（来自账单） */
    description: text('description').notNull().default(''),
    /** 用户自己的备注 */
    note: text('note').notNull().default(''),
    source: transactionSourceEnum('source').notNull(),
    importBatchId: uuid('import_batch_id'),
    externalSource: text('external_source'),
    externalId: text('external_id'),
    /** 无单号的银行流水去重键 */
    dedupeKey: text('dedupe_key'),
    balanceAfterCents: bigint('balance_after_cents', { mode: 'number' }),
    paymentMethod: text('payment_method'),
    /** 账单原生分类（支付宝"交易分类"、招行"交易摘要"） */
    sourceCategory: text('source_category'),
    /** 导入时的原始行 */
    raw: jsonb('raw'),
    categorySource: categorySourceEnum('category_source').notNull().default('none'),
    categoryRuleId: uuid('category_rule_id'),
    isRefund: boolean('is_refund').notNull().default(false),
    refundOfId: uuid('refund_of_id'),
    duplicateOfId: uuid('duplicate_of_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('transactions_id_ledger_uq').on(t.id, t.ledgerId),

    // —— 同账本组合外键 ——
    foreignKey({
      name: 'transactions_account_fk',
      columns: [t.accountId, t.ledgerId],
      foreignColumns: [accounts.id, accounts.ledgerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'transactions_category_fk',
      columns: [t.categoryId, t.ledgerId],
      foreignColumns: [categories.id, categories.ledgerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'transactions_import_batch_fk',
      columns: [t.importBatchId, t.ledgerId],
      foreignColumns: [importBatches.id, importBatches.ledgerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'transactions_category_rule_fk',
      columns: [t.categoryRuleId, t.ledgerId],
      foreignColumns: [categoryRules.id, categoryRules.ledgerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'transactions_refund_of_fk',
      columns: [t.refundOfId, t.ledgerId],
      foreignColumns: [t.id, t.ledgerId],
    }),
    foreignKey({
      name: 'transactions_duplicate_of_fk',
      columns: [t.duplicateOfId, t.ledgerId],
      foreignColumns: [t.id, t.ledgerId],
    }),

    // —— 取值约束 ——
    check('transactions_amount_range', sql`${t.amountCents} > 0 AND ${t.amountCents} <= ${sql.raw(MAX_SAFE_CENTS)}`),
    check(
      'transactions_balance_range',
      sql`${t.balanceAfterCents} IS NULL OR abs(${t.balanceAfterCents}) <= ${sql.raw(MAX_SAFE_CENTS)}`,
    ),
    check('transactions_refund_of_requires_flag', sql`${t.refundOfId} IS NULL OR ${t.isRefund}`),
    check('transactions_refund_not_self', sql`${t.refundOfId} IS NULL OR ${t.refundOfId} <> ${t.id}`),
    check('transactions_duplicate_not_self', sql`${t.duplicateOfId} IS NULL OR ${t.duplicateOfId} <> ${t.id}`),
    check('transactions_category_source', sql`(${t.categoryId} IS NULL) = (${t.categorySource} = 'none')`),
    check(
      'transactions_rule_requires_user_rule',
      sql`${t.categoryRuleId} IS NULL OR ${t.categorySource} = 'user_rule'`,
    ),
    check('transactions_external_pair', sql`(${t.externalId} IS NULL) = (${t.externalSource} IS NULL)`),
    check('transactions_import_batch_source', sql`${t.importBatchId} IS NULL OR ${t.source} = 'import'`),

    // —— 索引 ——
    uniqueIndex('transactions_external_uq')
      .on(t.ledgerId, t.externalSource, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    index('transactions_ledger_time_idx').on(t.ledgerId, t.occurredAt),
    index('transactions_ledger_category_idx').on(t.ledgerId, t.categoryId),
    index('transactions_ledger_batch_idx').on(t.ledgerId, t.importBatchId),
    index('transactions_ledger_dedupe_idx').on(t.ledgerId, t.dedupeKey),
  ],
);
