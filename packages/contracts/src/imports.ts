/**
 * 账单导入接口契约（docs/import.md）
 */
import { z } from 'zod';
import { directionSchema } from './transactions.ts';

/**
 * 预览中的一行
 *   status：new 新记录（默认导入）/ duplicate 已导入过（不导入）/ skipped 账单中按规则跳过（只展示）
 */
export const importRowSchema = z
  .object({
    index: z.number().int().nonnegative(),
    rowLabel: z.string(),
    status: z.enum(['new', 'duplicate', 'skipped']),
    /** 跳过 / 重复的原因 */
    reason: z.string().nullable(),
    occurredAt: z.string(),
    timePrecision: z.enum(['second', 'day']),
    /** 分类后的方向（规则可能把方向改为中性） */
    direction: directionSchema,
    /** 账单上的原始方向 */
    originalDirection: directionSchema,
    amountCents: z.number().int().nonnegative(),
    counterparty: z.string(),
    description: z.string(),
    paymentMethod: z.string().nullable(),
    sourceHint: z.string().nullable(),
    categoryId: z.uuid().nullable(),
    categorySource: z.enum(['manual', 'user_rule', 'system_rule', 'source_hint', 'none']),
    /** 分类原因，如规则名"地铁公交"或"来源分类「餐饮美食」" */
    categoryReason: z.string().nullable(),
    /** 退款：是否找到原消费 */
    refund: z.object({ linked: z.boolean() }).strict().nullable(),
    /** 跨来源重复：导入后不计入统计的银行记录，或会让已有银行记录不计入统计的平台记录 */
    crossSource: z.enum(['bank_side', 'platform_side']).nullable(),
  })
  .strict();

export const importBatchSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(['previewing', 'committed', 'reverted', 'expired']),
    fileName: z.string(),
    templateId: z.string(),
    templateName: z.string(),
    templateVersion: z.number().int(),
    detectScore: z.number(),
    accountId: z.uuid().nullable(),
    holderName: z.string().nullable(),
    periodStart: z.string().nullable(),
    periodEnd: z.string().nullable(),
    totalRows: z.number().int(),
    importedRows: z.number().int(),
    skippedRows: z.number().int(),
    duplicateRows: z.number().int(),
    /** 同一文件之前已经提交导入过 */
    sameFileImportedBefore: z.boolean(),
    createdAt: z.string(),
    committedAt: z.string().nullable(),
    revertedAt: z.string().nullable(),
    /** 仅预览中的批次返回 */
    rows: z.array(importRowSchema).optional(),
  })
  .strict();

export const importBatchListSchema = z.array(importBatchSchema);

export const templateCandidateSchema = z
  .object({ templateId: z.string(), templateName: z.string(), score: z.number() })
  .strict();

export const uploadResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('preview'), batch: importBatchSchema }).strict(),
  z.object({ status: z.literal('choose_template'), candidates: z.array(templateCandidateSchema) }).strict(),
]);

export const commitRequestSchema = z
  .object({
    /** 用户在预览中的修改：改分类（null = 未分类）、取消勾选 */
    overrides: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            categoryId: z.uuid().nullable().optional(),
            include: z.boolean().optional(),
          })
          .strict(),
      )
      .max(10_000)
      .default([]),
  })
  .strict();

/** 校验失败时错误响应中附带的问题列表 */
export const verifyIssueSchema = z.object({ check: z.string(), detail: z.string() }).strict();

export type ImportRow = z.infer<typeof importRowSchema>;
export type ImportBatch = z.infer<typeof importBatchSchema>;
export type UploadResponse = z.infer<typeof uploadResponseSchema>;
export type CommitRequest = z.input<typeof commitRequestSchema>;
export type VerifyIssueDto = z.infer<typeof verifyIssueSchema>;
