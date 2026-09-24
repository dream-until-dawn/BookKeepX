/**
 * 金额格式化与运算：分 → 展示（ADR-0002）
 */

/**
 * 断言是合法的"分"（安全整数）
 * @throws Error 传入浮点数、NaN、超范围值时抛错 —— 防止把"元"或浮点数误传进来
 */
export function assertCents(value: number, what = '金额'): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${what}必须是以"分"为单位的安全整数，实际为 ${value}`);
}

export interface FormatOptions {
  /** 是否带 ¥ 符号，默认 false */
  symbol?: boolean;
  /** 符号显示：auto 仅负数带"-"（默认）；always 正数也带"+"（如收入）；never 不显示符号（取绝对值） */
  sign?: 'auto' | 'always' | 'never';
  /** 是否使用千分位，默认 true */
  grouping?: boolean;
}

/**
 * 分 → 展示字符串，始终两位小数
 * @example formatCents(123456) === '1,234.56'
 * @example formatCents(-9868, { symbol: true }) === '-¥98.68'
 */
export function formatCents(cents: number, opts: FormatOptions = {}): string {
  assertCents(cents);
  const { symbol = false, sign = 'auto', grouping = true } = opts;
  const abs = Math.abs(cents);
  // 整数除法与取余都在整数范围内完成，不产生浮点误差
  const yuan = Math.floor(abs / 100);
  const fen = abs % 100;
  const yuanText = grouping ? yuan.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') : yuan.toString();
  const signText = sign === 'never' ? '' : cents < 0 ? '-' : sign === 'always' && cents > 0 ? '+' : '';
  return `${signText}${symbol ? '¥' : ''}${yuanText}.${fen.toString().padStart(2, '0')}`;
}

/**
 * 分 → 元的数字，**仅用于图表等展示场景**（ECharts 需要数值）。
 * 结果是浮点数，不得再参与任何金额计算。
 */
export function centsToYuanNumber(cents: number): number {
  assertCents(cents);
  return cents / 100;
}

/**
 * 金额求和，结果超出安全整数时抛错而不是静默丢精度
 * @throws Error 任一项不是合法的分，或合计溢出
 */
export function sumCents(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) {
    assertCents(v);
    total += v;
    if (!Number.isSafeInteger(total)) throw new Error('金额合计超出安全整数范围');
  }
  return total;
}
