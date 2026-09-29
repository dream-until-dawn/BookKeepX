/**
 * 自定义解析模板接口契约（docs/import.md §9）
 *
 * 用户模板在库中保存的是"向导配置"（spec），服务端加载时编译为标准模板（ADR-0003 调整）。
 * spec 只覆盖模板能力的一个子集：列映射、金额方式、收支取值、时间格式、识别关键词、可选的余额校验。
 */
import { z } from 'zod';
import { directionSchema } from './transactions.ts';

/**
 * 支持的时间格式及其匹配规则（引擎解析与前端自动推断共用，保证两边一致）
 * - 前四种是严格格式：月、日、时、分、秒都是两位
 * - 后两种是宽松格式：月、日、时可以不补零，秒可以省略（如旧版支付宝的 "2021/12/31 8:54"）
 * 捕获组依次为：年、月、日、时、分、秒（只有日期的格式没有后三组）
 */
export const TIME_FORMAT_PATTERNS = {
  'yyyy-MM-dd HH:mm:ss': /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/,
  'yyyy-MM-dd': /^(\d{4})-(\d{2})-(\d{2})$/,
  'yyyy/MM/dd HH:mm:ss': /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/,
  'yyyy/MM/dd': /^(\d{4})\/(\d{2})\/(\d{2})$/,
  'yyyy-M-d H:mm': /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  'yyyy/M/d H:mm': /^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/,
} as const;

export type TimeFormat = keyof typeof TIME_FORMAT_PATTERNS;
export const TIME_FORMATS = Object.keys(TIME_FORMAT_PATTERNS) as [TimeFormat, ...TimeFormat[]];
export const timeFormatSchema = z.enum(TIME_FORMATS);

/**
 * 从样本值推断时间格式：返回能匹配全部非空样本的第一个格式（严格格式优先）；都不匹配时返回 null
 */
export function guessTimeFormat(samples: string[]): TimeFormat | null {
  const values = samples.map((s) => s.trim()).filter(Boolean);
  if (values.length === 0) return null;
  return TIME_FORMATS.find((f) => values.every((v) => TIME_FORMAT_PATTERNS[f].test(v))) ?? null;
}

/** 账单来源（决定来源标识、默认账户类型；微信 / 支付宝沿用内置规则） */
export const templateSourceKindSchema = z.enum(['wechat', 'alipay', 'bank_debit', 'credit_card', 'other']);
export type TemplateSourceKind = z.infer<typeof templateSourceKindSchema>;
export const TEMPLATE_SOURCE_KIND_LABELS: Record<TemplateSourceKind, string> = {
  wechat: '微信',
  alipay: '支付宝',
  bank_debit: '银行储蓄卡',
  credit_card: '信用卡',
  other: '其他',
};

/** 可映射的字段（列 → 字段） */
export const TEMPLATE_FIELDS = [
  'occurredAt',
  'amount',
  'direction',
  'income',
  'expense',
  'counterparty',
  'description',
  'externalId',
  'paymentMethod',
  'categoryHint',
  'balance',
  'status',
] as const;
export type TemplateField = (typeof TEMPLATE_FIELDS)[number];
export const TEMPLATE_FIELD_LABELS: Record<TemplateField, string> = {
  occurredAt: '交易时间',
  amount: '金额',
  direction: '收/支',
  income: '收入金额',
  expense: '支出金额',
  counterparty: '交易对方',
  description: '商品 / 说明',
  externalId: '交易单号',
  paymentMethod: '支付方式',
  categoryHint: '原分类 / 交易类型',
  balance: '余额',
  status: '交易状态',
};

const columnName = z.string().trim().min(1).max(100);
const keyword = z.string().trim().min(1).max(50);

export const userTemplateSpecSchema = z
  .object({
    fileType: z.enum(['csv', 'xlsx']),
    sourceKind: templateSourceKindSchema,
    /** 表头行的全部列名（识别时作为必需列） */
    header: z.array(columnName).min(2).max(60),
    /** 字段 → 列名；列名必须出现在 header 中 */
    columns: z.partialRecord(z.enum(TEMPLATE_FIELDS), columnName),
    /** signed：带符号单列（负数为支出）/ directionColumn：金额 + 收支列 / split：收入、支出分两列 */
    amountMode: z.enum(['signed', 'directionColumn', 'split']),
    /** 收支列的取值 → 方向（amountMode=directionColumn 时必填） */
    directionMap: z.record(z.string().max(50), directionSchema).default({}),
    /** 状态列中需要跳过的取值 */
    skipStatuses: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
    timeFormat: timeFormatSchema,
    titleKeywords: z.array(keyword).max(5).default([]),
    fileNameKeywords: z.array(keyword).max(5).default([]),
    /** 余额连续性校验（需映射余额列） */
    balanceCheck: z.boolean().default(false),
  })
  .strict()
  .superRefine((s, ctx) => {
    const issue = (message: string, path: (string | number)[]) => ctx.addIssue({ code: 'custom', message, path });
    if (new Set(s.header).size !== s.header.length) issue('表头中有重复的列名', ['header']);
    for (const [field, col] of Object.entries(s.columns)) {
      if (!s.header.includes(col)) issue(`列「${col}」不在表头中`, ['columns', field]);
    }
    const used = Object.values(s.columns);
    if (new Set(used).size !== used.length) issue('同一列不能对应多个字段', ['columns']);
    if (!s.columns.occurredAt) issue('必须指定交易时间列', ['columns', 'occurredAt']);
    if (s.amountMode === 'split') {
      if (!s.columns.income || !s.columns.expense) issue('请指定收入金额列和支出金额列', ['columns']);
    } else if (!s.columns.amount) {
      issue('请指定金额列', ['columns', 'amount']);
    }
    if (s.amountMode === 'directionColumn') {
      if (!s.columns.direction) issue('请指定收/支列', ['columns', 'direction']);
      if (Object.keys(s.directionMap).length === 0) issue('请设置收/支列各取值对应的方向', ['directionMap']);
    }
    if (s.balanceCheck && !s.columns.balance) issue('开启余额校验需要指定余额列', ['balanceCheck']);
    if (s.skipStatuses.length > 0 && !s.columns.status) issue('设置了跳过的状态，但没有指定状态列', ['skipStatuses']);
  });

export type UserTemplateSpec = z.infer<typeof userTemplateSpecSchema>;
export type UserTemplateSpecInput = z.input<typeof userTemplateSpecSchema>;

const templateName = z.string().trim().min(1, '请填写模板名称').max(50);

export const userTemplateSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    fileType: z.enum(['csv', 'xlsx']),
    version: z.number().int().positive(),
    spec: userTemplateSpecSchema,
    lastUsedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export const userTemplateListSchema = z.array(userTemplateSchema);

export const createUserTemplateRequestSchema = z.object({ name: templateName, spec: userTemplateSpecSchema }).strict();
export const updateUserTemplateRequestSchema = z
  .object({ name: templateName.optional(), spec: userTemplateSpecSchema.optional() })
  .strict()
  .refine((b) => b.name !== undefined || b.spec !== undefined, { message: '没有要修改的内容' });

/** 读取文件样本：前若干行的单元格文字，供向导点选表头、给列选字段 */
export const inspectResponseSchema = z
  .object({
    fileType: z.enum(['csv', 'xlsx', 'pdf']),
    rows: z.array(z.array(z.string())),
    /** 文件总行数（rows 只是前若干行） */
    totalRows: z.number().int().nonnegative(),
    /** 推荐的表头行（rows 中的下标）；找不到时为 null */
    suggestedHeaderRow: z.number().int().nonnegative().nullable(),
  })
  .strict();

/** 试解析结果 */
export const templateTestResponseSchema = z
  .object({
    /** 表头是否找到 */
    headerFound: z.boolean(),
    total: z.number().int().nonnegative(),
    /** 前若干条解析结果 */
    records: z.array(
      z
        .object({
          rowLabel: z.string(),
          occurredAt: z.string(),
          direction: directionSchema,
          amountCents: z.number().int().nonnegative(),
          counterparty: z.string(),
          description: z.string(),
          skipReason: z.string().nullable(),
        })
        .strict(),
    ),
    /** 解析失败的行（前若干条） */
    errors: z.array(z.object({ row: z.string(), message: z.string() }).strict()),
    errorCount: z.number().int().nonnegative(),
    /** 自校验问题 */
    issues: z.array(z.object({ check: z.string(), detail: z.string() }).strict()),
    /** 保存后，下次上传这个文件能否被自动识别；不能时给出原因 */
    detect: z.object({ score: z.number(), autoSelected: z.boolean(), reason: z.string().nullable() }).strict(),
  })
  .strict();

export type UserTemplate = z.infer<typeof userTemplateSchema>;
export type CreateUserTemplateRequest = z.input<typeof createUserTemplateRequestSchema>;
export type UpdateUserTemplateRequest = z.input<typeof updateUserTemplateRequestSchema>;
export type InspectResponse = z.infer<typeof inspectResponseSchema>;
export type TemplateTestResponse = z.infer<typeof templateTestResponseSchema>;
