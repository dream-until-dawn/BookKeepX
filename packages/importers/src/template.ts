/**
 * 解析模板的结构定义（ADR-0003）
 *
 * 模板是纯数据（JSON），描述"某种账单文件长什么样、每列什么意思"；通用引擎读取模板来解析文件。
 * 模板里不允许出现可执行代码，也不允许正则（用户自定义模板会成为 ReDoS 入口）：
 * 需要"提取某段文字"的地方一律用占位符（如 "共{n}笔记录"、"姓名：{v}"）。
 */
import { TIME_FORMATS } from '@bookkeepx/contracts';
import { z } from 'zod';

const directionEnum = z.enum(['income', 'expense', 'neutral']);
/** 列名别名列表：任一别名命中即可，兼容平台改版改列名 */
const columnRef = z.array(z.string().min(1)).min(1);

/** 支持的时间格式（定义在 contracts，与前端的自动推断共用） */
export { TIME_FORMATS };

export const templateSchema = z
  .object({
    /** 模板唯一标识，如 "alipay-csv" */
    id: z.string().regex(/^[a-z0-9-]+$/, '模板 id 只能包含小写字母、数字和连字符'),
    /** 格式变更时递增；导入批次记录 id@version 便于追溯 */
    version: z.number().int().positive(),
    name: z.string().min(1),
    /**
     * 来源标识：写入流水的 external_source（单号去重的范围），也是来源分类映射的键。
     * 同一平台的不同文件格式（如将来的微信 csv）应使用同一个来源标识。
     */
    source: z.string().regex(/^[a-z0-9-]+$/),
    fileType: z.enum(['csv', 'xlsx', 'pdf']),
    encoding: z.enum(['auto', 'utf-8', 'gbk']).default('auto'),
    /** 该来源对应的资金账户类型，用于自动推断导入到哪个账户 */
    account: z
      .object({ kind: z.enum(['wechat', 'alipay', 'bank_debit', 'credit_card', 'cash', 'other']) })
      .strict()
      .optional(),

    /** 识别指纹 */
    fingerprint: z
      .object({
        titleKeywords: z.array(z.string()).default([]),
        fileNameKeywords: z.array(z.string()).default([]),
      })
      .strict(),

    /** 表头定位：第一行同时包含全部 required 列名的行即为表头 */
    header: z.object({ required: z.array(z.string()).min(2) }).strict(),

    /** 标准字段 → 列名别名 */
    columns: z
      .object({
        occurredAt: columnRef,
        amount: columnRef.optional(),
        income: columnRef.optional(),
        expense: columnRef.optional(),
        counterparty: columnRef.optional(),
        description: columnRef.optional(),
        externalId: columnRef.optional(),
        paymentMethod: columnRef.optional(),
        categoryHint: columnRef.optional(),
        balance: columnRef.optional(),
        currency: columnRef.optional(),
      })
      .strict(),

    /** 金额与方向：signed 带符号单列 / directionColumn 金额 + 收支列 / split 收入支出分两列 */
    amount: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('signed') }).strict(),
      z
        .object({ mode: z.literal('directionColumn'), column: columnRef, map: z.record(z.string(), directionEnum) })
        .strict(),
      z.object({ mode: z.literal('split') }).strict(),
    ]),

    status: z
      .object({ column: columnRef, skip: z.array(z.string()).default([]) })
      .strict()
      .optional(),

    /** 退款识别与关联（ADR-0004 Q4，P0-1e） */
    refund: z
      .object({
        detect: z
          .object({ statuses: z.array(z.string()).default([]), hintSuffix: z.string().min(1).optional() })
          .strict(),
        link: z.discriminatedUnion('mode', [
          z.object({ mode: z.literal('externalIdPrefix'), separators: z.array(z.string().length(1)).min(1) }).strict(),
          z.object({ mode: z.literal('counterparty') }).strict(),
        ]),
      })
      .strict()
      .optional(),

    /** 0 元交易：error 视为解析错误（默认）；skip 跳过并注明原因 */
    zeroAmount: z.enum(['error', 'skip']).default('error'),

    time: z
      .object({
        format: z.enum(TIME_FORMATS),
        /** 账单中时间所在的时区（平台账单均为北京时间） */
        timezone: z.string().default('Asia/Shanghai'),
      })
      .strict(),

    acceptCurrencies: z.array(z.string()).default([]),
    nullTokens: z.array(z.string()).default(['', '/']),

    /** 从表头之前的说明文字中提取的字段，用 {v} 标记取值位置 */
    preambleFields: z
      .object({
        /** 户主姓名（识别"转给自己"） */
        holderName: z.string().includes('{v}').optional(),
        /** 账号（取末 4 位数字对应银行卡账户） */
        accountNumber: z.string().includes('{v}').optional(),
      })
      .strict()
      .default({}),

    verify: z
      .object({
        balanceChain: z.boolean().default(false),
        summary: z
          .object({
            total: z.string().includes('{n}', { message: 'total 必须包含 {n} 占位符' }).optional(),
            labels: z.partialRecord(directionEnum, z.string()).default({}),
            countIncludesSkipped: z.boolean().default(false),
            amountIncludesSkipped: z.boolean().default(false),
            refundStatuses: z.array(z.string()).default([]),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({ balanceChain: false }),

    pdf: z
      .object({
        wrapTolerance: z.number().positive().default(12),
        headerHeight: z.number().positive().default(30),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if ((t.amount.mode === 'signed' || t.amount.mode === 'directionColumn') && !t.columns.amount)
      ctx.addIssue({ code: 'custom', message: `amount.mode=${t.amount.mode} 时必须配置 columns.amount` });
    if (t.amount.mode === 'split' && !(t.columns.income && t.columns.expense))
      ctx.addIssue({ code: 'custom', message: 'amount.mode=split 时必须同时配置 columns.income 和 columns.expense' });
    if (t.verify.balanceChain && !t.columns.balance)
      ctx.addIssue({ code: 'custom', message: 'verify.balanceChain=true 时必须配置 columns.balance' });
  });

export type ImportTemplate = z.infer<typeof templateSchema>;

/** 加载并校验模板，失败时抛出带字段路径的错误 */
export function loadTemplate(json: unknown): ImportTemplate {
  const r = templateSchema.safeParse(json);
  if (!r.success) {
    throw new Error(
      `模板不合法: ${r.error.issues.map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`).join('; ')}`,
    );
  }
  return r.data;
}
