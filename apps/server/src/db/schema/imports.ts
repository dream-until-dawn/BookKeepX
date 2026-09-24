/**
 * 导入相关：import_batches（归属账本）、import_templates（归属用户，ADR-0006）
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.ts';
import { timestamps } from './common.ts';
import { ledgers, users } from './identity.ts';

export const importStatusEnum = pgEnum('import_status', ['previewing', 'committed', 'reverted', 'expired']);
export const fileTypeEnum = pgEnum('file_type', ['csv', 'xlsx', 'pdf']);

export const importBatches = pgTable(
  'import_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ledgerId: uuid('ledger_id')
      .notNull()
      .references(() => ledgers.id, { onDelete: 'cascade' }),
    /** 谁上传的；用户删除后置空 */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    accountId: uuid('account_id'),
    status: importStatusEnum('status').notNull().default('previewing'),
    fileName: text('file_name').notNull(),
    /** 文件指纹：同一文件重复上传时提示（不保存原始文件，data-model.md Q1） */
    fileSha256: text('file_sha256').notNull(),
    fileSize: integer('file_size').notNull(),
    /** 内置模板 id（如 alipay-csv）或用户模板 uuid */
    templateId: text('template_id').notNull(),
    templateVersion: integer('template_version').notNull(),
    detectScore: real('detect_score').notNull(),
    holderName: text('holder_name'),
    periodStart: date('period_start'),
    periodEnd: date('period_end'),
    verifyResult: jsonb('verify_result').notNull().default(sql`'{}'::jsonb`),
    /** 预览阶段暂存的解析结果；提交或过期后清空 */
    preview: jsonb('preview'),
    totalRows: integer('total_rows').notNull().default(0),
    importedRows: integer('imported_rows').notNull().default(0),
    skippedRows: integer('skipped_rows').notNull().default(0),
    duplicateRows: integer('duplicate_rows').notNull().default(0),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('import_batches_id_ledger_uq').on(t.id, t.ledgerId),
    // 账户必须属于同一账本
    foreignKey({
      name: 'import_batches_account_fk',
      columns: [t.accountId, t.ledgerId],
      foreignColumns: [accounts.id, accounts.ledgerId],
    }).onDelete('restrict'),
    index('import_batches_ledger_idx').on(t.ledgerId, t.createdAt),
    index('import_batches_sha_idx').on(t.ledgerId, t.fileSha256),
    check('import_batches_sha_format', sql`${t.fileSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'import_batches_counts_non_negative',
      sql`${t.totalRows} >= 0 AND ${t.importedRows} >= 0 AND ${t.skippedRows} >= 0 AND ${t.duplicateRows} >= 0`,
    ),
    check('import_batches_score_range', sql`${t.detectScore} >= 0 AND ${t.detectScore} <= 1`),
    check('import_batches_committed_at', sql`${t.status} <> 'committed' OR ${t.committedAt} IS NOT NULL`),
  ],
);

export const importTemplates = pgTable(
  'import_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 解析模板描述的是文件格式，属于个人工具，按用户隔离（ADR-0006） */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    fileType: fileTypeEnum('file_type').notNull(),
    version: integer('version').notNull().default(1),
    /** 模板内容，保存前经 zod 严格校验（ADR-0003） */
    definition: jsonb('definition').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('import_templates_user_name_uq').on(t.userId, t.name),
    check('import_templates_version_positive', sql`${t.version} > 0`),
  ],
);
