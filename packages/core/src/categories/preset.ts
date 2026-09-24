/**
 * 系统预置分类树（ADR-0004）
 *
 * 创建账本时复制一份写入该账本的 categories 表（记录 preset_key），之后用户可以改名、新增、隐藏。
 * 分类键（key）是稳定标识：系统规则、来源分类映射都通过它找到用户的分类，**发布后不得修改已有的键**；
 * 新增分类时递增 PRESET_VERSION，已有账本据此提示"有新的预置分类可加入"。
 *
 * 来源：P0-1c 探针（v1）+ 负责人决定"还款算支出"（v2，ADR-0004 Q1）。
 */

export type CategoryGroup = 'expense' | 'income' | 'neutral';

export interface PresetCategory {
  /** 稳定键，格式：<组>.<一级>[.<二级>] */
  key: string;
  name: string;
  children?: PresetCategory[];
}

export const PRESET_VERSION = 2;

export const PRESET_CATEGORIES: Record<CategoryGroup, PresetCategory[]> = {
  expense: [
    {
      key: 'expense.food',
      name: '餐饮',
      children: [
        { key: 'expense.food.meal', name: '正餐' },
        { key: 'expense.food.delivery', name: '外卖' },
        { key: 'expense.food.snack', name: '零食饮品' },
      ],
    },
    {
      key: 'expense.transport',
      name: '交通',
      children: [
        { key: 'expense.transport.public', name: '公共交通' },
        { key: 'expense.transport.taxi', name: '打车' },
        { key: 'expense.transport.car', name: '汽车（油费/充电/停车/保养）' },
        { key: 'expense.transport.travel', name: '长途出行' },
      ],
    },
    {
      key: 'expense.shopping',
      name: '购物',
      children: [
        { key: 'expense.shopping.daily', name: '日用百货' },
        { key: 'expense.shopping.clothing', name: '服饰' },
        { key: 'expense.shopping.digital', name: '数码电器' },
        { key: 'expense.shopping.home', name: '家居' },
      ],
    },
    {
      key: 'expense.housing',
      name: '居住',
      children: [
        { key: 'expense.housing.rent', name: '房租' },
        { key: 'expense.housing.utility', name: '水电燃气' },
      ],
    },
    {
      key: 'expense.telecom',
      name: '通讯与订阅',
      children: [
        { key: 'expense.telecom.phone', name: '话费网费' },
        { key: 'expense.telecom.subscription', name: '会员订阅' },
      ],
    },
    { key: 'expense.health', name: '医疗健康' },
    { key: 'expense.beauty', name: '美容美发' },
    { key: 'expense.entertainment', name: '娱乐休闲' },
    { key: 'expense.education', name: '学习' },
    { key: 'expense.social', name: '人情往来' },
    { key: 'expense.insurance', name: '保险' },
    { key: 'expense.finance', name: '金融费用（利息/手续费）' },
    { key: 'expense.repay', name: '还款（贷款/信用卡）' },
    { key: 'expense.other', name: '其他支出' },
  ],
  income: [
    { key: 'income.salary', name: '工资' },
    { key: 'income.interest', name: '利息收益' },
    { key: 'income.refund', name: '退款' },
    { key: 'income.transfer', name: '他人转账' },
    { key: 'income.redpacket', name: '红包' },
    { key: 'income.other', name: '其他收入' },
  ],
  neutral: [
    { key: 'neutral.invest', name: '理财申购赎回' },
    { key: 'neutral.self', name: '自己账户间转账' },
    { key: 'neutral.topup', name: '充值提现' },
    { key: 'neutral.other', name: '其他中性' },
  ],
};

/** 展开后的一条预置分类，写库时使用 */
export interface FlatPresetCategory {
  key: string;
  name: string;
  group: CategoryGroup;
  /** 父分类的键；一级分类为 null */
  parentKey: string | null;
  /** 同级内的排序（从 0 开始） */
  sort: number;
}

/**
 * 把预置分类树展开成列表，父分类一定排在子分类之前（写库时可以按顺序插入）
 */
export function flattenPreset(
  preset: Record<CategoryGroup, PresetCategory[]> = PRESET_CATEGORIES,
): FlatPresetCategory[] {
  const out: FlatPresetCategory[] = [];
  for (const group of Object.keys(preset) as CategoryGroup[]) {
    preset[group].forEach((top, i) => {
      out.push({ key: top.key, name: top.name, group, parentKey: null, sort: i });
      top.children?.forEach((child, j) => {
        out.push({ key: child.key, name: child.name, group, parentKey: top.key, sort: j });
      });
    });
  }
  return out;
}

/**
 * 校验预置分类树的一致性（测试与启动时调用）
 * @returns 问题列表；为空表示合法
 */
export function validatePreset(preset: Record<CategoryGroup, PresetCategory[]> = PRESET_CATEGORIES): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const c of flattenPreset(preset)) {
    if (seen.has(c.key)) issues.push(`分类键重复：${c.key}`);
    seen.add(c.key);
    if (!c.key.startsWith(`${c.group}.`)) issues.push(`分类键 ${c.key} 与所在组 ${c.group} 不一致`);
    if (c.parentKey && !c.key.startsWith(`${c.parentKey}.`))
      issues.push(`子分类 ${c.key} 的键没有以父分类 ${c.parentKey} 开头`);
    if (!c.name.trim()) issues.push(`分类 ${c.key} 名称为空`);
  }
  // 同一父分类下名称不能重复（数据库也有唯一约束）
  const names = new Set<string>();
  for (const c of flattenPreset(preset)) {
    const k = `${c.group}|${c.parentKey ?? ''}|${c.name}`;
    if (names.has(k)) issues.push(`同级分类名称重复：${c.name}`);
    names.add(k);
  }
  return issues;
}
