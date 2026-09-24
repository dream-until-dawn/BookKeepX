/**
 * 资金账户接口契约（docs/api.md "资金账户"）
 */
import { z } from 'zod';

export const accountKindSchema = z.enum(['wechat', 'alipay', 'bank_debit', 'credit_card', 'cash', 'other']);
export type AccountKind = z.infer<typeof accountKindSchema>;

/** 账户类型的中文名（前端展示用；放在契约里保证各处叫法一致） */
export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  wechat: '微信',
  alipay: '支付宝',
  bank_debit: '储蓄卡',
  credit_card: '信用卡',
  cash: '现金',
  other: '其他',
};

const accountName = z.string().trim().min(1, '请填写账户名称').max(30, '账户名称最多 30 个字符');
const institution = z.string().trim().max(30, '机构名称最多 30 个字符').nullable();
/** 空字符串视为"不填" */
const cardLast4 = z
  .string()
  .trim()
  .transform((s) => (s === '' ? null : s))
  .pipe(
    z
      .string()
      .regex(/^\d{4}$/, '卡号后四位必须是 4 位数字')
      .nullable(),
  )
  .nullable();

export const accountSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    kind: accountKindSchema,
    institution: z.string().nullable(),
    cardLast4: z.string().nullable(),
    sort: z.number().int(),
    archived: z.boolean(),
    /** 引用该账户的流水数；大于 0 时不能删除 */
    transactionCount: z.number().int().nonnegative(),
  })
  .strict();

export const accountListSchema = z.array(accountSchema);

export const createAccountRequestSchema = z
  .object({
    name: accountName,
    kind: accountKindSchema,
    institution: institution.optional(),
    cardLast4: cardLast4.optional(),
  })
  .strict();

export const updateAccountRequestSchema = z
  .object({
    name: accountName.optional(),
    kind: accountKindSchema.optional(),
    institution: institution.optional(),
    cardLast4: cardLast4.optional(),
    archived: z.boolean().optional(),
    sort: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, '没有需要修改的内容');

export type Account = z.infer<typeof accountSchema>;
export type CreateAccountRequest = z.infer<typeof createAccountRequestSchema>;
export type UpdateAccountRequest = z.infer<typeof updateAccountRequestSchema>;
