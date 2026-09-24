/**
 * 自定义模板向导的纯函数（便于单独测试）：从文件样本推荐列映射、收支取值、识别关键词，
 * 以及向导状态 ↔ 模板配置（spec）的相互转换。
 */
import {
  type Direction,
  guessTimeFormat,
  type TemplateField,
  type TemplateSourceKind,
  type TimeFormat,
  type UserTemplateSpec,
  type UserTemplateSpecInput,
} from '@bookkeepx/contracts';

export type AmountMode = UserTemplateSpec['amountMode'];

export interface WizardState {
  /** 表头所在行（样本中的下标） */
  headerRow: number | null;
  /** 列名 → 字段（'' 表示不使用这一列） */
  mapping: Record<string, TemplateField | ''>;
  amountMode: AmountMode;
  /** 收支列的取值 → 方向（'' 表示还没选） */
  directionMap: Record<string, Direction | ''>;
  skipStatuses: string[];
  sourceKind: TemplateSourceKind;
  timeFormat: TimeFormat | '';
  /** 逗号分隔的关键词（输入框原文） */
  titleKeywords: string;
  fileNameKeywords: string;
  balanceCheck: boolean;
}

/** 表头行的列名（去掉空列） */
export function headerOf(rows: string[][], headerRow: number | null): string[] {
  if (headerRow === null) return [];
  return (rows[headerRow] ?? []).map((c) => c.trim()).filter(Boolean);
}

/** 表头之下某一列的取值（跳过空行） */
export function columnValues(rows: string[][], headerRow: number | null, column: string): string[] {
  if (headerRow === null) return [];
  const i = (rows[headerRow] ?? []).findIndex((c) => c.trim() === column);
  if (i < 0) return [];
  return rows
    .slice(headerRow + 1)
    .filter((r) => r.some((c) => c !== ''))
    .map((r) => (r[i] ?? '').trim());
}

/** 去重后的非空取值（保持首次出现的顺序） */
export function distinctValues(values: string[], limit = 20): string[] {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

/**
 * 按列名关键词推荐字段；按顺序匹配，靠前的规则优先；每个字段只分配给第一个匹配的列
 * 例如"交易时间"→ 时间、"收/支"→ 收支、"金额(元)"→ 金额、"交易单号"→ 单号（"商户单号"不再分配）
 */
const FIELD_RULES: [TemplateField, string[]][] = [
  ['occurredAt', ['时间', '日期']],
  ['direction', ['收/支', '收支', '借贷']],
  ['income', ['收入金额', '收入', '存入', '贷方金额']],
  ['expense', ['支出金额', '支出', '取出', '借方金额']],
  ['balance', ['余额']],
  ['amount', ['金额']],
  ['counterparty', ['对方', '对手']],
  ['externalId', ['交易单号', '订单号', '流水号', '单号']],
  ['paymentMethod', ['支付方式', '付款方式', '收/付款方式']],
  ['status', ['状态']],
  ['categoryHint', ['分类', '类型']],
  ['description', ['商品', '说明', '摘要', '用途', '备注']],
];

export function guessMapping(header: string[]): Record<string, TemplateField | ''> {
  const mapping: Record<string, TemplateField | ''> = Object.fromEntries(header.map((h) => [h, '']));
  for (const [field, words] of FIELD_RULES) {
    // 已分配过字段的列不再参与，保证一列只对应一个字段
    const col = header.find((h) => mapping[h] === '' && words.some((w) => h.includes(w)));
    if (col) mapping[col] = field;
  }
  return mapping;
}

/** 反查：字段 → 列名 */
export function columnsOf(mapping: Record<string, TemplateField | ''>): Partial<Record<TemplateField, string>> {
  const out: Partial<Record<TemplateField, string>> = {};
  for (const [col, field] of Object.entries(mapping)) if (field) out[field] = col;
  return out;
}

export function suggestAmountMode(mapping: Record<string, TemplateField | ''>): AmountMode {
  const c = columnsOf(mapping);
  if (c.income && c.expense) return 'split';
  if (c.direction) return 'directionColumn';
  return 'signed';
}

/** 收支列常见取值的默认方向；认不出的留空让用户选 */
export function guessDirection(value: string): Direction | '' {
  const v = value.trim();
  if (['收入', '收', '入账', '存入', '贷'].includes(v)) return 'income';
  if (['支出', '支', '出账', '取出', '借'].includes(v)) return 'expense';
  if (['不计收支', '中性', '中性交易', '/'].includes(v)) return 'neutral';
  return '';
}

/** 状态列中通常应跳过的取值 */
const SKIP_STATUS_WORDS = ['关闭', '失败', '撤销', '已退回'];
export const guessSkipStatuses = (values: string[]) =>
  values.filter((v) => SKIP_STATUS_WORDS.some((w) => v.includes(w)));

/** 识别关键词：表头之前第一行非空的说明文字（如"微信支付账单明细"），太长的截断 */
export function suggestTitleKeyword(rows: string[][], headerRow: number | null): string {
  if (headerRow === null) return '';
  for (const r of rows.slice(0, headerRow)) {
    const text = r.find((c) => c.trim())?.trim();
    // 分隔线、纯数字、带冒号的"字段：值"（如户名、账号，属于个人信息，不适合做关键词）都跳过
    if (text && !/^[-=\s]+$/.test(text) && !/^[\d\s.:/-]+$/.test(text) && !/[：:]/.test(text)) {
      return text.replace(/^[-=\s]+|[-=\s]+$/g, '').slice(0, 30);
    }
  }
  return '';
}

/** 选定表头行后，按样本推荐整套配置 */
export function initialState(rows: string[][], headerRow: number | null, fileName: string): WizardState {
  const header = headerOf(rows, headerRow);
  const mapping = guessMapping(header);
  const c = columnsOf(mapping);
  const dirValues = c.direction ? distinctValues(columnValues(rows, headerRow, c.direction)) : [];
  const statusValues = c.status ? distinctValues(columnValues(rows, headerRow, c.status)) : [];
  const times = c.occurredAt ? columnValues(rows, headerRow, c.occurredAt) : [];
  return {
    headerRow,
    mapping,
    amountMode: suggestAmountMode(mapping),
    directionMap: Object.fromEntries(dirValues.map((v) => [v, guessDirection(v)])),
    skipStatuses: guessSkipStatuses(statusValues),
    sourceKind: /微信/.test(fileName) ? 'wechat' : /支付宝|alipay/i.test(fileName) ? 'alipay' : 'bank_debit',
    timeFormat: guessTimeFormat(times) ?? '',
    titleKeywords: suggestTitleKeyword(rows, headerRow),
    fileNameKeywords: '',
    balanceCheck: false,
  };
}

const splitKeywords = (s: string) =>
  s
    .split(/[,，、]/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * 向导状态 → 模板配置
 * 只带入与金额方式相关的列：例如选了"收入、支出分两列"，"金额"列即使被标记也不带入，避免配置互相矛盾
 */
export function toSpec(state: WizardState, rows: string[][], fileType: 'csv' | 'xlsx'): UserTemplateSpecInput {
  const all = columnsOf(state.mapping);
  const { amount, income, expense, direction, ...rest } = all;
  const amountCols =
    state.amountMode === 'split'
      ? { income, expense }
      : state.amountMode === 'directionColumn'
        ? { amount, direction }
        : { amount };
  const columns = Object.fromEntries(
    Object.entries({ ...rest, ...amountCols }).filter(([, v]) => v !== undefined),
  ) as UserTemplateSpecInput['columns'];
  return {
    fileType,
    sourceKind: state.sourceKind,
    header: headerOf(rows, state.headerRow),
    columns,
    amountMode: state.amountMode,
    directionMap:
      state.amountMode === 'directionColumn'
        ? (Object.fromEntries(Object.entries(state.directionMap).filter(([, d]) => d !== '')) as Record<
            string,
            Direction
          >)
        : {},
    skipStatuses: all.status ? state.skipStatuses : [],
    timeFormat: (state.timeFormat || undefined) as TimeFormat,
    titleKeywords: splitKeywords(state.titleKeywords),
    fileNameKeywords: splitKeywords(state.fileNameKeywords),
    balanceCheck: !!all.balance && state.balanceCheck,
  };
}

/** 修改已有模板：把配置还原为向导状态；表头行按列名在新样本中查找，找不到时为 null */
export function fromSpec(spec: UserTemplateSpec, rows: string[][]): WizardState {
  const key = spec.header.join('\u0000');
  const found = rows.findIndex(
    (r) =>
      r
        .map((c) => c.trim())
        .filter(Boolean)
        .join('\u0000') === key,
  );
  const mapping: Record<string, TemplateField | ''> = Object.fromEntries(spec.header.map((h) => [h, '']));
  for (const [field, col] of Object.entries(spec.columns)) mapping[col] = field as TemplateField;
  return {
    headerRow: found >= 0 ? found : null,
    mapping,
    amountMode: spec.amountMode,
    directionMap: { ...spec.directionMap },
    skipStatuses: [...spec.skipStatuses],
    sourceKind: spec.sourceKind,
    timeFormat: spec.timeFormat,
    titleKeywords: spec.titleKeywords.join('，'),
    fileNameKeywords: spec.fileNameKeywords.join('，'),
    balanceCheck: spec.balanceCheck,
  };
}
