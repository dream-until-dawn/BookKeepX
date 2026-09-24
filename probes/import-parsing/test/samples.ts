/**
 * 测试用真实样本定位
 *
 * samples/ 下有多份同扩展名的文件，不能再按扩展名随便取一个。
 * 这里按文件名精确定位"主样本"，并给出"全部新版格式样本 → 期望模板"的清单。
 *
 * 旧版格式（负责人 2026-09-24 决定不兼容）：
 *   - 微信 2024 年及以前导出的 csv
 *   - 被 Excel 重新保存过的支付宝 csv（alipay_record_2021：时间丢了秒、行尾逗号被改）
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const SAMPLES = join(import.meta.dirname, '../../../samples');
const files = existsSync(SAMPLES) ? readdirSync(SAMPLES) : [];

/** 三份主样本（2026-09 导出的当前格式） */
const PRIMARY = {
  wechat: (n: string) => n.startsWith('微信支付账单流水文件') && n.endsWith('.xlsx'),
  alipay: (n: string) => n.startsWith('支付宝交易明细') && n.endsWith('.csv'),
  cmb: (n: string) => n.startsWith('招商银行交易流水') && n.endsWith('.pdf'),
} as const;

export const hasSamples = Object.values(PRIMARY).every((p) => files.some(p));
if (!hasSamples) console.warn('⚠️ samples/ 下缺少主样本，真实样本测试已跳过 —— 探针结论不能据此成立');

/** 取主样本的完整路径 */
export function primary(kind: keyof typeof PRIMARY): string {
  const f = files.find(PRIMARY[kind]);
  if (!f) throw new Error(`缺少主样本: ${kind}`);
  return join(SAMPLES, f);
}

/** 判断是否为不兼容的旧版格式 */
export const isLegacy = (n: string) => /微信支付账单.*\.csv$/.test(n) || n === 'alipay_record_2021.csv';

/** 全部新版格式样本及其期望模板 */
export function currentFormatSamples(): { name: string; path: string; expected: string }[] {
  return files
    .filter((n) => !isLegacy(n))
    .map((n) => {
      const expected = n.endsWith('.pdf') ? 'cmb-pdf' : n.endsWith('.xlsx') && n.includes('微信') ? 'wechat-xlsx' : /alipay|支付宝/.test(n) ? 'alipay-csv' : null;
      if (!expected) throw new Error(`无法判断样本 ${n} 的期望模板，请在 test/samples.ts 中登记`);
      return { name: n, path: join(SAMPLES, n), expected };
    });
}

/** 旧版格式样本 */
export const legacySamples = () => files.filter(isLegacy).map((n) => ({ name: n, path: join(SAMPLES, n) }));
