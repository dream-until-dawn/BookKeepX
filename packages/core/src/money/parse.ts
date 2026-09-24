/**
 * 金额解析：元 → 分（ADR-0002）
 *
 * 全程按字符串拆分整数与小数部分计算，不经过任何浮点运算；
 * 任何无法精确表示为"分"的输入都报错，绝不静默四舍五入。
 */
import { MoneyParseError } from './errors.ts';

/** 全角数字、小数点、逗号、正负号 → 半角（用户用中文输入法输入金额时常见） */
function toHalfWidth(s: string): string {
  return s.replace(/[０-９．，－＋]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/**
 * 严格的数字格式：可选正负号 + 整数部分 + 可选的 1~2 位小数。
 * 整数部分要么不带千分位，要么是规范的千分位（1,234,567），拒绝 1,23 这类错误写法。
 */
const STRICT = /^([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/;

/**
 * 把"元"表示的金额转成整数"分"
 *
 * @param input 字符串（如 "¥1,234.5"、"-98.68"、"602.00元"）或 Excel 数字单元格的值
 * @returns 带符号的分（银行流水用负号表示支出，所以保留符号；是否允许负数由调用方决定）
 * @throws MoneyParseError 错误码见 MoneyErrorCode
 */
export function parseYuanToCents(input: string | number): number {
  // Excel 数字单元格：String() 给出最短的十进制表示（2635.95 → "2635.95"），
  // 浮点误差（0.1+0.2 → "0.30000000000000004"）会在下面的小数位检查中被拒绝
  if (typeof input === 'number' && !Number.isFinite(input)) {
    throw new MoneyParseError('FORMAT', input, `金额不是有效数字: ${input}`);
  }
  const raw = typeof input === 'number' ? String(input) : input;
  if (/e/i.test(raw) && typeof input === 'number') {
    // 极大 / 极小的数字会被 String() 写成科学计数法，不可能是合法的"元"
    throw new MoneyParseError('OVERFLOW', input, `金额超出范围: ${raw}`);
  }

  // 统一为半角；只去掉首尾空白、货币符号（及其旁边的空白）、"元"后缀。
  // 数字中间的空白不去掉："1 000" 有歧义（可能是误输入），按格式错误处理
  const s = toHalfWidth(raw)
    .trim()
    .replace(/^([+-]?)\s*[¥￥]\s*/, '$1')
    .replace(/\s*元$/, '');
  if (s === '' || s === '+' || s === '-') throw new MoneyParseError('EMPTY', input, '金额为空');

  const m = STRICT.exec(s);
  if (!m) throw new MoneyParseError('FORMAT', input, `金额格式非法: "${raw}"`);
  const [, sign = '', intPart = '0', frac = ''] = m;
  if (frac.length > 2) throw new MoneyParseError('PRECISION', input, `金额最多两位小数: "${raw}"`);

  const cents = Number(intPart.replace(/,/g, '')) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new MoneyParseError('OVERFLOW', input, `金额超出范围: "${raw}"`);
  // 避免产生 -0
  return sign === '-' && cents !== 0 ? -cents : cents;
}
