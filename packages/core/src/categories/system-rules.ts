/**
 * 系统规则与来源分类映射（ADR-0004；来源于 P0-1c 探针，并按负责人决定调整）
 *
 * 规则只引用预置键；增删规则时注意：测试会检查每个预置键都存在于预置分类树中。
 */
import type { SystemRule } from './rules.ts';

const anyText = (values: string[]) => ({ field: 'anyText' as const, op: 'containsAny' as const, values });
const expenseOnly = { field: 'direction' as const, op: 'equals' as const, values: ['expense' as const] };

export const SYSTEM_RULES: SystemRule[] = [
  // 最先判断：对方是本人 → 自己账户间转账（中性），避免被算成收支
  {
    name: '转给自己（对方是本人）',
    priority: 1,
    conditions: [{ field: 'isSelf', op: 'equals', value: true }],
    action: { presetKey: 'neutral.self', setDirection: 'neutral' },
  },
  {
    name: '地铁公交',
    conditions: [anyText(['地铁', '轨道交通', '公交', '巴士', 'BRT'])],
    action: { presetKey: 'expense.transport.public' },
  },
  {
    name: '打车',
    conditions: [anyText(['滴滴', '高德打车', '曹操出行', 'T3出行', '花小猪', '哈啰打车'])],
    action: { presetKey: 'expense.transport.taxi' },
  },
  {
    name: '铁路航空',
    conditions: [anyText(['12306', '铁路', '航空', '机票', '中铁网络'])],
    action: { presetKey: 'expense.transport.travel' },
  },
  {
    name: '充电加油停车',
    conditions: [anyText(['充电', '加油', '停车', '中石化', '中石油'])],
    action: { presetKey: 'expense.transport.car' },
  },
  {
    name: '外卖',
    conditions: [anyText(['外卖', '美团', '饿了么', '淘宝闪购'])],
    action: { presetKey: 'expense.food.delivery' },
  },
  {
    name: '餐饮关键词',
    conditions: [anyText(['餐厅', '饭店', '面馆', '馄饨', '小吃', '烧烤', '火锅', '快餐', '食堂'])],
    action: { presetKey: 'expense.food.meal' },
  },
  {
    name: '饮品',
    conditions: [anyText(['瑞幸', '星巴克', '蜜雪冰城', '奶茶', '咖啡', '茶百道', '古茗'])],
    action: { presetKey: 'expense.food.snack' },
  },
  {
    name: '超市便利店',
    conditions: [anyText(['超市', '便利店', '美宜佳', '罗森', '全家', '7-11', '朴朴'])],
    action: { presetKey: 'expense.shopping.daily' },
  },
  {
    name: '会员订阅',
    conditions: [anyText(['会员', '连续包月', '订阅', 'API服务'])],
    action: { presetKey: 'expense.telecom.subscription' },
  },
  {
    name: '房租',
    conditions: [anyText(['房租', '租金', '泊寓', '自如', '公寓'])],
    action: { presetKey: 'expense.housing.rent' },
  },
  {
    name: '保险',
    conditions: [anyText(['保险', '保费', '车险']), expenseOnly],
    action: { presetKey: 'expense.insurance' },
  },
  {
    name: '理财申购赎回',
    conditions: [
      { field: 'counterparty', op: 'containsAny', values: ['基金销售', '理财通', '余额宝', '零钱通', '朝朝宝'] },
    ],
    action: { presetKey: 'neutral.invest', setDirection: 'neutral' },
  },
  {
    name: '公积金',
    conditions: [
      { field: 'counterparty', op: 'containsAny', values: ['住房公积金'] },
      { field: 'direction', op: 'equals', values: ['income'] },
    ],
    action: { presetKey: 'income.other' },
  },
  // 负责人决定（ADR-0004 Q1）：贷款 / 信用卡还款算支出
  {
    name: '贷款 / 信用卡还款',
    conditions: [anyText(['小额贷款', '白条', '花呗', '借呗', '信用卡还款', '贷款还款']), expenseOnly],
    action: { presetKey: 'expense.repay' },
  },
];

/** 来源 → { 原生分类 → 预置键 }；来源名与导入模板的 externalSource 一致 */
export const SOURCE_HINTS: Record<string, Record<string, string>> = {
  alipay: {
    交通出行: 'expense.transport',
    餐饮美食: 'expense.food',
    日用百货: 'expense.shopping.daily',
    服饰装扮: 'expense.shopping.clothing',
    数码电器: 'expense.shopping.digital',
    家居家装: 'expense.shopping.home',
    美容美发: 'expense.beauty',
    医疗健康: 'expense.health',
    文化休闲: 'expense.entertainment',
    教育培训: 'expense.education',
    保险: 'expense.insurance',
    充值缴费: 'expense.telecom.phone',
    住房物业: 'expense.housing',
    转账红包: 'expense.social',
    投资理财: 'neutral.invest',
  },
  wechat: {
    微信红包: 'income.redpacket',
  },
  cmb: {
    代发工资: 'income.salary',
    账户结息: 'income.interest',
    朝朝宝转出: 'neutral.invest',
  },
};
