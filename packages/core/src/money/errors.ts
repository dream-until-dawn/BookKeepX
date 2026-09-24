/**
 * 金额解析错误
 *
 * 带错误码，方便调用方区分原因（导入时逐行报告、表单里给出对应提示），而不是只能比对错误文字。
 */
export type MoneyErrorCode =
  /** 空字符串或只有空白 / 货币符号 */
  | 'EMPTY'
  /** 含非法字符、多个小数点、千分位位置不对等 */
  | 'FORMAT'
  /** 超过两位小数（金额最小单位是分） */
  | 'PRECISION'
  /** 超出 JS 安全整数范围 */
  | 'OVERFLOW';

export class MoneyParseError extends Error {
  constructor(
    readonly code: MoneyErrorCode,
    /** 原始输入，便于定位是哪一个值出错 */
    readonly input: string | number,
    message: string,
  ) {
    super(message);
    this.name = 'MoneyParseError';
  }
}
