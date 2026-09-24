/**
 * 分类规则：结构定义 + 匹配 + 分类决策链（见 ADR-0004）
 *
 * 决策链（命中即停）：手动指定 > 用户规则 > 系统关键词规则 > 来源分类映射 > 未分类
 */
import { z } from 'zod';
import type { Direction } from '../common.ts';

const textField = z.enum(['counterparty', 'description', 'note', 'paymentMethod', 'sourceHint', 'source', 'anyText']);

/** 单个条件。文本类与金额类分开定义，避免出现"金额 containsAny"这种无意义组合 */
const conditionSchema = z.discriminatedUnion('field', [
  ...textField.options.map((f) =>
    z.object({ field: z.literal(f), op: z.enum(['containsAny', 'notContains', 'equals', 'startsWith', 'endsWith']), values: z.array(z.string().min(1)).min(1) }).strict(),
  ),
  z.object({ field: z.literal('direction'), op: z.literal('equals'), values: z.array(z.enum(['income', 'expense', 'neutral'])).min(1) }).strict(),
  z.object({ field: z.literal('amount'), op: z.enum(['gte', 'lte']), value: z.number().int().nonnegative() }).strict(),
  /** 对方是账单户主本人（户主姓名由解析模板从文件说明中提取） */
  z.object({ field: z.literal('isSelf'), op: z.literal('equals'), value: z.boolean() }).strict(),
] as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);

export const ruleSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    priority: z.number().int().default(100),
    match: z.enum(['all', 'any']).default('all'),
    conditions: z.array(conditionSchema).min(1, '规则至少要有一个条件'),
    action: z
      .object({
        categoryKey: z.string().min(1),
        /** 把方向改为中性（如转给自己的钱），只允许改成 neutral，不允许收入支出互换 */
        setDirection: z.literal('neutral').optional(),
      })
      .strict(),
  })
  .strict();

export type Rule = z.infer<typeof ruleSchema>;
type Condition = Rule['conditions'][number];

/** 分类所需的流水字段 */
export interface Classifiable {
  direction: Direction;
  amountCents: number;
  counterparty: string;
  description: string;
  note?: string;
  paymentMethod: string | null;
  categoryHint: string | null;
  /** 来源模板 id，如 alipay-csv */
  source: string;
  /** 用户手动指定的分类（最高优先级） */
  manualCategoryKey?: string;
  /** 账单户主姓名；缺失时 isSelf 条件恒为不满足 */
  holderName?: string;
}

export type CategorySource = 'manual' | 'user_rule' | 'system_rule' | 'source_hint' | 'none';

export interface ClassifyResult {
  categoryKey: string | null;
  direction: Direction;
  source: CategorySource;
  /** 命中的规则名 / 映射说明，用于向用户解释"为什么是这个分类" */
  reason: string | null;
}

/**
 * 文本归一化：忽略大小写、全角转半角、去空白。
 * 让"ＡＰＩ服务"与"api服务"、"7-11"与"７－１１"都能匹配上。
 */
export function normalize(s: string): string {
  return s
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function fieldText(t: Classifiable, field: string): string {
  switch (field) {
    case 'counterparty': return t.counterparty;
    case 'description': return t.description;
    case 'note': return t.note ?? '';
    case 'paymentMethod': return t.paymentMethod ?? '';
    case 'sourceHint': return t.categoryHint ?? '';
    case 'source': return t.source;
    // anyText：对方 + 商品 + 备注，对应"条目信息或备注里带某个词"
    case 'anyText': return [t.counterparty, t.description, t.note ?? ''].join(' ');
    default: throw new Error(`未知字段 ${field}`);
  }
}

export function matchCondition(t: Classifiable, c: Condition): boolean {
  if (c.field === 'amount') return c.op === 'gte' ? t.amountCents >= c.value : t.amountCents <= c.value;
  if (c.field === 'direction') return (c.values as string[]).includes(t.direction);
  if (c.field === 'isSelf') {
    const self = !!t.holderName && normalize(t.counterparty) === normalize(t.holderName);
    return self === c.value;
  }
  const text = normalize(fieldText(t, c.field));
  const vals = (c.values as string[]).map(normalize);
  switch (c.op) {
    case 'containsAny': return vals.some((v) => text.includes(v));
    case 'notContains': return vals.every((v) => !text.includes(v));
    case 'equals': return vals.some((v) => text === v);
    case 'startsWith': return vals.some((v) => text.startsWith(v));
    case 'endsWith': return vals.some((v) => text.endsWith(v));
    default: return false;
  }
}

export function matchRule(t: Classifiable, r: Rule): boolean {
  if (!r.enabled) return false;
  return r.match === 'all' ? r.conditions.every((c) => matchCondition(t, c)) : r.conditions.some((c) => matchCondition(t, c));
}

/** 分类键所属的组（expense / income / neutral），用于校验"支出不能被归到收入分类" */
const groupOf = (key: string) => key.split('.')[0] as Direction;

export interface ClassifierConfig {
  userRules: Rule[];
  systemRules: Rule[];
  /** 来源模板 id → { 原生分类 → 分类键 } */
  sourceHints: Record<string, Record<string, string>>;
  /** 合法的分类键集合（预置 + 用户自建） */
  validKeys: Set<string>;
}

export function classify(t: Classifiable, cfg: ClassifierConfig): ClassifyResult {
  if (t.manualCategoryKey) return { categoryKey: t.manualCategoryKey, direction: groupOf(t.manualCategoryKey), source: 'manual', reason: '手动指定' };

  const tryRules = (rules: Rule[], source: CategorySource): ClassifyResult | null => {
    for (const r of [...rules].sort((a, b) => a.priority - b.priority)) {
      if (!matchRule(t, r)) continue;
      const direction = r.action.setDirection ?? t.direction;
      // 分类与方向必须一致：规则把一笔"收入"归进"支出分类"时视为不适用，继续往下找，避免统计错乱
      if (groupOf(r.action.categoryKey) !== direction) continue;
      return { categoryKey: r.action.categoryKey, direction, source, reason: r.name };
    }
    return null;
  };

  const hit = tryRules(cfg.userRules, 'user_rule') ?? tryRules(cfg.systemRules, 'system_rule');
  if (hit) return hit;

  const hintKey = t.categoryHint ? cfg.sourceHints[t.source]?.[t.categoryHint] : undefined;
  if (hintKey && cfg.validKeys.has(hintKey)) {
    const g = groupOf(hintKey);
    // 映射到中性分类的原生分类（如"朝朝宝转出"），本身就意味着是自己账户间的资金流动，方向随之改为中性；
    // 其余情况方向必须一致
    if (g === 'neutral' || g === t.direction)
      return { categoryKey: hintKey, direction: g, source: 'source_hint', reason: `来源分类「${t.categoryHint}」` };
  }

  return { categoryKey: null, direction: t.direction, source: 'none', reason: null };
}

/** 加载并校验规则列表 */
export function loadRules(json: unknown): Rule[] {
  const r = z.array(ruleSchema).safeParse(json);
  if (!r.success) throw new Error(`规则不合法: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}
