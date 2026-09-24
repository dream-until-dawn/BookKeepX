/**
 * 解析模板的结构定义（zod schema）
 *
 * 模板是纯数据（JSON），描述"某种账单文件长什么样、每列什么意思"；
 * 通用引擎读取模板来解析文件。模板里不允许出现可执行代码（见 ADR-0003）。
 */
import { z } from 'zod';

const directionEnum = z.enum(['income', 'expense', 'neutral']);

/** 列名别名列表：任一别名命中即可，用于兼容平台改版改列名 */
const columnRef = z.array(z.string().min(1)).min(1);

export const templateSchema = z
  .object({
    /** 模板唯一标识，如 "wechat-xlsx" */
    id: z.string().regex(/^[a-z0-9-]+$/, '模板 id 只能包含小写字母、数字和连字符'),
    /** 模板版本号：格式变更时递增，导入批次记录 id@version 便于追溯 */
    version: z.number().int().positive(),
    name: z.string().min(1),
    fileType: z.enum(['csv', 'xlsx', 'pdf']),
    /** csv 编码；auto = 合法 UTF-8 用 UTF-8，否则 GBK */
    encoding: z.enum(['auto', 'utf-8', 'gbk']).default('auto'),

    /** 识别指纹：自动选择模板时使用 */
    fingerprint: z.object({
      /** 表头之前的文字里应出现的关键词 */
      titleKeywords: z.array(z.string()).default([]),
      /** 文件名关键词（仅加分，不作为必要条件）。不用正则：用户自定义模板若允许正则，存在 ReDoS 风险 */
      fileNameKeywords: z.array(z.string()).default([]),
    }),

    /** 表头定位：第一行同时包含全部 required 列名的行即为表头 */
    header: z.object({ required: z.array(z.string()).min(2) }),

    /** 标准字段 → 列名别名 */
    columns: z.object({
      occurredAt: columnRef,
      amount: columnRef.optional(),
      income: columnRef.optional(), // amount.mode = split 时的收入列
      expense: columnRef.optional(), // amount.mode = split 时的支出列
      counterparty: columnRef.optional(),
      description: columnRef.optional(),
      externalId: columnRef.optional(),
      paymentMethod: columnRef.optional(),
      categoryHint: columnRef.optional(), // 平台自带的分类（如支付宝"交易分类"），作为分类建议
      balance: columnRef.optional(),
      currency: columnRef.optional(),
    }),

    /**
     * 金额与方向的表达方式：
     *   signed          —— 单列带符号，正=收入，负=支出（银行常见）
     *   directionColumn —— 金额列恒正，另有一列写"收入/支出"（微信、支付宝）
     *   split           —— 收入、支出分两列（部分银行）
     */
    amount: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('signed') }),
      z.object({ mode: z.literal('directionColumn'), column: columnRef, map: z.record(z.string(), directionEnum) }),
      z.object({ mode: z.literal('split') }),
    ]),

    /** 按状态跳过的记录（如"交易关闭"） */
    status: z.object({ column: columnRef, skip: z.array(z.string()).default([]) }).optional(),

    /** 时间格式（仅文本单元格使用；Excel 日期单元格按墙上时间还原） */
    time: z.object({
      format: z.enum(['yyyy-MM-dd HH:mm:ss', 'yyyy-MM-dd', 'yyyy/MM/dd HH:mm:ss', 'yyyy/MM/dd']),
      timezone: z.string().default('Asia/Shanghai'),
    }),

    /** 0 元交易的处理：error = 视为解析错误（默认）；skip = 跳过并记录原因（支付宝有全额优惠、医保全额支付等 0 元记录） */
    zeroAmount: z.enum(['error', 'skip']).default('error'),

    /** 允许的币种；为空表示不校验 */
    acceptCurrencies: z.array(z.string()).default([]),

    /**
     * 从表头之前的说明文字中提取的字段，用 {v} 标记取值位置（取到行尾或空白为止）。
     * 目前用于提取户主姓名：对方是户主本人的转账，是"自己账户间转账"，不应计入收支。
     */
    preambleFields: z.object({ holderName: z.string().includes('{v}').optional() }).strict().default({}),

    /** 视为空值的记号 */
    nullTokens: z.array(z.string()).default(['', '/']),

    /** 自校验配置 */
    verify: z
      .object({
        balanceChain: z.boolean().default(false),
        summary: z
          .object({
            /** 总笔数所在文字，用 {n} 标记数字位置，如 "共{n}笔记录"。同样不用正则 */
            total: z.string().includes('{n}', { message: 'total 必须包含 {n} 占位符' }).optional(),
            /** 方向 → 汇总行标签，引擎按 "标签：N笔 X元" 提取 */
            labels: z.partialRecord(directionEnum, z.string()).default({}),
            /** 跳过的记录（0 元、状态过滤）是否仍计入汇总笔数（支付宝实测：是） */
            countIncludesSkipped: z.boolean().default(false),
            /** 跳过的记录是否仍计入汇总金额（支付宝实测：是，"交易关闭"也计入） */
            amountIncludesSkipped: z.boolean().default(false),
            /** 这些状态的记录金额会从支出汇总中扣除（支付宝实测："退款成功"） */
            refundStatuses: z.array(z.string()).default([]),
          })
          .optional(),
      })
      .default({ balanceChain: false }),

    /** PDF 专用配置 */
    pdf: z
      .object({
        /** 同一条记录的折行文字与锚点行的最大竖直距离（pt） */
        wrapTolerance: z.number().positive().default(12),
        /** 表头区域高度（pt）：双语表头会占多行，这个区域内的文字不当作数据 */
        headerHeight: z.number().positive().default(30),
      })
      .optional(),
  })
  // 严格模式：出现未定义的字段直接报错。用户自定义模板写错字段名（如 fileNamePatern）时能立即发现，而不是被静默忽略
  .strict()
  // 跨字段约束：不同金额模式需要的列必须齐全
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
  if (!r.success) throw new Error(`模板不合法: ${r.error.issues.map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`).join('; ')}`);
  return r.data;
}
