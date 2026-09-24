/**
 * 流水接口契约（docs/api.md "流水"）
 */
import { z } from 'zod';
import { positiveCentsSchema, yuanInputSchema } from './money.ts';

export const directionSchema = z.enum(['income', 'expense', 'neutral']);
export type Direction = z.infer<typeof directionSchema>;

export const DIRECTION_LABELS: Record<Direction, string> = { income: '收入', expense: '支出', neutral: '中性' };

/** 必须带时区偏移的 ISO 时间，如 2026-09-24T12:30:00+08:00（不接受不带时区的写法） */
const zonedDateTime = z.iso.datetime({ offset: true, message: '时间必须是带时区的 ISO 格式' });
const dateOnly = z.iso.date({ message: '日期格式应为 YYYY-MM-DD' });
const counterparty = z.string().trim().max(100, '交易对方最多 100 个字符');
const note = z.string().trim().max(500, '备注最多 500 个字符');

export const transactionSchema = z
  .object({
    id: z.uuid(),
    direction: directionSchema,
    amountCents: positiveCentsSchema,
    occurredAt: z.string(),
    timePrecision: z.enum(['second', 'day']),
    categoryId: z.uuid().nullable(),
    accountId: z.uuid().nullable(),
    counterparty: z.string(),
    /** 账单中的商品说明 / 摘要（手动记账为空） */
    description: z.string(),
    note: z.string(),
    source: z.enum(['manual', 'import']),
    categorySource: z.enum(['manual', 'user_rule', 'system_rule', 'source_hint', 'none']),
    isRefund: z.boolean(),
    refundOfId: z.uuid().nullable(),
    duplicateOfId: z.uuid().nullable(),
    createdBy: z.uuid().nullable(),
    deletedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();

export const createTransactionRequestSchema = z
  .object({
    direction: directionSchema,
    /** 表单输入的"元"字符串，解析后为分 */
    amount: yuanInputSchema.pipe(positiveCentsSchema),
    occurredAt: zonedDateTime,
    categoryId: z.uuid().nullable().optional(),
    accountId: z.uuid().nullable().optional(),
    counterparty: counterparty.optional(),
    note: note.optional(),
  })
  .strict();

export const updateTransactionRequestSchema = z
  .object({
    direction: directionSchema.optional(),
    amount: yuanInputSchema.pipe(positiveCentsSchema).optional(),
    occurredAt: zonedDateTime.optional(),
    categoryId: z.uuid().nullable().optional(),
    accountId: z.uuid().nullable().optional(),
    counterparty: counterparty.optional(),
    note: note.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, '没有需要修改的内容');

/** 列表查询参数（来自 URL，均为字符串） */
export const transactionQuerySchema = z
  .object({
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, '月份格式应为 YYYY-MM')
      .optional(),
    from: dateOnly.optional(),
    to: dateOnly.optional(),
    direction: directionSchema.optional(),
    categoryId: z.uuid().optional(),
    accountId: z.uuid().optional(),
    q: z.string().trim().max(100).optional(),
    deleted: z.enum(['true', 'false']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine((v) => !(v.month && (v.from || v.to)), 'month 与 from / to 不能同时使用')
  .refine((v) => !(v.from && v.to && v.from > v.to), '开始日期不能晚于结束日期');

export const transactionListSchema = z
  .object({
    items: z.array(transactionSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int(),
    pageSize: z.number().int(),
    /** 当前筛选条件下的合计（口径见 docs/api.md） */
    summary: z.object({ incomeCents: z.number().int(), expenseCents: z.number().int() }).strict(),
  })
  .strict();

export type Transaction = z.infer<typeof transactionSchema>;
export type CreateTransactionRequest = z.input<typeof createTransactionRequestSchema>;
export type UpdateTransactionRequest = z.input<typeof updateTransactionRequestSchema>;
export type TransactionQuery = z.infer<typeof transactionQuerySchema>;
export type TransactionList = z.infer<typeof transactionListSchema>;
