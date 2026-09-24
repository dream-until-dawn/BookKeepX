/**
 * 分类规则与来源分类映射（归属账本，ADR-0004）
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { categories } from './categories.ts';
import { timestamps } from './common.ts';
import { ledgers } from './identity.ts';

export const ruleMatchEnum = pgEnum('rule_match', ['all', 'any']);
export const ruleOriginEnum = pgEnum('rule_origin', ['manual', 'learned', 'agent']);

export const categoryRules = pgTable(
  'category_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ledgerId: uuid('ledger_id')
      .notNull()
      .references(() => ledgers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** 数字小的先匹配 */
    priority: integer('priority').notNull().default(100),
    match: ruleMatchEnum('match').notNull().default('all'),
    /** 条件列表（字段 + 操作符 + 关键词；不支持正则），结构由 core 的 zod schema 校验（P1-8） */
    conditions: jsonb('conditions').notNull(),
    /** 动作：{ categoryId, setDirection? } */
    action: jsonb('action').notNull(),
    origin: ruleOriginEnum('origin').notNull().default('manual'),
    hitCount: integer('hit_count').notNull().default(0),
    lastHitAt: timestamp('last_hit_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('category_rules_id_ledger_uq').on(t.id, t.ledgerId),
    check('category_rules_hit_count_non_negative', sql`${t.hitCount} >= 0`),
    check('category_rules_conditions_array', sql`jsonb_typeof(${t.conditions}) = 'array'`),
    check('category_rules_action_object', sql`jsonb_typeof(${t.action}) = 'object'`),
  ],
);

export const sourceHintMappings = pgTable(
  'source_hint_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ledgerId: uuid('ledger_id')
      .notNull()
      .references(() => ledgers.id, { onDelete: 'cascade' }),
    /** 来源，如 alipay */
    source: text('source').notNull(),
    /** 原生分类，如"商业服务" */
    hint: text('hint').notNull(),
    categoryId: uuid('category_id').notNull(),
    ...timestamps(),
  },
  (t) => [
    unique('source_hint_mappings_uq').on(t.ledgerId, t.source, t.hint),
    // 分类必须属于同一账本
    foreignKey({
      name: 'source_hint_mappings_category_fk',
      columns: [t.categoryId, t.ledgerId],
      foreignColumns: [categories.id, categories.ledgerId],
    }).onDelete('cascade'),
  ],
);
