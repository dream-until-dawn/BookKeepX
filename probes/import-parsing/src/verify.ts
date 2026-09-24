/**
 * 解析结果的自校验
 *
 * 核心思路：不相信解析器，用文件自身携带的"冗余信息"反证解析是否正确。
 *   - 微信 / 支付宝：文件头有各方向的笔数和金额汇总 → 与逐行累加比对
 *   - 招行 PDF：每行都有交易后余额 → 上一行余额 + 本行金额 必须等于 本行余额（余额链）
 */
import type { Direction, ParseResult, ParsedRecord } from './common.ts';

export interface CheckIssue {
  check: string;
  detail: string;
}

/**
 * 各平台汇总的统计口径：哪些状态的记录"计入笔数但不计入金额"。
 * 支付宝：实测"交易关闭"的记录计入了笔数，但金额不计入汇总（样本中差额恰为该笔的 9 分）。
 */
const EXCLUDED_FROM_AMOUNT: Partial<Record<ParseResult['source'], string[]>> = {
  alipay: ['交易关闭'],
};

/** 按方向累加笔数和金额，与文件汇总逐项比对 */
export function checkSummary(result: ParseResult): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const { summary, records } = result;
  if (summary.total !== undefined && summary.total !== records.length) {
    issues.push({ check: '总笔数', detail: `文件声明 ${summary.total} 笔，实际解析 ${records.length} 笔` });
  }
  for (const dir of ['income', 'expense', 'neutral'] as Direction[]) {
    const expected = summary[dir];
    if (!expected) continue;
    const rows = records.filter((r) => r.direction === dir);
    const excluded = EXCLUDED_FROM_AMOUNT[result.source] ?? [];
    const cents = rows.filter((r) => !excluded.includes(r.status ?? '')).reduce((s, r) => s + r.amountCents, 0);
    if (rows.length !== expected.count) issues.push({ check: `${dir} 笔数`, detail: `声明 ${expected.count}，实际 ${rows.length}` });
    if (cents !== expected.cents) issues.push({ check: `${dir} 金额`, detail: `声明 ${expected.cents} 分，实际 ${cents} 分，差 ${cents - expected.cents} 分` });
  }
  return issues;
}

/** 银行余额链校验：记录需按账单原始顺序（时间升序）排列 */
export function checkBalanceChain(records: ParsedRecord[]): CheckIssue[] {
  const issues: CheckIssue[] = [];
  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1]!;
    const cur = records[i]!;
    const signed = cur.direction === 'income' ? cur.amountCents : -cur.amountCents;
    if (prev.balanceCents === undefined || cur.balanceCents === undefined) {
      issues.push({ check: '余额链', detail: `第 ${i} 笔缺少余额` });
    } else if (prev.balanceCents + signed !== cur.balanceCents) {
      issues.push({ check: '余额链', detail: `第 ${i} 笔（${cur.occurredAt}）断链：${prev.balanceCents} + ${signed} ≠ ${cur.balanceCents}` });
    }
  }
  return issues;
}

/**
 * 跨来源重复探测：银行流水里"快捷支付"到支付宝 / 财付通的那一笔，
 * 很可能在支付宝 / 微信账单里也有一笔（用银行卡支付的消费）。
 * 探针阶段只做最朴素的匹配：同一天 + 同金额 + 平台账单的支付方式里提到了该银行。
 */
export function findCrossSourceDuplicates(bank: ParsedRecord[], platform: ParsedRecord[], bankKeyword: string) {
  const pairs: { bank: ParsedRecord; platform: ParsedRecord }[] = [];
  for (const p of platform) {
    if (!p.paymentMethod?.includes(bankKeyword)) continue;
    const day = p.occurredAt.slice(0, 10);
    // 方向不要求一致：银行记"支出"的理财申购，在支付宝里是"不计收支"（中性），恰恰是最需要识别的一类
    const hit = bank.find((b) => b.occurredAt.slice(0, 10) === day && b.amountCents === p.amountCents && (b.direction === p.direction || p.direction === 'neutral'));
    if (hit) pairs.push({ bank: hit, platform: p });
  }
  return pairs;
}
