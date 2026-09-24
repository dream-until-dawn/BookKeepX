/**
 * 分类规则引擎（ADR-0004）
 *
 * 决策链（命中即停）：手动指定 > 用户规则 > 系统规则 > 来源分类映射 > 未分类
 *
 * - 用户规则的动作引用"分类 id"（用户自己的分类）；
 * - 系统规则、来源映射引用"预置键"（如 expense.transport.public），通过账本分类上的 preset_key 找到对应分类；
 * - 规则只含关键词匹配，不支持正则（用户可编辑的内容不能成为 ReDoS 入口）。
 */
import type { CategoryGroup } from './preset.ts';

export type Direction = CategoryGroup;

/** 文本类字段；anyText = 对方 + 说明 + 备注（对应"条目信息或备注里带某个词"） */
export type TextField = 'counterparty' | 'description' | 'note' | 'paymentMethod' | 'sourceHint' | 'source' | 'anyText';

export type RuleCondition =
  | { field: TextField; op: 'containsAny' | 'notContains' | 'equals' | 'startsWith' | 'endsWith'; values: string[] }
  | { field: 'direction'; op: 'equals'; values: Direction[] }
  | { field: 'amount'; op: 'gte' | 'lte'; value: number }
  /** 对方是账单户主 / 本人（识别"转给自己"） */
  | { field: 'isSelf'; op: 'equals'; value: boolean };

interface RuleBase {
  /** 规则名（界面显示"由规则 xx 归类"） */
  name: string;
  enabled?: boolean;
  /** 数字小的先匹配 */
  priority?: number;
  match?: 'all' | 'any';
  conditions: RuleCondition[];
}

/** 用户规则：动作指向分类 id */
export interface UserRule extends RuleBase {
  id: string;
  action: { categoryId: string; setDirection?: 'neutral' };
}

/** 系统规则：动作指向预置键 */
export interface SystemRule extends RuleBase {
  action: { presetKey: string; setDirection?: 'neutral' };
}

/** 待分类的流水 */
export interface Classifiable {
  direction: Direction;
  amountCents: number;
  counterparty: string;
  description: string;
  note?: string;
  paymentMethod: string | null;
  /** 账单原生分类（支付宝"交易分类"等） */
  sourceHint: string | null;
  /** 来源，如 alipay / wechat / cmb */
  source: string;
  /** 本人的姓名（账单户主 + 用户设置的本人姓名），用于 isSelf 条件 */
  selfNames?: string[];
}

/** 账本中的一个分类（分类器只需要这些字段） */
export interface ClassifierCategory {
  id: string;
  group: Direction;
  presetKey: string | null;
  hidden: boolean;
}

export interface ClassifierConfig {
  categories: ClassifierCategory[];
  userRules: UserRule[];
  systemRules: SystemRule[];
  /** 来源 → { 原生分类 → 预置键 } */
  sourceHints: Record<string, Record<string, string>>;
}

export type CategorySource = 'user_rule' | 'system_rule' | 'source_hint' | 'none';

export interface ClassifyResult {
  categoryId: string | null;
  /** 分类后的方向（规则可能把方向改为中性） */
  direction: Direction;
  source: CategorySource;
  /** 命中的用户规则 id（仅 user_rule） */
  ruleId: string | null;
  /** 可读的原因，如规则名或"来源分类「餐饮美食」" */
  reason: string | null;
}

/**
 * 文本归一化：忽略大小写、全角转半角、去空白
 * 让"ＡＰＩ服务"与"api服务"、"7-11"与"７－１１"能互相匹配
 */
export function normalizeText(s: string): string {
  return s
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function fieldText(t: Classifiable, field: TextField): string {
  switch (field) {
    case 'counterparty':
      return t.counterparty;
    case 'description':
      return t.description;
    case 'note':
      return t.note ?? '';
    case 'paymentMethod':
      return t.paymentMethod ?? '';
    case 'sourceHint':
      return t.sourceHint ?? '';
    case 'source':
      return t.source;
    case 'anyText':
      return [t.counterparty, t.description, t.note ?? ''].join(' ');
  }
}

export function matchCondition(t: Classifiable, c: RuleCondition): boolean {
  switch (c.field) {
    case 'amount':
      return c.op === 'gte' ? t.amountCents >= c.value : t.amountCents <= c.value;
    case 'direction':
      return c.values.includes(t.direction);
    case 'isSelf': {
      const cp = normalizeText(t.counterparty);
      const self = cp !== '' && (t.selfNames ?? []).some((n) => n.trim() !== '' && normalizeText(n) === cp);
      return self === c.value;
    }
    default: {
      const text = normalizeText(fieldText(t, c.field));
      // 空关键词会匹配一切，直接忽略
      const vals = c.values.map(normalizeText).filter((v) => v !== '');
      if (vals.length === 0) return false;
      switch (c.op) {
        case 'containsAny':
          return vals.some((v) => text.includes(v));
        case 'notContains':
          return vals.every((v) => !text.includes(v));
        case 'equals':
          return vals.some((v) => text === v);
        case 'startsWith':
          return vals.some((v) => text.startsWith(v));
        case 'endsWith':
          return vals.some((v) => text.endsWith(v));
      }
    }
  }
}

export function matchRule(t: Classifiable, r: RuleBase): boolean {
  if (r.enabled === false || r.conditions.length === 0) return false;
  return (r.match ?? 'all') === 'all'
    ? r.conditions.every((c) => matchCondition(t, c))
    : r.conditions.some((c) => matchCondition(t, c));
}

const byPriority = <R extends RuleBase>(rules: R[]) =>
  [...rules].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

/**
 * 对一笔流水自动分类
 *
 * 规则 / 映射指向的分类若不存在、已隐藏、或组别与（改向后的）方向不一致，视为不适用，继续往下找，
 * 避免把支出归进收入分类导致统计错乱，也避免把新流水归进用户已隐藏的分类。
 */
export function classify(t: Classifiable, cfg: ClassifierConfig): ClassifyResult {
  const byId = new Map(cfg.categories.map((c) => [c.id, c]));
  const byPreset = new Map(cfg.categories.filter((c) => c.presetKey).map((c) => [c.presetKey!, c]));

  const usable = (c: ClassifierCategory | undefined, direction: Direction): c is ClassifierCategory =>
    !!c && !c.hidden && c.group === direction;

  for (const r of byPriority(cfg.userRules)) {
    if (!matchRule(t, r)) continue;
    const direction = r.action.setDirection ?? t.direction;
    const c = byId.get(r.action.categoryId);
    if (usable(c, direction)) return { categoryId: c.id, direction, source: 'user_rule', ruleId: r.id, reason: r.name };
  }

  for (const r of byPriority(cfg.systemRules)) {
    if (!matchRule(t, r)) continue;
    const direction = r.action.setDirection ?? t.direction;
    const c = byPreset.get(r.action.presetKey);
    if (usable(c, direction))
      return { categoryId: c.id, direction, source: 'system_rule', ruleId: null, reason: r.name };
  }

  const hintKey = t.sourceHint ? cfg.sourceHints[t.source]?.[t.sourceHint] : undefined;
  const hinted = hintKey ? byPreset.get(hintKey) : undefined;
  if (hinted) {
    // 映射到中性分类的原生分类（如"朝朝宝转出"）本身就意味着是自己账户间的资金流动，方向随之改为中性
    const direction = hinted.group === 'neutral' ? 'neutral' : t.direction;
    if (usable(hinted, direction)) {
      return {
        categoryId: hinted.id,
        direction,
        source: 'source_hint',
        ruleId: null,
        reason: `来源分类「${t.sourceHint}」`,
      };
    }
  }

  return { categoryId: null, direction: t.direction, source: 'none', ruleId: null, reason: null };
}
