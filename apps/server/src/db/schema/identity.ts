/**
 * 身份与账本：users、ledgers、ledger_members、sessions
 *
 * 这几张表互相引用（users.default_ledger_id → ledgers，ledger_members → 两者），放在同一个文件里。
 * 数据隔离的单位是账本（ADR-0006）。
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  inet,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamps } from './common.ts';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 登录邮箱，存入前统一转小写；唯一性按小写比较 */
    email: text('email').notNull(),
    /** argon2id 哈希，不存明文 */
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    /** 用户时区：个人统计按它切分日、月 */
    timezone: text('timezone').notNull().default('Asia/Shanghai'),
    /** 默认账本（注册时自动创建） */
    defaultLedgerId: uuid('default_ledger_id').references((): AnyPgColumn => ledgers.id, { onDelete: 'set null' }),
    /** 本人姓名 / 常用名：识别"转给自己"（data-model.md Q3） */
    selfNames: text('self_names').array().notNull().default(sql`'{}'::text[]`),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`),
    check('users_email_lowercase', sql`${t.email} = lower(${t.email})`),
  ],
);

export const ledgers = pgTable('ledgers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  currency: text('currency').notNull().default('CNY'),
  /** 账本时区：共享账本的统计按它切分日、月 */
  timezone: text('timezone').notNull().default('Asia/Shanghai'),
  /** 写入预置分类时的版本（core 的 PRESET_VERSION） */
  presetVersion: integer('preset_version').notNull(),
  ...timestamps(),
});

export const ledgerRoleEnum = pgEnum('ledger_role', ['owner', 'editor', 'viewer']);

export const ledgerMembers = pgTable(
  'ledger_members',
  {
    ledgerId: uuid('ledger_id')
      .notNull()
      .references(() => ledgers.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: ledgerRoleEnum('role').notNull(),
    ...timestamps(),
  },
  (t) => [primaryKey({ columns: [t.ledgerId, t.userId] }), index('ledger_members_user_idx').on(t.userId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 会话令牌的 SHA-256（十六进制）；数据库里不存令牌原文 */
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
    ip: inet('ip'),
    ...timestamps(),
  },
  (t) => [
    index('sessions_user_idx').on(t.userId),
    index('sessions_expires_idx').on(t.expiresAt),
    check('sessions_token_hash_format', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
