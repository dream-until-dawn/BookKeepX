/**
 * 用户自定义模板（docs/import.md §9）
 *
 * - compileUserTemplate：向导配置（spec）→ 标准模板，经模板 schema 严格校验后与内置模板走同一引擎
 * - inspectFile：读取文件前若干行给向导展示
 * - trialParse：按草稿模板试解析，并判断"保存后能否被自动识别"
 */
import { type Direction, type UserTemplateSpec, userTemplateSpecSchema } from '@bookkeepx/contracts';
import { detect } from './detect.ts';
import { parseTable } from './parse.ts';
import { type Cell, type FileType, readDoc } from './reader.ts';
import { linkRefundsInFile } from './refund.ts';
import { extractTable } from './table.ts';
import { type ImportTemplate, loadTemplate } from './template.ts';

export interface UserTemplateMeta {
  /** 数据库中的模板 id（uuid） */
  id: string;
  name: string;
  version: number;
}

/**
 * 来源标识：微信 / 支付宝沿用内置模板的标识，与内置模板共用单号去重、来源分类映射；
 * 其他来源每个模板独立
 */
export function userTemplateSource(spec: Pick<UserTemplateSpec, 'sourceKind'>, id: string): string {
  return spec.sourceKind === 'wechat' || spec.sourceKind === 'alipay' ? spec.sourceKind : `u-${id}`;
}

/**
 * 微信 / 支付宝"收/支"列的标准取值。向导只能看到样本文件前 200 行出现过的取值，
 * 某些取值（如微信的 "/" 中性交易）可能恰好没出现；编译时补上，用户自己设置的优先。
 * 真实样本发现：用一份没有 "/" 的旧版微信账单建的模板，导入另一份有 "/" 的账单时整份被拒绝。
 */
const PLATFORM_DIRECTIONS: Partial<Record<UserTemplateSpec['sourceKind'], Record<string, Direction>>> = {
  wechat: { 收入: 'income', 支出: 'expense', '/': 'neutral' },
  alipay: { 收入: 'income', 支出: 'expense', 不计收支: 'neutral' },
};

/**
 * 平台默认跳过的状态（与内置模板一致）。同样因为向导只看得到前 200 行：
 * 真实样本中旧版支付宝账单唯一一条"交易关闭"在第 955 条，向导推荐不到。
 * 关联了退款的"交易关闭"原消费仍会恢复入账（refund.ts）。
 */
const PLATFORM_SKIP_STATUSES: Partial<Record<UserTemplateSpec['sourceKind'], string[]>> = {
  alipay: ['交易关闭'],
};

/** 微信 / 支付宝的退款识别规则沿用内置模板（需要映射了相应的列） */
function refundPreset(spec: UserTemplateSpec): ImportTemplate['refund'] {
  if (spec.sourceKind === 'wechat' && spec.columns.categoryHint) {
    return { detect: { statuses: [], hintSuffix: '-退款' }, link: { mode: 'counterparty' } };
  }
  if (spec.sourceKind === 'alipay' && spec.columns.status) {
    return {
      detect: { statuses: ['退款成功'] },
      link: spec.columns.externalId ? { mode: 'externalIdPrefix', separators: ['_', '*'] } : { mode: 'counterparty' },
    };
  }
  return undefined;
}

/**
 * 向导配置 → 标准模板
 * @throws Error spec 或编译结果不合法（带字段说明）
 */
export function compileUserTemplate(specInput: unknown, meta: UserTemplateMeta): ImportTemplate {
  const parsed = userTemplateSpecSchema.safeParse(specInput);
  if (!parsed.success) {
    throw new Error(`模板配置不合法: ${parsed.error.issues.map((i) => i.message).join('；')}`);
  }
  const spec = parsed.data;
  const col = (name: string | undefined) => (name ? [name] : undefined);
  const c = spec.columns;
  return loadTemplate({
    id: meta.id,
    version: meta.version,
    name: meta.name,
    source: userTemplateSource(spec, meta.id),
    fileType: spec.fileType,
    ...(spec.sourceKind === 'other' ? {} : { account: { kind: spec.sourceKind } }),
    fingerprint: { titleKeywords: spec.titleKeywords, fileNameKeywords: spec.fileNameKeywords },
    header: { required: spec.header },
    columns: {
      occurredAt: col(c.occurredAt),
      amount: col(c.amount),
      income: col(c.income),
      expense: col(c.expense),
      counterparty: col(c.counterparty),
      description: col(c.description),
      externalId: col(c.externalId),
      paymentMethod: col(c.paymentMethod),
      categoryHint: col(c.categoryHint),
      balance: col(c.balance),
    },
    amount:
      spec.amountMode === 'directionColumn'
        ? {
            mode: 'directionColumn',
            column: [c.direction!],
            map: { ...PLATFORM_DIRECTIONS[spec.sourceKind], ...spec.directionMap },
          }
        : { mode: spec.amountMode },
    ...(c.status
      ? {
          status: {
            column: [c.status],
            skip: [...new Set([...(PLATFORM_SKIP_STATUSES[spec.sourceKind] ?? []), ...spec.skipStatuses])],
          },
        }
      : {}),
    refund: refundPreset(spec),
    // 用户文件里的 0 元记录（如免单、积分抵扣）跳过并注明，而不是让整份文件报错
    zeroAmount: 'skip',
    time: { format: spec.timeFormat },
    verify: { balanceChain: spec.balanceCheck },
  });
}

// ───────────────────────── 读取样本 ─────────────────────────

/** 向导展示的最大行数与每格最大长度 */
export const INSPECT_ROWS = 200;
const INSPECT_CELL_CHARS = 100;
const pad = (n: number) => String(n).padStart(2, '0');

/** 单元格 → 展示文字；Excel 日期按账单上写的数字输出（与解析时的处理一致，见 parse.ts toWall） */
function cellToText(c: Cell): string {
  if (c instanceof Date) {
    return `${c.getUTCFullYear()}-${pad(c.getUTCMonth() + 1)}-${pad(c.getUTCDate())} ${pad(c.getUTCHours())}:${pad(c.getUTCMinutes())}:${pad(c.getUTCSeconds())}`;
  }
  return String(c ?? '')
    .replace(/\t/g, '')
    .trim()
    .slice(0, INSPECT_CELL_CHARS);
}

export interface InspectResult {
  fileType: FileType;
  rows: string[][];
  totalRows: number;
  suggestedHeaderRow: number | null;
}

/**
 * 推荐表头行：前 60 行中，非空单元格最多（至少 3 个）的第一行，且它的下一行也有至少 3 个非空单元格
 * （说明文字行通常只有一个非空单元格；数据行与表头列数相同，但排在表头之后）
 */
export function suggestHeaderRow(rows: string[][]): number | null {
  const filled = rows.slice(0, 60).map((r) => r.filter((c) => c !== '').length);
  const max = Math.max(0, ...filled);
  if (max < 3) return null;
  const i = filled.findIndex((n, k) => n === max && (filled[k + 1] ?? 0) >= 3);
  return i >= 0 ? i : null;
}

/**
 * 读取文件的前若干行
 * @throws Error 文件损坏 / 无法读取
 */
export async function inspectFile(bytes: Uint8Array): Promise<InspectResult> {
  const doc = await readDoc(bytes);
  if (doc.fileType === 'pdf') return { fileType: 'pdf', rows: [], totalRows: 0, suggestedHeaderRow: null };
  // 去掉每行末尾的空单元格，避免 csv 行尾多余的逗号撑出大量空列
  const rows = doc.grid.slice(0, INSPECT_ROWS).map((r) => {
    const texts = r.map(cellToText);
    while (texts.length > 0 && texts.at(-1) === '') texts.pop();
    return texts;
  });
  return { fileType: doc.fileType, rows, totalRows: doc.grid.length, suggestedHeaderRow: suggestHeaderRow(rows) };
}

// ───────────────────────── 试解析 ─────────────────────────

const SHOW_RECORDS = 20;
const SHOW_ERRORS = 20;

export interface TrialResult {
  headerFound: boolean;
  total: number;
  records: {
    rowLabel: string;
    occurredAt: string;
    direction: 'income' | 'expense' | 'neutral';
    amountCents: number;
    counterparty: string;
    description: string;
    skipReason: string | null;
  }[];
  errors: { row: string; message: string }[];
  errorCount: number;
  issues: { check: string; detail: string }[];
  detect: { score: number; autoSelected: boolean; reason: string | null };
}

/**
 * 按草稿模板试解析文件（不保存任何东西）
 * @param others 与之一起参与识别的其他模板（内置模板 + 该用户的其他模板），用于判断保存后能否被自动识别
 * @throws Error 文件损坏 / 无法读取
 */
export async function trialParse(
  bytes: Uint8Array,
  fileName: string,
  draft: ImportTemplate,
  others: ImportTemplate[],
): Promise<TrialResult> {
  const doc = await readDoc(bytes);
  const table = extractTable(doc, draft);
  const decision = detect(doc, fileName, [...others.filter((t) => t.id !== draft.id), draft]);
  const mine = decision.candidates.find((c) => c.templateId === draft.id);
  const autoSelected = decision.kind === 'auto' && decision.templateId === draft.id;
  let reason: string | null = null;
  if (!autoSelected) {
    const rival = decision.candidates.find((c) => c.templateId !== draft.id);
    if (!table) reason = '找不到表头';
    else if (decision.kind === 'auto') reason = `会被识别为「${rival?.templateName ?? '其他模板'}」`;
    else if (rival && mine && Math.abs(mine.score - rival.score) < 0.2)
      reason = `与「${rival.templateName}」难以区分，上传时需要手动选择`;
    else reason = '匹配度不足（通常是有解析失败的行，或识别关键词不在文件中）';
  }
  const detectInfo = { score: mine?.score ?? 0, autoSelected, reason };
  if (!table)
    return { headerFound: false, total: 0, records: [], errors: [], errorCount: 0, issues: [], detect: detectInfo };

  const file = parseTable(table, draft);
  linkRefundsInFile(file.records, draft);
  return {
    headerFound: true,
    total: file.records.length,
    records: file.records.slice(0, SHOW_RECORDS).map((r) => ({
      rowLabel: r.rowLabel,
      occurredAt: r.occurredAt,
      direction: r.direction,
      amountCents: r.amountCents,
      counterparty: r.counterparty,
      description: r.description,
      skipReason: r.skipReason,
    })),
    errors: file.errors.slice(0, SHOW_ERRORS),
    errorCount: file.errors.length,
    issues: file.issues,
    detect: detectInfo,
  };
}
