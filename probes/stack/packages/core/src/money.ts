/**
 * 金额工具（ADR-0002：金额以整数"分"存储，全程不经过浮点运算）
 *
 * 这是 P0-4 用来验证"一份代码同时被服务端和前端引用"的共享模块。
 */

/**
 * 元（字符串）→ 分（整数）
 * @throws 格式非法（空串、多于两位小数、含非法字符）或超出安全整数范围时抛错
 */
export function yuanToCents(input: string): number {
  const s = input.replace(/[¥￥,\s]/g, '');
  const m = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`金额格式非法: "${input}"`);
  const [, sign, intPart = '0', frac = ''] = m;
  const cents = Number(intPart) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error(`金额超出范围: "${input}"`);
  return sign === '-' ? -cents : cents;
}

/**
 * 分（整数）→ 展示字符串，如 123456 → "1,234.56"
 * @throws 非整数时抛错（防止把浮点数误传进来）
 */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`金额必须是安全整数（分）: ${cents}`);
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100).toLocaleString('en-US');
  const fen = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${yuan}.${fen}`;
}
