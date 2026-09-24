/**
 * 数据库表定义（P0-2 探针：只包含验证链路所需的最小字段）
 *
 * 要验证的点：
 *   - 金额 bigint（分）在 Drizzle 中的读写是否精确；数据库层面兜底约束（>0、≤ JS 安全整数）
 *   - 方向用 PostgreSQL 枚举，非法值由数据库拒绝
 *   - 时间用 timestamptz；按北京时间切分月份
 *   - 退款 / 跨来源重复用自关联外键表达
 */
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, foreignKey, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const directionEnum = pgEnum('direction', ['income', 'expense', 'neutral']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    direction: directionEnum('direction').notNull(),
    /**
     * 金额（分）。mode: 'number' 让 Drizzle 返回 JS number 而不是字符串；
     * 为了保证不丢精度，数据库再加一道 ≤ 2^53-1 的约束（约 900 亿亿分，远超实际需要）
     */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    categoryKey: text('category_key'),
    counterparty: text('counterparty').notNull().default(''),
    /**
     * 是否为退款（ADR-0004 Q4：退款冲减支出）。单独一个标记而不是只看 refund_of_id：
     * 找不到原消费的退款 refund_of_id 为空，但仍然要冲减支出
     */
    isRefund: boolean('is_refund').notNull().default(false),
    /** 退款时指向原消费；找不到时为空（冲减"其他支出"，待用户确认） */
    refundOfId: uuid('refund_of_id'),
    /** 跨来源重复时指向计入统计的那条；非空即不计入统计（ADR-0004 Q2-B） */
    duplicateOfId: uuid('duplicate_of_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    check('amount_positive', sql`${t.amountCents} > 0`),
    check('amount_safe_integer', sql`${t.amountCents} <= 9007199254740991`),
    // 一条记录不能既是退款又指向自己
    check('refund_not_self', sql`${t.refundOfId} IS NULL OR ${t.refundOfId} <> ${t.id}`),
    // 只有退款才能指向原消费
    check('refund_of_requires_flag', sql`${t.refundOfId} IS NULL OR ${t.isRefund}`),
    foreignKey({ columns: [t.refundOfId], foreignColumns: [t.id], name: 'transactions_refund_of_fk' }),
    foreignKey({ columns: [t.duplicateOfId], foreignColumns: [t.id], name: 'transactions_duplicate_of_fk' }),
    // 统计查询的主路径：按用户 + 时间范围
    index('transactions_user_time_idx').on(t.userId, t.occurredAt),
  ],
);
