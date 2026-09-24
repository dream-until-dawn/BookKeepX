import { describe, expect, it } from 'vitest';
import { flattenPreset, PRESET_CATEGORIES, validatePreset } from '../src/index.ts';

describe('预置分类树', () => {
  it('正向：内置预置分类树一致性检查无问题', () => {
    expect(validatePreset()).toEqual([]);
  });

  it('正向：展开后父分类排在子分类之前', () => {
    const flat = flattenPreset();
    const index = new Map(flat.map((c, i) => [c.key, i]));
    for (const c of flat) if (c.parentKey) expect(index.get(c.parentKey)!).toBeLessThan(index.get(c.key)!);
  });

  it('正向：包含负责人已决事项要求的分类（还款在支出组；无中性还款）', () => {
    const keys = flattenPreset().map((c) => c.key);
    expect(keys).toContain('expense.repay');
    expect(keys).not.toContain('neutral.repay');
    expect(keys).toEqual(expect.arrayContaining(['neutral.self', 'neutral.invest', 'income.refund', 'expense.other']));
  });

  it('反向：键重复、键与组不一致、子键不以父键开头、同级重名、空名称都能被发现', () => {
    const bad = {
      expense: [
        { key: 'expense.a', name: '甲', children: [{ key: 'expense.b.x', name: '子' }] },
        { key: 'expense.a', name: '乙' },
        { key: 'income.c', name: '甲' },
        { key: 'expense.d', name: ' ' },
      ],
      income: [],
      neutral: [],
    };
    const issues = validatePreset(bad);
    expect(issues).toEqual(
      expect.arrayContaining([
        '分类键重复：expense.a',
        '分类键 income.c 与所在组 expense 不一致',
        '子分类 expense.b.x 的键没有以父分类 expense.a 开头',
        '同级分类名称重复：甲',
        '分类 expense.d 名称为空',
      ]),
    );
  });

  it('边界：预置树最多两级', () => {
    for (const group of Object.values(PRESET_CATEGORIES))
      for (const top of group) for (const child of top.children ?? []) expect(child.children).toBeUndefined();
  });
});
