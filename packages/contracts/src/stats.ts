/** 统计接口契约：金额为整数分，可为负的净支出不得截断。 */
import { z } from 'zod';

const cents = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const nonnegative = cents.refine((n) => n >= 0);
export const statsQuerySchema = z
  .object({
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .refine((m) => m >= '1901-01' && m <= '9998-12', '月份需在 1901-01 至 9998-12 之间'),
  })
  .strict();
export const statsTotalsSchema = z
  .object({
    incomeCents: nonnegative,
    grossExpenseCents: nonnegative,
    refundCents: nonnegative,
    expenseCents: cents,
    balanceCents: cents,
    transactionCount: nonnegative,
  })
  .strict();
export const statsCategorySchema = statsTotalsSchema.extend({
  group: z.enum(['income', 'expense']),
  categoryId: z.uuid().nullable(),
  name: z.string(),
});
export const statsResponseSchema = z
  .object({
    month: z.string(),
    timezone: z.string(),
    summary: statsTotalsSchema,
    categories: z.array(statsCategorySchema),
    daily: z.array(statsTotalsSchema.extend({ date: z.string() })),
    monthly: z.array(statsTotalsSchema.extend({ month: z.string() })),
  })
  .strict();
/** 已校验的统计请求参数。 */
export type StatsQuery = z.infer<typeof statsQuerySchema>;
/** 聚合结果，不含任何原始流水。 */
export type StatsResponse = z.infer<typeof statsResponseSchema>;
/** 共用合计结构。 */
export type StatsTotals = z.infer<typeof statsTotalsSchema>;
