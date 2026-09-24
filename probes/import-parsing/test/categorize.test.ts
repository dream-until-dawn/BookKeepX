/**
 * P0-1c 测试：统一分类 + 自动分类规则
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildConfig, classify, loadRules, normalize, type Classifiable, type Rule } from '../src/categorize/index.ts';
import { detect, loadBuiltinTemplates, parseWith, readDoc } from '../src/engine/index.ts';

/** 构造一笔测试流水，默认是支付宝来源的一笔支出 */
const tx = (over: Partial<Classifiable> = {}): Classifiable => ({
  direction: 'expense',
  amountCents: 300,
  counterparty: '某商户',
  description: '',
  paymentMethod: null,
  categoryHint: null,
  source: 'alipay-csv',
  ...over,
});

const rule = (over: Partial<Rule> & Pick<Rule, 'conditions' | 'action'>): Rule => loadRules([{ name: '测试规则', ...over }])[0]!;

const metroRule = rule({ name: '地铁归交通', priority: 1, conditions: [{ field: 'anyText', op: 'containsAny', values: ['地铁'] }], action: { categoryKey: 'expense.transport.public' } });

describe('分类决策链', () => {
  const cfg = buildConfig([metroRule]);

  it('正向（需求原例）：备注里带"地铁" → 交通·公共交通，来源为用户规则', () => {
    const r = classify(tx({ counterparty: '某某', note: '坐地铁去公司' }), cfg);
    expect(r).toMatchObject({ categoryKey: 'expense.transport.public', source: 'user_rule', reason: '地铁归交通' });
  });

  it('正向：商品说明里带"地铁"同样命中（anyText 覆盖对方 + 商品 + 备注）', () => {
    expect(classify(tx({ description: '厦门地铁' }), cfg).categoryKey).toBe('expense.transport.public');
  });

  it('正向：用户规则优先于系统规则', () => {
    const takeout = rule({ name: '外卖算正餐', priority: 1, conditions: [{ field: 'anyText', op: 'containsAny', values: ['外卖'] }], action: { categoryKey: 'expense.food.meal' } });
    const r = classify(tx({ description: '某某外卖订单' }), buildConfig([takeout]));
    expect(r).toMatchObject({ categoryKey: 'expense.food.meal', source: 'user_rule' });
  });

  it('正向：手动指定优先于一切规则', () => {
    const r = classify(tx({ description: '厦门地铁', manualCategoryKey: 'expense.other' }), cfg);
    expect(r).toMatchObject({ categoryKey: 'expense.other', source: 'manual' });
  });

  it('正向：规则都不中时退回来源映射（支付宝"餐饮美食" → 餐饮）', () => {
    const r = classify(tx({ counterparty: '无关键词的店', categoryHint: '餐饮美食' }), cfg);
    expect(r).toMatchObject({ categoryKey: 'expense.food', source: 'source_hint' });
  });

  it('正向：映射到中性分类的原生分类会把方向改为中性（招行"朝朝宝转出"）', () => {
    const r = classify(tx({ direction: 'income', source: 'cmb-pdf', categoryHint: '朝朝宝转出', counterparty: '' }), cfg);
    expect(r).toMatchObject({ categoryKey: 'neutral.invest', direction: 'neutral' });
  });

  it('正向：对方是户主本人 → 自己账户间转账（中性）', () => {
    const r = classify(tx({ counterparty: '张 三', holderName: '张三', amountCents: 300000 }), cfg);
    expect(r).toMatchObject({ categoryKey: 'neutral.self', direction: 'neutral', source: 'system_rule' });
  });

  it('正向（负责人决定 Q1）：贷款 / 信用卡还款算支出，归入"还款"', () => {
    for (const cp of ['某某小额贷款有限公司', '京东白条', '花呗']) {
      expect(classify(tx({ counterparty: cp, source: 'cmb-pdf' }), cfg)).toMatchObject({ categoryKey: 'expense.repay', direction: 'expense' });
    }
  });

  it('反向：贷款放款（收入方向）不会被还款规则归为支出', () => {
    const r = classify(tx({ direction: 'income', counterparty: '某某小额贷款有限公司', source: 'cmb-pdf' }), cfg);
    expect(r.categoryKey).not.toBe('expense.repay');
    expect(r.direction).toBe('income');
  });

  it('反向：没有户主姓名时，isSelf 条件不成立', () => {
    expect(classify(tx({ counterparty: '张三' }), cfg).categoryKey).not.toBe('neutral.self');
  });

  it('反向：一个关键词都不中 → 未分类，而不是乱归', () => {
    expect(classify(tx({ counterparty: '甲乙丙', categoryHint: '扫二维码付款', source: 'wechat-xlsx' }), cfg)).toMatchObject({ categoryKey: null, source: 'none' });
  });

  it('反向：规则把收入归进支出分类 → 不适用，继续往下找', () => {
    const r = classify(tx({ direction: 'income', description: '地铁公司退款' }), cfg);
    expect(r.categoryKey?.startsWith('expense.')).not.toBe(true);
  });

  it('反向：来源映射方向不一致（支出被映射到收入分类）→ 不采用', () => {
    const r = classify(tx({ direction: 'expense', source: 'cmb-pdf', categoryHint: '代发工资', counterparty: '' }), cfg);
    expect(r.categoryKey).toBeNull();
  });

  it('反向：停用的规则不生效', () => {
    const off = rule({ ...metroRule, enabled: false, name: '停用' });
    expect(classify(tx({ counterparty: '无', note: '地铁' }), buildConfig([off])).source).not.toBe('user_rule');
  });
});

describe('条件匹配细节', () => {
  it('正向：全角、大小写、空格不影响匹配', () => {
    expect(normalize('ＤｅｅｐＳｅｅｋ－ＡＰＩ 服务')).toBe(normalize('deepseek-api服务'));
  });

  it('正向：金额区间条件', () => {
    const big = rule({ conditions: [{ field: 'amount', op: 'gte', value: 100000 }], action: { categoryKey: 'expense.other' } });
    const cfg = buildConfig([big]);
    expect(classify(tx({ amountCents: 100000, counterparty: '甲' }), cfg).source).toBe('user_rule');
    expect(classify(tx({ amountCents: 99999, counterparty: '甲' }), cfg).source).not.toBe('user_rule');
  });

  it('正向：match=any 任一条件满足即命中；match=all 需全部满足', () => {
    const conds = [
      { field: 'counterparty' as const, op: 'equals' as const, values: ['甲'] },
      { field: 'amount' as const, op: 'gte' as const, value: 999999 },
    ];
    expect(classify(tx({ counterparty: '甲' }), buildConfig([rule({ match: 'any', conditions: conds, action: { categoryKey: 'expense.other' } })])).source).toBe('user_rule');
    expect(classify(tx({ counterparty: '甲' }), buildConfig([rule({ match: 'all', conditions: conds, action: { categoryKey: 'expense.other' } })])).source).not.toBe('user_rule');
  });

  it('正向：notContains 排除条件', () => {
    const r = rule({
      conditions: [
        { field: 'anyText', op: 'containsAny', values: ['会员'] },
        { field: 'anyText', op: 'notContains', values: ['餐厅'] },
      ],
      action: { categoryKey: 'expense.telecom.subscription' },
    });
    const cfg = buildConfig([r]);
    expect(classify(tx({ description: '视频会员' }), cfg).source).toBe('user_rule');
    expect(classify(tx({ description: '某餐厅会员充值' }), cfg).source).not.toBe('user_rule');
  });
});

describe('规则与配置校验（反向）', () => {
  const ok = { name: 'x', conditions: [{ field: 'anyText', op: 'containsAny', values: ['a'] }], action: { categoryKey: 'expense.other' } };

  it('没有条件的规则 → 拒绝', () => {
    expect(() => loadRules([{ ...ok, conditions: [] }])).toThrow(/至少要有一个条件/);
  });
  it('不支持的操作符（如正则）→ 拒绝', () => {
    expect(() => loadRules([{ ...ok, conditions: [{ field: 'anyText', op: 'regex', values: ['.*'] }] }])).toThrow(/规则不合法/);
  });
  it('金额字段用文本操作符 → 拒绝', () => {
    expect(() => loadRules([{ ...ok, conditions: [{ field: 'amount', op: 'containsAny', values: ['1'] }] }])).toThrow(/规则不合法/);
  });
  it('动作试图把方向改成收入 → 拒绝（只允许改为中性）', () => {
    expect(() => loadRules([{ ...ok, action: { categoryKey: 'income.other', setDirection: 'income' } }])).toThrow(/规则不合法/);
  });
  it('关键词为空字符串 → 拒绝（否则会匹配一切）', () => {
    expect(() => loadRules([{ ...ok, conditions: [{ field: 'anyText', op: 'containsAny', values: [''] }] }])).toThrow(/规则不合法/);
  });
  it('规则引用了不存在的分类键 → buildConfig 拒绝', () => {
    expect(() => buildConfig(loadRules([{ ...ok, action: { categoryKey: 'expense.不存在' } }]))).toThrow(/不存在的分类键/);
  });
});

// ───────────────────────── 真实样本 ─────────────────────────
const SAMPLES = join(import.meta.dirname, '../../../samples');
const hasSamples = existsSync(SAMPLES) && readdirSync(SAMPLES).length >= 3;

describe.skipIf(!hasSamples)('真实样本分类', () => {
  const templates = loadBuiltinTemplates();
  const run = async (ext: string) => {
    const name = readdirSync(SAMPLES).find((n) => n.endsWith(ext))!;
    const doc = await readDoc(readFileSync(join(SAMPLES, name)));
    const d = detect(doc, name, templates);
    if (d.kind !== 'auto') throw new Error('识别失败');
    const r = parseWith(doc, templates.find((t) => t.id === d.templateId)!);
    const cfg = buildConfig();
    return { r, results: r.records.map((x) => classify({ ...x, source: d.templateId, holderName: r.meta.holderName }, cfg)) };
  };

  it('支付宝：开箱即用覆盖率 ≥ 95%', async () => {
    const { results } = await run('.csv');
    expect(results.filter((x) => x.source !== 'none').length / results.length).toBeGreaterThanOrEqual(0.95);
  });

  it('招行：能提取户主姓名，并识别出转给自己的流水（中性）', async () => {
    const { r, results } = await run('.pdf');
    expect(r.meta.holderName).toBeTruthy();
    expect(results.some((x) => x.categoryKey === 'neutral.self' && x.direction === 'neutral')).toBe(true);
  });

  it('跨来源（负责人决定 Q2 情况 A）：银行 → 支付宝理财的同一笔钱，两边都保留且都归为中性', async () => {
    const { findCrossSourceDuplicates } = await import('../src/verify.ts');
    const cmb = await run('.pdf');
    const ali = await run('.csv');
    const cfg = buildConfig();
    const pairs = findCrossSourceDuplicates(cmb.r.records, ali.r.records, '招商银行');
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    for (const p of pairs) {
      expect(classify({ ...p.bank, source: 'cmb-pdf', holderName: cmb.r.meta.holderName, categoryHint: null }, cfg).direction).toBe('neutral');
      expect(classify({ ...p.platform, source: 'alipay-csv', categoryHint: '投资理财' }, cfg).direction).toBe('neutral');
    }
  });

  it('招行：京东白条等还款被归为支出（Q1）', async () => {
    const { results } = await run('.pdf');
    expect(results.filter((x) => x.categoryKey === 'expense.repay').length).toBeGreaterThan(0);
    expect(results.some((x) => x.categoryKey?.startsWith('neutral.repay'))).toBe(false);
  });

  it('所有自动分类结果的分类组都与最终方向一致', async () => {
    for (const ext of ['.csv', '.pdf', '.xlsx']) {
      const { results } = await run(ext);
      for (const x of results) if (x.categoryKey) expect(x.categoryKey.split('.')[0]).toBe(x.direction);
    }
  });
});
