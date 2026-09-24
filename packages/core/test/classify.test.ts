/**
 * 分类规则引擎（ADR-0004）：决策链、条件匹配、方向与分类组一致性、隐藏分类不自动归入
 */
import { describe, expect, it } from 'vitest';
import {
  type Classifiable,
  type ClassifierCategory,
  type ClassifierConfig,
  classify,
  flattenPreset,
  normalizeText,
  SOURCE_HINTS,
  SYSTEM_RULES,
  type UserRule,
} from '../src/index.ts';

/** 用预置分类树构造一个账本的分类：id 就用 "id:<预置键>" */
const PRESET_CATS: ClassifierCategory[] = flattenPreset().map((c) => ({
  id: `id:${c.key}`,
  group: c.group,
  presetKey: c.key,
  hidden: false,
}));

const config = (over: Partial<ClassifierConfig> = {}): ClassifierConfig => ({
  categories: PRESET_CATS,
  userRules: [],
  systemRules: SYSTEM_RULES,
  sourceHints: SOURCE_HINTS,
  ...over,
});

const tx = (over: Partial<Classifiable> = {}): Classifiable => ({
  direction: 'expense',
  amountCents: 300,
  counterparty: '某商户',
  description: '',
  paymentMethod: null,
  sourceHint: null,
  source: 'alipay',
  ...over,
});

const metroRule: UserRule = {
  id: 'rule-metro',
  name: '地铁归交通',
  priority: 1,
  conditions: [{ field: 'anyText', op: 'containsAny', values: ['地铁'] }],
  action: { categoryId: 'id:expense.transport.public' },
};

describe('决策链', () => {
  it('正向（需求原例）：备注里带"地铁" → 用户规则归入交通·公共交通', () => {
    expect(classify(tx({ counterparty: '某某', note: '坐地铁去公司' }), config({ userRules: [metroRule] }))).toEqual({
      categoryId: 'id:expense.transport.public',
      direction: 'expense',
      source: 'user_rule',
      ruleId: 'rule-metro',
      reason: '地铁归交通',
    });
  });

  it('正向：用户规则优先于系统规则', () => {
    const takeout: UserRule = {
      id: 'r2',
      name: '外卖算正餐',
      conditions: [{ field: 'anyText', op: 'containsAny', values: ['外卖'] }],
      action: { categoryId: 'id:expense.food.meal' },
    };
    expect(classify(tx({ description: '某某外卖订单' }), config({ userRules: [takeout] }))).toMatchObject({
      categoryId: 'id:expense.food.meal',
      source: 'user_rule',
    });
  });

  it('正向：没有用户规则时由系统规则归类', () => {
    expect(classify(tx({ description: '厦门地铁' }), config())).toMatchObject({
      categoryId: 'id:expense.transport.public',
      source: 'system_rule',
    });
  });

  it('正向：规则都不中时退回来源映射（支付宝"餐饮美食" → 餐饮）', () => {
    expect(classify(tx({ counterparty: '无关键词的店', sourceHint: '餐饮美食' }), config())).toMatchObject({
      categoryId: 'id:expense.food',
      source: 'source_hint',
      reason: '来源分类「餐饮美食」',
    });
  });

  it('正向：映射到中性分类的原生分类（招行"朝朝宝转出"）把方向改为中性', () => {
    const r = classify(
      tx({ direction: 'income', source: 'cmb', sourceHint: '朝朝宝转出', counterparty: '' }),
      config(),
    );
    expect(r).toMatchObject({ categoryId: 'id:neutral.invest', direction: 'neutral' });
  });

  it('正向：对方是本人 → 自己账户间转账（中性），名字中的空格不影响', () => {
    const r = classify(tx({ counterparty: '张 三', selfNames: ['张三'], amountCents: 300000 }), config());
    expect(r).toMatchObject({ categoryId: 'id:neutral.self', direction: 'neutral', source: 'system_rule' });
  });

  it('正向（负责人决定 Q1）：贷款 / 信用卡还款算支出', () => {
    expect(classify(tx({ counterparty: '京东白条', source: 'cmb' }), config())).toMatchObject({
      categoryId: 'id:expense.repay',
      direction: 'expense',
    });
  });

  it('反向：贷款放款（收入方向）不被还款规则归为支出', () => {
    const r = classify(tx({ direction: 'income', counterparty: '某小额贷款公司', source: 'cmb' }), config());
    expect(r.categoryId).not.toBe('id:expense.repay');
    expect(r.direction).toBe('income');
  });

  it('反向：没有本人姓名时，isSelf 不成立', () => {
    expect(classify(tx({ counterparty: '张三' }), config()).categoryId).not.toBe('id:neutral.self');
  });

  it('反向：一个信号都没有 → 未分类', () => {
    expect(classify(tx({ counterparty: '甲乙丙', source: 'wechat', sourceHint: '扫二维码付款' }), config())).toEqual({
      categoryId: null,
      direction: 'expense',
      source: 'none',
      ruleId: null,
      reason: null,
    });
  });
});

describe('不适用的规则被跳过，继续往下找', () => {
  it('反向：规则把收入归进支出分类 → 不适用', () => {
    const r = classify(tx({ direction: 'income', description: '地铁公司退款' }), config({ userRules: [metroRule] }));
    expect(r.categoryId?.startsWith('id:expense.')).not.toBe(true);
  });

  it('反向：规则指向的分类已隐藏 → 不自动归入，改由后续规则 / 映射处理', () => {
    const cats = PRESET_CATS.map((c) => (c.presetKey === 'expense.transport.public' ? { ...c, hidden: true } : c));
    const r = classify(
      tx({ description: '厦门地铁', sourceHint: '交通出行' }),
      config({ categories: cats, userRules: [metroRule] }),
    );
    expect(r).toMatchObject({ categoryId: 'id:expense.transport', source: 'source_hint' });
  });

  it('反向：用户规则指向已删除的分类 → 不适用', () => {
    const broken: UserRule = { ...metroRule, action: { categoryId: 'id:不存在' } };
    expect(classify(tx({ description: '地铁' }), config({ userRules: [broken] })).source).toBe('system_rule');
  });

  it('反向：来源映射方向不一致（支出被映射到收入分类）→ 不采用', () => {
    const r = classify(tx({ direction: 'expense', source: 'cmb', sourceHint: '代发工资', counterparty: '' }), config());
    expect(r.categoryId).toBeNull();
  });

  it('反向：停用的规则不生效', () => {
    expect(
      classify(tx({ counterparty: '无', note: '地铁' }), config({ userRules: [{ ...metroRule, enabled: false }] }))
        .source,
    ).toBe('system_rule');
  });
});

describe('条件匹配细节', () => {
  const rule = (over: Partial<UserRule>): UserRule => ({ ...metroRule, ...over });

  it('正向：全角、大小写、空格不影响匹配', () => {
    expect(normalizeText('ＤｅｅｐＳｅｅｋ－ＡＰＩ 服务')).toBe(normalizeText('deepseek-api服务'));
  });

  it('正向：金额区间条件（边界包含）', () => {
    const big = rule({
      conditions: [{ field: 'amount', op: 'gte', value: 100000 }],
      action: { categoryId: 'id:expense.other' },
    });
    expect(classify(tx({ amountCents: 100000, counterparty: '甲' }), config({ userRules: [big] })).source).toBe(
      'user_rule',
    );
    expect(classify(tx({ amountCents: 99999, counterparty: '甲' }), config({ userRules: [big] })).source).not.toBe(
      'user_rule',
    );
  });

  it('正向：match=any 任一满足即命中；match=all 需全部满足', () => {
    const conditions = [
      { field: 'counterparty' as const, op: 'equals' as const, values: ['甲'] },
      { field: 'amount' as const, op: 'gte' as const, value: 999999 },
    ];
    const act = { categoryId: 'id:expense.other' };
    expect(
      classify(tx({ counterparty: '甲' }), config({ userRules: [rule({ match: 'any', conditions, action: act })] }))
        .source,
    ).toBe('user_rule');
    expect(
      classify(tx({ counterparty: '甲' }), config({ userRules: [rule({ match: 'all', conditions, action: act })] }))
        .source,
    ).not.toBe('user_rule');
  });

  it('正向：notContains 排除条件', () => {
    const r = rule({
      conditions: [
        { field: 'anyText', op: 'containsAny', values: ['会员'] },
        { field: 'anyText', op: 'notContains', values: ['餐厅'] },
      ],
      action: { categoryId: 'id:expense.telecom.subscription' },
    });
    expect(classify(tx({ description: '视频会员' }), config({ userRules: [r] })).source).toBe('user_rule');
    expect(classify(tx({ description: '某餐厅会员充值' }), config({ userRules: [r] })).source).not.toBe('user_rule');
  });

  it('反向：空关键词不会匹配一切', () => {
    const r = rule({ conditions: [{ field: 'anyText', op: 'containsAny', values: ['', '  '] }] });
    expect(classify(tx({ counterparty: '无关' }), config({ userRules: [r] })).source).toBe('none');
  });

  it('反向：没有条件的规则不会匹配一切', () => {
    expect(classify(tx({ counterparty: '无关' }), config({ userRules: [rule({ conditions: [] })] })).source).toBe(
      'none',
    );
  });
});

describe('系统规则与来源映射的一致性', () => {
  const keys = new Set(flattenPreset().map((c) => c.key));

  it('每条系统规则引用的预置键都存在', () => {
    for (const r of SYSTEM_RULES) expect(keys.has(r.action.presetKey), `${r.name} → ${r.action.presetKey}`).toBe(true);
  });

  it('每条来源映射引用的预置键都存在', () => {
    for (const [source, map] of Object.entries(SOURCE_HINTS))
      for (const [hint, key] of Object.entries(map)) expect(keys.has(key), `${source}/${hint} → ${key}`).toBe(true);
  });
});
