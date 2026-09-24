/**
 * 分类（归属账本，ADR-0004）
 *
 * 数据库层面保证：子分类与父分类属于同一账本、同一组（通过组合外键）。
 * "最多两级"由服务层保证（P1-4）。
 */
import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, integer, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { timestamps } from './common.ts';
import { ledgers } from './identity.ts';

export const categoryGroupEnum = pgEnum('category_group', ['expense', 'income', 'neutral']);

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ledgerId: uuid('ledger_id')
      .notNull()
      .references(() => ledgers.id, { onDelete: 'cascade' }),
    /** 空 = 一级分类 */
    parentId: uuid('parent_id'),
    group: categoryGroupEnum('group').notNull(),
    name: text('name').notNull(),
    /** 来自系统预置时的稳定键（如 expense.transport.public） */
    presetKey: text('preset_key'),
    icon: text('icon'),
    sort: integer('sort').notNull().default(0),
    /** 隐藏：不出现在选择列表，历史流水仍保留该分类 */
    hidden: boolean('hidden').notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    unique('categories_ledger_preset_uq').on(t.ledgerId, t.presetKey),
    // 同一父分类下名称唯一；一级分类（parent_id 为空）之间也不能重名，所以 NULL 视为相同
    unique('categories_sibling_name_uq').on(t.ledgerId, t.group, t.parentId, t.name).nullsNotDistinct(),
    // 组合外键的被引用端
    unique('categories_id_ledger_uq').on(t.id, t.ledgerId),
    unique('categories_id_ledger_group_uq').on(t.id, t.ledgerId, t.group),
    // 父分类必须在同一账本、同一组
    foreignKey({
      name: 'categories_parent_fk',
      columns: [t.parentId, t.ledgerId, t.group],
      foreignColumns: [t.id, t.ledgerId, t.group],
    }).onDelete('restrict'),
    check('categories_not_own_parent', sql`${t.parentId} IS NULL OR ${t.parentId} <> ${t.id}`),
    check('categories_name_not_blank', sql`btrim(${t.name}) <> ''`),
  ],
);
