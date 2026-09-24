/**
 * 探针公共部分：统一的解析结果结构 + 金额 / 时间工具
 *
 * 注意：这是探针代码，用来验证"能不能做"。正式实现会在 packages/core 里重写并补全测试。
 */

/** 收支方向。neutral = 中性 / 不计收支（充值、提现、理财收益、转账到自己等） */
export type Direction = 'income' | 'expense' | 'neutral';

/** 适配器解析出的一笔流水（已规范化） */
export interface ParsedRecord {
  /** 交易发生的本地时间（北京时间墙上时间），格式 YYYY-MM-DD HH:mm:ss；银行流水只有日期时为 00:00:00 */
  occurredAt: string;
  direction: Direction;
  /** 金额，单位：分，恒为正 */
  amountCents: number;
  counterparty: string;
  /** 商品说明 / 交易摘要 */
  description: string;
  /** 平台交易单号；银行流水没有，为 null */
  externalId: string | null;
  /** 支付方式（如"零钱通""招商银行储蓄卡(1032)"），用于跨来源去重 */
  paymentMethod: string | null;
  /** 原始状态文字（如"支付成功""已全额退款"），用于过滤 */
  status: string | null;
  /** 仅银行流水：交易后余额（分），可用于余额链校验 */
  balanceCents?: number;
}

/** 文件自带的汇总信息，用来和逐行解析结果交叉校验 */
export interface FileSummary {
  income?: { count: number; cents: number };
  expense?: { count: number; cents: number };
  neutral?: { count: number; cents: number };
  total?: number;
}

export interface ParseResult {
  source: 'wechat' | 'alipay' | 'cmb-pdf';
  records: ParsedRecord[];
  summary: FileSummary;
}

/**
 * 元（字符串）→ 分（整数）。全程按字符串处理，不经过浮点运算。
 * 支持："1,800.00" "-98.68" "¥12.5" "6"。
 * @returns 带符号的分；银行流水用负号表示支出，所以这里保留符号
 * @throws 格式非法（空串、多于两位小数、含非法字符）时抛错
 */
export function yuanToCents(input: string | number): number {
  // 数字单元格：Excel 里存的是双精度数，String() 会给出最短的十进制表示（如 2635.95），再按字符串处理
  const raw = typeof input === 'number' ? String(input) : input;
  const s = raw.replace(/[¥￥,\s]/g, '');
  const m = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`金额格式非法: "${raw}"`);
  const [, sign, intPart, frac = ''] = m;
  const cents = Number(intPart) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error(`金额超出范围: "${raw}"`);
  return sign === '-' ? -cents : cents;
}

/**
 * 把 Excel 读出来的 Date 还原成"墙上时间"字符串。
 *
 * 为什么：xlsx 里日期存的是不带时区的序列号，exceljs 按 UTC 解释成 Date；
 * 而微信账单注明"所有时间均为 UTC+08:00"。所以 Date 的 UTC 字段才是账单上写的数字，
 * 如果用本地时区方法读取或直接当 UTC 时刻入库，会整体偏移 8 小时。
 */
export function excelDateToWallClock(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** 平台用 "/" 表示空值，统一转成 null；同时去掉支付宝为防 Excel 科学计数法加的制表符 */
export function clean(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\t/g, '').trim();
  return s === '' || s === '/' ? null : s;
}

/** 从 "支出：54笔 2635.95元" 这类汇总文字中提取笔数和金额 */
export function parseSummaryLine(text: string, label: string): { count: number; cents: number } | undefined {
  const m = new RegExp(`${label}[：:]\\s*(\\d+)笔\\s*([\\d.,]+)元`).exec(text);
  return m ? { count: Number(m[1]), cents: yuanToCents(m[2]!) } : undefined;
}
