/**
 * 探针主入口：解析 samples/ 下的三份真实账单，输出校验报告（只输出统计信息，不输出明细，避免泄露隐私）
 *
 * 用法：npx tsx src/run.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseWechat } from './adapters/wechat.ts';
import { parseAlipay } from './adapters/alipay.ts';
import { parseCmbPdf } from './adapters/cmb-pdf.ts';
import { checkBalanceChain, checkSummary, findCrossSourceDuplicates } from './verify.ts';
import type { ParseResult } from './common.ts';

const SAMPLES = join(import.meta.dirname, '../../../samples');
const files = readdirSync(SAMPLES);
const pick = (pred: (n: string) => boolean) => {
  const f = files.find(pred);
  if (!f) throw new Error('samples/ 下缺少样本文件');
  return join(SAMPLES, f);
};

/** 统计某个字段的取值分布，了解状态 / 方向等枚举值有哪些 */
function distribution(result: ParseResult, key: 'status' | 'direction' | 'paymentMethod') {
  const m = new Map<string, number>();
  for (const r of result.records) m.set(String(r[key]), (m.get(String(r[key])) ?? 0) + 1);
  return Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
}

function report(result: ParseResult, extraIssues: { check: string; detail: string }[] = []) {
  const issues = [...checkSummary(result), ...extraIssues];
  const times = result.records.map((r) => r.occurredAt).sort();
  console.log(`\n### ${result.source}`);
  console.log(`解析笔数: ${result.records.length}  时间范围: ${times[0]} ~ ${times.at(-1)}`);
  console.log('文件汇总:', JSON.stringify(result.summary));
  console.log('方向分布:', distribution(result, 'direction'));
  console.log('状态分布:', distribution(result, 'status'));
  console.log(issues.length ? `❌ 校验问题 ${issues.length} 项:` : '✅ 校验全部通过');
  issues.slice(0, 10).forEach((i) => console.log(`   - [${i.check}] ${i.detail}`));
}

const wechat = await parseWechat(pick((n) => n.endsWith('.xlsx')));
report(wechat);

const alipay = parseAlipay(readFileSync(pick((n) => n.endsWith('.csv'))));
report(alipay);
console.log('支付方式 Top5:', Object.entries(distribution(alipay, 'paymentMethod')).slice(0, 5));

const cmb = await parseCmbPdf(new Uint8Array(readFileSync(pick((n) => n.endsWith('.pdf')))));
report(cmb, checkBalanceChain(cmb.records));
const wrapped = cmb.records.filter((r) => r.counterparty.length > 13).length;
console.log(`对手信息疑似折行拼接的笔数: ${wrapped}；对手信息为空的笔数: ${cmb.records.filter((r) => !r.counterparty).length}`);

// 跨来源重复
const dupA = findCrossSourceDuplicates(cmb.records, alipay.records, '招商银行');
const dupW = findCrossSourceDuplicates(cmb.records, wechat.records, '招商银行');
console.log(`\n### 跨来源重复（同日同额且平台支付方式为招行卡）`);
console.log(`支付宝 ↔ 招行: ${dupA.length} 对；微信 ↔ 招行: ${dupW.length} 对`);
const alipayViaCmb = alipay.records.filter((r) => r.paymentMethod?.includes('招商银行')).length;
console.log(`支付宝中用招行卡支付的笔数: ${alipayViaCmb}（其中能在招行流水中匹配上的: ${dupA.length}）`);
