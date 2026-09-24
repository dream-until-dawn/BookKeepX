/**
 * 各表共用的列与枚举
 */
import { timestamp } from 'drizzle-orm/pg-core';

/** created_at / updated_at：每张业务表都有；updated_at 在 Drizzle 更新时自动刷新 */
export const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** JS 最大安全整数：金额列的上限（ADR-0002），超过会在读回 JS 时丢精度 */
export const MAX_SAFE_CENTS = '9007199254740991';
