/**
 * P0-1 探针测试
 *
 * 分三组：
 *   1. 金额解析：正向 + 反向（非法格式必须抛错）
 *   2. 合成数据：不依赖真实样本，覆盖表头缺失、未知收支类型、"交易关闭"口径等
 *   3. 真实样本：正向（校验全过）+ 反向（篡改后校验必须报错，证明校验不是"永远绿"）
 *      真实样本只在本地 samples/ 存在，缺失时这一组会显式标记为跳过
 */
import { readFileSync } from 'node:fs';
import { hasSamples, primary } from './samples.ts';
import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import { yuanToCents } from '../src/common.ts';
import { parseAlipay } from '../src/adapters/alipay.ts';
import { parseWechat } from '../src/adapters/wechat.ts';
import { parseCmbPdf } from '../src/adapters/cmb-pdf.ts';
import { checkBalanceChain, checkSummary, findCrossSourceDuplicates } from '../src/verify.ts';

// ───────────────────────── 1. 金额解析 ─────────────────────────
describe('yuanToCents 金额解析', () => {
  it.each([
    ['6', 600],
    ['2635.95', 263595],
    ['1,800.00', 180000],
    ['-98.68', -9868],
    ['¥12.5', 1250],
    ['0.01', 1],
    [2635.95, 263595], // Excel 数字单元格
    [0.1, 10],
  ])('正向：%s → %i 分', (input, expected) => {
    expect(yuanToCents(input)).toBe(expected);
  });

  it.each(['', 'abc', '1.234', '12.3.4', '1e5', '--1', '¥'])('反向：非法输入 "%s" 必须抛错', (input) => {
    expect(() => yuanToCents(input)).toThrow(/金额格式非法/);
  });
});

// ───────────────────────── 2. 合成数据 ─────────────────────────
/** 构造一份最小的支付宝 csv（GBK 编码），前言中带汇总 */
function fakeAlipayCsv(rows: string[], summary: string): Buffer {
  const text = [
    '导出信息：',
    `共${rows.length}笔记录`,
    summary,
    '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,',
    ...rows,
  ].join('\r\n');
  return iconv.encode(text, 'gbk');
}

describe('支付宝解析（合成数据）', () => {
  const ok = '2026-09-01 12:00:00,餐饮美食,某店,/,午饭,支出,32.50,余额宝,交易成功,2026090100001\t,\t,,';
  const closed = '2026-09-01 13:00:00,餐饮美食,某店,/,取消的单,支出,0.09,余额宝,交易关闭,2026090100002\t,\t,,';

  it('正向：GBK 编码能解码，订单号尾部制表符被去掉', () => {
    const r = parseAlipay(fakeAlipayCsv([ok], '支出：1笔 32.50元'));
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ amountCents: 3250, direction: 'expense', externalId: '2026090100001' });
    expect(checkSummary(r)).toEqual([]);
  });

  // 下面三条用来区分两种口径推测：旧推测"交易关闭不计金额"、新推测"全部计入，退款从支出中扣除"
  const refund = '2026-09-02 10:00:00,退款,某店,/,退款-午饭,不计收支,2.00,余额宝,退款成功,2026090200003\t,\t,,';

  it('正向（口径）："交易关闭"的支出也计入金额', () => {
    const r = parseAlipay(fakeAlipayCsv([ok, closed], '支出：2笔 32.59元'));
    expect(checkSummary(r)).toEqual([]);
  });

  it('正向（口径）："退款成功"的金额从支出汇总中扣除，自身计入不计收支', () => {
    const r = parseAlipay(fakeAlipayCsv([ok, refund], '支出：1笔 30.50元\n不计收支：1笔 2.00元'));
    expect(checkSummary(r)).toEqual([]);
  });

  it('反向（口径）：按旧推测"交易关闭不计金额"写的汇总 → 必须报金额不符', () => {
    const r = parseAlipay(fakeAlipayCsv([ok, closed], '支出：2笔 32.50元'));
    expect(checkSummary(r)).toEqual([expect.objectContaining({ check: 'expense 金额' })]);
  });

  it('反向：汇总金额对不上时必须报告问题', () => {
    const r = parseAlipay(fakeAlipayCsv([ok], '支出：1笔 32.51元'));
    expect(checkSummary(r)).toEqual([expect.objectContaining({ check: 'expense 金额' })]);
  });

  it('反向：缺少表头 → 抛错（不是支付宝账单）', () => {
    expect(() => parseAlipay(iconv.encode('a,b,c\r\n1,2,3', 'gbk'))).toThrow(/未找到表头/);
  });

  it('反向：未知收支类型 → 抛错，而不是静默归类', () => {
    const bad = ok.replace(',支出,', ',奇怪,');
    expect(() => parseAlipay(fakeAlipayCsv([bad], ''))).toThrow(/未知收支类型/);
  });

  it('反向：金额为 0 → 抛错', () => {
    const bad = ok.replace(',32.50,', ',0.00,');
    expect(() => parseAlipay(fakeAlipayCsv([bad], ''))).toThrow(/金额应为正数/);
  });
});

describe('余额链校验（合成数据）', () => {
  const rec = (dir: 'income' | 'expense', amt: number, bal: number) =>
    ({ occurredAt: '2026-01-01 00:00:00', direction: dir, amountCents: amt, balanceCents: bal, counterparty: '', description: '', externalId: null, paymentMethod: null, status: null }) as const;

  it('正向：连续的余额链通过', () => {
    expect(checkBalanceChain([rec('income', 100, 100), rec('expense', 30, 70), rec('income', 5, 75)])).toEqual([]);
  });

  it('反向：中间漏掉一笔 → 断链', () => {
    expect(checkBalanceChain([rec('income', 100, 100), rec('income', 5, 75)])).toHaveLength(1);
  });

  it('反向：方向解析反了 → 断链', () => {
    expect(checkBalanceChain([rec('income', 100, 100), rec('income', 30, 70)])).toHaveLength(1);
  });
});

// ───────────────────────── 3. 真实样本 ─────────────────────────
/** 按扩展名取对应的主样本（P0-1 的三份文件） */
const sample = (ext: '.xlsx' | '.csv' | '.pdf') => primary(ext === '.xlsx' ? 'wechat' : ext === '.csv' ? 'alipay' : 'cmb');

describe.skipIf(!hasSamples)('真实样本', () => {
  it('微信：正向 —— 笔数与金额和文件汇总一致', async () => {
    const r = await parseWechat(sample('.xlsx'));
    expect(r.records.length).toBeGreaterThan(0);
    expect(checkSummary(r)).toEqual([]);
  });

  it('微信：时间按北京时间墙上时间还原（不偏移 8 小时）', async () => {
    const r = await parseWechat(sample('.xlsx'));
    // 文件前言写明了起止时间，所有记录必须落在这个区间内；若误差 8 小时，边界记录会越界
    const times = r.records.map((x) => x.occurredAt).sort();
    expect(times[0]! >= '2026-08-24 00:00:00').toBe(true);
    expect(times.at(-1)! <= '2026-09-24 13:55:48').toBe(true);
  });

  it('微信：反向 —— 删掉一笔后校验必须报错', async () => {
    const r = await parseWechat(sample('.xlsx'));
    r.records.pop();
    expect(checkSummary(r).length).toBeGreaterThan(0);
  });

  it('支付宝：正向 —— 笔数与金额和文件汇总一致', () => {
    expect(checkSummary(parseAlipay(readFileSync(sample('.csv'))))).toEqual([]);
  });

  it('支付宝：反向 —— 篡改一笔金额（+1 分）后校验必须报错', () => {
    const r = parseAlipay(readFileSync(sample('.csv')));
    const target = r.records.find((x) => x.direction === 'expense' && x.status === '交易成功')!;
    target.amountCents += 1;
    expect(checkSummary(r)).toEqual([expect.objectContaining({ check: 'expense 金额' })]);
  });

  it('支付宝：反向 —— 用微信 xlsx 冒充支付宝 csv 必须抛错', () => {
    expect(() => parseAlipay(readFileSync(sample('.xlsx')))).toThrow();
  });

  it('招行 PDF：正向 —— 跨页余额链完整', async () => {
    const r = await parseCmbPdf(new Uint8Array(readFileSync(sample('.pdf'))));
    expect(r.records.length).toBeGreaterThan(50);
    expect(checkBalanceChain(r.records)).toEqual([]);
  });

  it('招行 PDF：折行的对手信息被拼接完整（不残留为独立记录、不为空）', async () => {
    const r = await parseCmbPdf(new Uint8Array(readFileSync(sample('.pdf'))));
    expect(r.records.every((x) => x.counterparty.length > 0)).toBe(true);
    expect(r.records.some((x) => x.counterparty.includes('应付个人活期存款利息'))).toBe(true);
  });

  it('招行 PDF：反向 —— 删掉中间一笔后余额链必须断', async () => {
    const r = await parseCmbPdf(new Uint8Array(readFileSync(sample('.pdf'))));
    r.records.splice(10, 1);
    expect(checkBalanceChain(r.records).length).toBeGreaterThan(0);
  });

  it('招行 PDF：反向 —— 非招行 PDF 数据必须抛错', async () => {
    await expect(parseCmbPdf(new Uint8Array(Buffer.from('%PDF-1.4 not a real pdf')))).rejects.toThrow();
  });

  it('跨来源：支付宝理财申购（中性）能与招行支出匹配上', async () => {
    const cmb = await parseCmbPdf(new Uint8Array(readFileSync(sample('.pdf'))));
    const ali = parseAlipay(readFileSync(sample('.csv')));
    const pairs = findCrossSourceDuplicates(cmb.records, ali.records, '招商银行');
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    expect(pairs.every((p) => p.platform.direction === 'neutral' || p.platform.direction === p.bank.direction)).toBe(true);
  });
});
