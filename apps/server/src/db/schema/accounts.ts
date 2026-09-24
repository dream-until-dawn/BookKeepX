/**
 * 资金账户：微信、支付宝、某张银行卡、现金……（归属账本）
 */
import { sql } from 'drizzle-orm';
import { check, integer, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { timestamps } from './common.ts';
import { ledgers } from './identity.ts';

export const accountKindEnum = pgEnum('account_kind', [
  'wechat',
  'alipay',
  'bank_debit',
  'credit_card',
  'cash',
  'other',
]);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ledgerId: uuid('ledger_id')
      .notNull()
      .references(() => ledgers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: accountKindEnum('kind').notNull(),
    /** 机构，如"招商银行" */
    institution: text('institution'),
    /** 卡号后四位：匹配账单中的"储蓄卡(1032)""6214****1032" */
    cardLast4: text('card_last4'),
    currency: text('currency').notNull().default('CNY'),
    sort: integer('sort').notNull().default(0),
    /** 停用时间（注销的卡）；停用后不出现在选择列表，历史流水保留 */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('accounts_ledger_name_uq').on(t.ledgerId, t.name),
    // 供其他表做 (account_id, ledger_id) 组合外键：保证引用的账户属于同一账本
    unique('accounts_id_ledger_uq').on(t.id, t.ledgerId),
    check('accounts_card_last4_format', sql`${t.cardLast4} IS NULL OR ${t.cardLast4} ~ '^[0-9]{4}$'`),
    check('accounts_name_not_blank', sql`btrim(${t.name}) <> ''`),
  ],
);
