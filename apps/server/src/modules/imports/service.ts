/**
 * 账单导入服务（docs/import.md）
 *
 * 上传 → 解析与自校验 → 生成预览（存入 import_batches.preview）→ 用户确认后提交 → 可整批撤销
 */
import { createHash } from 'node:crypto';
import type { CommitRequest, ImportBatch, ImportRow, UploadResponse } from '@bookkeepx/contracts';
import { BUILTIN_TEMPLATES, type ImportTemplate, parseBill } from '@bookkeepx/importers';
import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db, Tx } from '../../db/client.ts';
import { isUniqueViolation } from '../../db/pg-error.ts';
import { accounts, categories, categoryRules, importBatches, ledgers, transactions } from '../../db/schema/index.ts';
import { AppError } from '../../errors.ts';
import { loadUserTemplates, markUsed, templateNames } from '../import-templates/service.ts';
import type { LedgerScope } from '../ledgers/access.ts';
import { buildPreview, type StoredRow } from './preview.ts';

/** 预览有效期（docs/import.md §2 ⑦） */
export const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
/** 上传大小上限（docs/import.md §7） */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

type BatchRow = typeof importBatches.$inferSelect;
interface StoredPreview {
  rows: StoredRow[];
  /**
   * 来源标识（写入流水的 external_source）：生成预览时从模板取出存下，
   * 提交时不再依赖模板——模板在预览期间被修改或删除也不影响提交（import.md §9.6）。
   * P1-6 时期生成的预览没有这一项，提交时回退到按模板 id 查内置模板。
   */
  source?: string;
}

const notFound = () => new AppError(404, 'IMPORT_NOT_FOUND', '导入记录不存在');

/** 去掉内部字段，只保留接口约定的预览行字段 */
function toApiRow(r: StoredRow): ImportRow {
  return {
    index: r.index,
    rowLabel: r.rowLabel,
    status: r.status,
    reason: r.reason,
    occurredAt: r.occurredAt,
    timePrecision: r.timePrecision,
    direction: r.direction,
    originalDirection: r.originalDirection,
    amountCents: r.amountCents,
    counterparty: r.counterparty,
    description: r.description,
    paymentMethod: r.paymentMethod,
    sourceHint: r.sourceHint,
    categoryId: r.categoryId,
    categorySource: r.categorySource,
    categoryReason: r.categoryReason,
    refund: r.refund,
    crossSource: r.crossSource,
  };
}

async function sameFileImportedBefore(db: Db, scope: LedgerScope, b: BatchRow): Promise<boolean> {
  const [x] = await db
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.ledgerId, scope.ledgerId),
        eq(importBatches.fileSha256, b.fileSha256),
        eq(importBatches.status, 'committed'),
        ne(importBatches.id, b.id),
      ),
    )
    .limit(1);
  return !!x;
}

async function toDto(
  db: Db,
  scope: LedgerScope,
  b: BatchRow,
  withRows: boolean,
  names?: Map<string, string>,
): Promise<ImportBatch> {
  const preview = b.preview as StoredPreview | null;
  const templateName = (names ?? (await templateNames(db, [b.templateId]))).get(b.templateId) ?? b.templateId;
  return {
    id: b.id,
    status: b.status,
    fileName: b.fileName,
    templateId: b.templateId,
    templateName,
    templateVersion: b.templateVersion,
    detectScore: b.detectScore,
    accountId: b.accountId,
    holderName: b.holderName,
    periodStart: b.periodStart,
    periodEnd: b.periodEnd,
    totalRows: b.totalRows,
    importedRows: b.importedRows,
    skippedRows: b.skippedRows,
    duplicateRows: b.duplicateRows,
    sameFileImportedBefore: await sameFileImportedBefore(db, scope, b),
    createdAt: b.createdAt.toISOString(),
    committedAt: b.committedAt?.toISOString() ?? null,
    revertedAt: b.revertedAt?.toISOString() ?? null,
    ...(withRows && preview ? { rows: preview.rows.map(toApiRow) } : {}),
  };
}

/**
 * 确定导入到哪个账户：用户指定的优先；否则按模板的账户类型推断（docs/import.md §5）
 */
async function resolveAccount(
  db: Db,
  scope: LedgerScope,
  t: ImportTemplate,
  requested: string | undefined,
  last4: string | null,
): Promise<string | null> {
  if (requested) {
    const [a] = await db
      .select({ archivedAt: accounts.archivedAt })
      .from(accounts)
      .where(and(eq(accounts.id, requested), eq(accounts.ledgerId, scope.ledgerId)));
    if (!a) throw new AppError(404, 'ACCOUNT_NOT_FOUND', '账户不存在');
    if (a.archivedAt) throw new AppError(400, 'ACCOUNT_ARCHIVED', '该账户已停用');
    return requested;
  }
  if (!t.account) return null;
  const candidates = await db
    .select({ id: accounts.id, last4: accounts.cardLast4 })
    .from(accounts)
    .where(and(eq(accounts.ledgerId, scope.ledgerId), eq(accounts.kind, t.account.kind), isNull(accounts.archivedAt)));
  if (last4) return candidates.find((a) => a.last4 === last4)?.id ?? null;
  return candidates.length === 1 ? candidates[0]!.id : null;
}

export interface UploadInput {
  bytes: Uint8Array;
  /** 当前时间（可注入的时钟）：批次创建时间与预览过期判断用同一个时钟 */
  now: Date;
  fileName: string;
  templateId?: string | undefined;
  accountId?: string | undefined;
}

export async function uploadBill(db: Db, scope: LedgerScope, input: UploadInput): Promise<UploadResponse> {
  if (input.bytes.length === 0) throw new AppError(400, 'IMPORT_EMPTY_FILE', '文件是空的');
  // 内置模板 + 当前用户自己的模板一起参与识别（import.md §9.4）
  const templates = [...BUILTIN_TEMPLATES, ...(await loadUserTemplates(db, scope.userId))];
  if (input.templateId && !templates.some((t) => t.id === input.templateId)) {
    throw new AppError(400, 'IMPORT_TEMPLATE_NOT_FOUND', '所选模板不存在');
  }

  let result: Awaited<ReturnType<typeof parseBill>>;
  try {
    result = await parseBill(input.bytes, input.fileName, { templateId: input.templateId, templates });
  } catch (e) {
    throw new AppError(400, 'IMPORT_UNREADABLE', (e as Error).message);
  }
  if (result.status === 'choose_template') return { status: 'choose_template', candidates: result.candidates };
  if (result.status === 'unsupported') {
    throw new AppError(
      400,
      'IMPORT_UNSUPPORTED',
      '暂不支持这种账单格式（内置支持微信 xlsx、支付宝 csv、招商银行 PDF），可以为它创建自定义模板',
    );
  }

  const { template, file } = result;
  if (file.issues.length > 0) {
    throw new AppError(
      422,
      'IMPORT_VERIFY_FAILED',
      '账单自校验未通过，为避免导入错误数据已停止导入',
      file.issues.slice(0, 50),
    );
  }

  const accountId = await resolveAccount(db, scope, template, input.accountId, file.meta.accountLast4);
  const [ledger] = await db.select({ tz: ledgers.timezone }).from(ledgers).where(eq(ledgers.id, scope.ledgerId));
  const rows = await buildPreview(db, scope, {
    template,
    records: file.records,
    holderName: file.meta.holderName,
    accountId,
    timezone: ledger!.tz,
  });

  const [batch] = await db
    .insert(importBatches)
    .values({
      ledgerId: scope.ledgerId,
      createdBy: scope.userId,
      accountId,
      status: 'previewing',
      createdAt: input.now,
      fileName: input.fileName.slice(0, 255),
      fileSha256: createHash('sha256').update(input.bytes).digest('hex'),
      fileSize: input.bytes.length,
      templateId: template.id,
      templateVersion: template.version,
      detectScore: result.score,
      holderName: file.meta.holderName,
      periodStart: file.meta.periodStart,
      periodEnd: file.meta.periodEnd,
      verifyResult: { ok: true },
      preview: { rows, source: template.source } satisfies StoredPreview,
      totalRows: rows.length,
      skippedRows: rows.filter((r) => r.status === 'skipped').length,
      duplicateRows: rows.filter((r) => r.status === 'duplicate').length,
    })
    .returning();
  if (!BUILTIN_TEMPLATES.some((t) => t.id === template.id)) await markUsed(db, scope.userId, template.id, input.now);
  return { status: 'preview', batch: await toDto(db, scope, batch!, true) };
}

async function getBatchRow(db: Db | Tx, scope: LedgerScope, id: string): Promise<BatchRow> {
  const [b] = await db
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.id, id), eq(importBatches.ledgerId, scope.ledgerId)))
    .limit(1);
  if (!b) throw notFound();
  return b;
}

/** 预览中的批次；已过期的就地标记为 expired 并报错 */
async function getPreviewing(
  db: Db,
  scope: LedgerScope,
  id: string,
  now: Date,
): Promise<BatchRow & { preview: StoredPreview }> {
  const b = await getBatchRow(db, scope, id);
  if (b.status !== 'previewing') throw new AppError(409, 'IMPORT_NOT_PREVIEWING', '该导入已提交、撤销或过期');
  if (now.getTime() - b.createdAt.getTime() > PREVIEW_TTL_MS) {
    await db.update(importBatches).set({ status: 'expired', preview: null }).where(eq(importBatches.id, id));
    throw new AppError(410, 'IMPORT_EXPIRED', '预览已过期，请重新上传');
  }
  return b as BatchRow & { preview: StoredPreview };
}

export async function getBatch(db: Db, scope: LedgerScope, id: string): Promise<ImportBatch> {
  const b = await getBatchRow(db, scope, id);
  return toDto(db, scope, b, b.status === 'previewing');
}

export async function listBatches(db: Db, scope: LedgerScope): Promise<ImportBatch[]> {
  const rows = await db
    .select()
    .from(importBatches)
    .where(eq(importBatches.ledgerId, scope.ledgerId))
    .orderBy(desc(importBatches.createdAt))
    .limit(100);
  const names = await templateNames(
    db,
    rows.map((b) => b.templateId),
  );
  return Promise.all(rows.map((b) => toDto(db, scope, b, false, names)));
}

export async function discardBatch(db: Db, scope: LedgerScope, id: string, now: Date): Promise<void> {
  await getPreviewing(db, scope, id, now);
  await db.update(importBatches).set({ status: 'expired', preview: null }).where(eq(importBatches.id, id));
}

/** 提交：一个事务内写入全部流水、建立退款与跨来源重复关联、更新批次状态 */
export async function commitBatch(
  db: Db,
  scope: LedgerScope,
  id: string,
  req: Required<Pick<CommitRequest, 'overrides'>>,
  now: Date,
): Promise<ImportBatch> {
  const batch = await getPreviewing(db, scope, id, now);
  const rows = batch.preview.rows.map((r) => ({ ...r, include: r.status === 'new' }));
  const byIndex = new Map(rows.map((r) => [r.index, r]));

  // 用户在预览中的修改
  const cats = await db
    .select({ id: categories.id, group: categories.group, hidden: categories.hidden })
    .from(categories)
    .where(eq(categories.ledgerId, scope.ledgerId));
  for (const o of req.overrides) {
    const row = byIndex.get(o.index);
    if (!row) throw new AppError(400, 'IMPORT_ROW_NOT_FOUND', `第 ${o.index} 行不存在`);
    if (o.include !== undefined) {
      if (o.include && row.status !== 'new')
        throw new AppError(400, 'IMPORT_ROW_NOT_INCLUDABLE', `${row.rowLabel}：${row.reason}，不能导入`);
      row.include = o.include;
    }
    if (o.categoryId !== undefined) {
      if (o.categoryId) {
        const c = cats.find((x) => x.id === o.categoryId);
        if (!c) throw new AppError(404, 'CATEGORY_NOT_FOUND', '分类不存在');
        if (c.group !== row.direction)
          throw new AppError(400, 'CATEGORY_DIRECTION_MISMATCH', `${row.rowLabel}：分类与收支类型不一致`);
        if (c.hidden) throw new AppError(400, 'CATEGORY_HIDDEN', '该分类已隐藏，不能再选择');
      }
      row.categoryId = o.categoryId;
      row.categorySource = o.categoryId ? 'manual' : 'none';
      row.categoryRuleId = null;
    }
  }

  const source = batch.preview.source ?? BUILTIN_TEMPLATES.find((t) => t.id === batch.templateId)!.source;
  const included = rows.filter((r) => r.include);

  try {
    await db.transaction(async (tx) => {
      const idByIndex = new Map<number, string>();
      // 先写原消费、后写退款：退款的 refund_of_id 可能指向同一批中的行
      const ordered = [...included.filter((r) => !r.isRefund), ...included.filter((r) => r.isRefund)];
      for (const r of ordered) {
        // 优先关联本批次新写入的原消费；原消费之前已导入过时，关联库中已有的那条
        const refundOfId = r.refundOf
          ? ((r.refundOf.index !== null ? idByIndex.get(r.refundOf.index) : undefined) ?? r.refundOf.transactionId)
          : null;
        const [t] = await tx
          .insert(transactions)
          .values({
            ledgerId: scope.ledgerId,
            createdBy: scope.userId,
            accountId: batch.accountId,
            categoryId: r.categoryId,
            categorySource: r.categoryId ? r.categorySource : 'none',
            categoryRuleId: r.categorySource === 'user_rule' ? r.categoryRuleId : null,
            direction: r.direction,
            amountCents: r.amountCents,
            occurredAt: new Date(r.occurredAt),
            timePrecision: r.timePrecision,
            counterparty: r.counterparty,
            description: r.description,
            source: 'import',
            importBatchId: batch.id,
            externalSource: r.externalId ? source : null,
            externalId: r.externalId,
            dedupeKey: r.dedupeKey,
            balanceAfterCents: r.balanceCents,
            paymentMethod: r.paymentMethod,
            sourceCategory: r.sourceHint,
            raw: r.raw,
            isRefund: r.isRefund,
            refundOfId,
            duplicateOfId: r.duplicateOfTransactionId,
          })
          .returning({ id: transactions.id });
        idByIndex.set(r.index, t!.id);
      }
      // 平台记录入库后，把之前导入的同一笔银行记录标记为重复（不计入统计）
      for (const r of included) {
        if (!r.bankTransactionIdToMark) continue;
        await tx
          .update(transactions)
          .set({ duplicateOfId: idByIndex.get(r.index)! })
          .where(
            and(
              eq(transactions.id, r.bankTransactionIdToMark),
              eq(transactions.ledgerId, scope.ledgerId),
              isNull(transactions.duplicateOfId),
            ),
          );
      }
      // 用户规则命中次数（便于用户清理没用的规则）
      const ruleHits = new Map<string, number>();
      for (const r of included)
        if (r.categoryRuleId) ruleHits.set(r.categoryRuleId, (ruleHits.get(r.categoryRuleId) ?? 0) + 1);
      for (const [ruleId, n] of ruleHits) {
        await tx
          .update(categoryRules)
          .set({ hitCount: sql`${categoryRules.hitCount} + ${n}`, lastHitAt: now })
          .where(and(eq(categoryRules.id, ruleId), eq(categoryRules.ledgerId, scope.ledgerId)));
      }
      await tx
        .update(importBatches)
        .set({ status: 'committed', committedAt: now, importedRows: included.length, preview: null })
        .where(eq(importBatches.id, batch.id));
    });
  } catch (err) {
    // 预览之后、提交之前，同一批记录已被另一次导入写入
    if (isUniqueViolation(err, 'transactions_external_uq')) {
      throw new AppError(409, 'IMPORT_CONFLICT', '部分记录已被另一次导入写入，请重新上传以刷新预览');
    }
    throw err;
  }
  return getBatch(db, scope, id);
}

/** 整批撤销：删除该批次写入的全部流水；其他批次对它们的退款 / 重复引用先解除 */
export async function revertBatch(db: Db, scope: LedgerScope, id: string, now: Date): Promise<ImportBatch> {
  const b = await getBatchRow(db, scope, id);
  if (b.status !== 'committed') throw new AppError(409, 'IMPORT_NOT_COMMITTED', '只有已提交的导入可以撤销');
  await db.transaction(async (tx) => {
    const own = tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.ledgerId, scope.ledgerId), eq(transactions.importBatchId, id)));
    const outside = and(
      eq(transactions.ledgerId, scope.ledgerId),
      or(isNull(transactions.importBatchId), ne(transactions.importBatchId, id)),
    );
    await tx
      .update(transactions)
      .set({ refundOfId: null })
      .where(and(outside, inArray(transactions.refundOfId, own)));
    await tx
      .update(transactions)
      .set({ duplicateOfId: null })
      .where(and(outside, inArray(transactions.duplicateOfId, own)));
    // 批次内部的引用在同一条删除语句中一并删除，外键在语句结束时检查
    await tx
      .delete(transactions)
      .where(and(eq(transactions.ledgerId, scope.ledgerId), eq(transactions.importBatchId, id)));
    await tx.update(importBatches).set({ status: 'reverted', revertedAt: now }).where(eq(importBatches.id, id));
  });
  return getBatch(db, scope, id);
}
