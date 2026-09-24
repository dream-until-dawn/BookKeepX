/**
 * P0-1e 测试：退款关联 + 冲减支出（负责人决定方案 B）
 */
import { readFileSync } from 'node:fs';
import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import { detect, loadBuiltinTemplates, parseWith, readDoc } from '../src/engine/index.ts';
import { linkRefunds, type LinkedRecord } from '../src/engine/refund.ts';
import { buildConfig, classify } from '../src/categorize/index.ts';
import { computeStats } from '../src/stats.ts';
import { currentFormatSamples, hasSamples } from './samples.ts';

const templates = loadBuiltinTemplates();
const byId = (id: string) => templates.find((t) => t.id === id)!;
const cfg = buildConfig();

// ───────────────────────── 支付宝（端到端，合成 csv） ─────────────────────────
/** 构造支付宝 csv；汇总行按支付宝口径自动计算，保证自校验能通过（本组测的是关联，不是校验） */
function alipayCsv(rows: [time: string, dir: string, amount: string, status: string, id: string, desc?: string][]) {
  const cents = (s: string) => Math.round(Number(s) * 100); // 仅测试夹具内使用
  const sum = (d: string) => rows.filter((r) => r[1] === d).reduce((a, r) => a + cents(r[2]), 0);
  const refunds = rows.filter((r) => r[3] === '退款成功').reduce((a, r) => a + cents(r[2]), 0);
  const cnt = (d: string) => rows.filter((r) => r[1] === d).length;
  const y = (c: number) => (c / 100).toFixed(2);
  const lines = [
    '导出信息：',
    `共${rows.length}笔记录`,
    `收入：${cnt('收入')}笔 ${y(sum('收入'))}元`,
    `支出：${cnt('支出')}笔 ${y(sum('支出') - refunds)}元`,
    `不计收支：${cnt('不计收支')}笔 ${y(sum('不计收支'))}元`,
    '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,',
    ...rows.map(([time, dir, amount, status, id, desc = '商品']) => `${time},${dir === '不计收支' ? '退款' : '餐饮美食'},某店,/,${desc},${dir},${amount},余额宝,${status},${id}\t,\t,,`),
  ];
  return iconv.encode(lines.join('\r\n'), 'gbk');
}
const parseAli = async (rows: Parameters<typeof alipayCsv>[0]) => parseWith(await readDoc(alipayCsv(rows)), byId('alipay-csv'));
const statsOf = (records: LinkedRecord[], source: string) => computeStats(records.map((rec) => ({ rec, cls: classify({ ...rec, source }, cfg) })));

describe('支付宝退款关联（按单号前缀，精确）', () => {
  it('正向：部分退款关联到原消费，净支出 = 原价 − 退款，冲减在原消费的分类', async () => {
    const r = await parseAli([
      ['2026-09-01 12:00:00', '支出', '50.00', '交易成功', 'A001'],
      ['2026-09-02 12:00:00', '不计收支', '8.00', '退款成功', 'A001_R1', '退款-商品'],
    ]);
    expect(r.issues).toEqual([]);
    expect(r.records.find((x) => x.refund)!.refund).toEqual({ linkedTo: 'A001' });
    const s = statsOf(r.records, 'alipay-csv');
    expect(s.expenseCents).toBe(4200);
    expect(s.byTopCategory.get('expense.food')).toBe(4200);
  });

  it('正向：全额退款后原消费变成"交易关闭"—— 恢复入账并与退款抵消，净额为 0', async () => {
    const r = await parseAli([
      ['2026-09-01 12:00:00', '支出', '179.00', '交易关闭', 'B001'],
      ['2026-09-03 12:00:00', '不计收支', '179.00', '退款成功', 'B001_x_advance', '退款-主板'],
    ]);
    expect(r.refundStats).toEqual({ refunds: 1, linked: 1, restored: 1 });
    expect(r.skipped).toHaveLength(0);
    expect(statsOf(r.records, 'alipay-csv').expenseCents).toBe(0);
  });

  it('正向：单号用 "*" 分隔也能识别前缀', async () => {
    const r = await parseAli([
      ['2026-09-01 12:00:00', '支出', '17.60', '交易成功', 'C001'],
      ['2026-09-02 12:00:00', '不计收支', '1.76', '退款成功', 'C001*2184_1615', '退款-洗脸巾'],
    ]);
    expect(r.records.find((x) => x.refund)!.refund!.linkedTo).toBe('C001');
  });

  it('反向：没有退款的"交易关闭"仍然跳过，不入账', async () => {
    const r = await parseAli([['2026-09-01 12:00:00', '支出', '9.00', '交易关闭', 'D001']]);
    expect(r.records).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
  });

  it('反向：原消费不在本文件中 → 不关联（linkedTo=null），统计时冲减"其他支出"并计为待确认', async () => {
    const r = await parseAli([['2026-09-02 12:00:00', '不计收支', '8.00', '退款成功', 'ZZZ_R1', '退款-商品']]);
    expect(r.records[0]!.refund).toEqual({ linkedTo: null });
    const s = statsOf(r.records, 'alipay-csv');
    expect(s.unlinkedRefunds).toBe(1);
    expect(s.byTopCategory.get('expense.other')).toBe(-800);
  });

  it('反向：退款金额超过原消费 → 不关联，交给用户确认', async () => {
    const r = await parseAli([
      ['2026-09-01 12:00:00', '支出', '5.00', '交易成功', 'E001'],
      ['2026-09-02 12:00:00', '不计收支', '8.00', '退款成功', 'E001_R1', '退款-商品'],
    ]);
    expect(r.records.find((x) => x.refund)!.refund!.linkedTo).toBeNull();
  });

  it('边界：同一原消费多次部分退款累计冲减；累计超额的那笔不关联', async () => {
    const r = await parseAli([
      ['2026-09-01 12:00:00', '支出', '10.00', '交易成功', 'F001'],
      ['2026-09-02 12:00:00', '不计收支', '6.00', '退款成功', 'F001_1', '退款-1'],
      ['2026-09-03 12:00:00', '不计收支', '4.00', '退款成功', 'F001_2', '退款-2'],
      ['2026-09-04 12:00:00', '不计收支', '0.01', '退款成功', 'F001_3', '退款-3'],
    ]);
    const links = r.records.filter((x) => x.refund).map((x) => x.refund!.linkedTo);
    expect(links).toEqual(['F001', 'F001', null]);
  });
});

// ───────────────────────── 微信（直接测关联函数） ─────────────────────────
const wx = (over: Partial<LinkedRecord>): LinkedRecord => ({
  occurredAt: '2025-05-01 12:00:00',
  direction: 'expense',
  amountCents: 1000,
  counterparty: '某超市',
  description: '',
  externalId: null,
  paymentMethod: '零钱',
  status: '支付成功',
  categoryHint: '商户消费',
  ...over,
});
const wxRefund = (over: Partial<LinkedRecord>) => wx({ direction: 'income', categoryHint: '某超市-退款', occurredAt: '2025-05-02 12:00:00', ...over });
const linkWx = (records: LinkedRecord[]) => linkRefunds(records, [], byId('wechat-xlsx')).records;

describe('微信退款关联（按对方 + 状态，启发式）', () => {
  it('正向：同对方、原消费状态"已退款(￥x)" → 关联', () => {
    const out = linkWx([wx({ externalId: 'W1', amountCents: 9496, status: '已退款(￥0.12)' }), wxRefund({ externalId: 'R1', amountCents: 12, status: '已退款￥0.12' })]);
    expect(out[1]!.refund).toEqual({ linkedTo: 'W1' });
  });

  it('正向（兜底）：对方名称不同（"京东" vs "京东商城平台商户"），按"已全额退款 + 金额相同"关联', () => {
    const out = linkWx([
      wx({ externalId: 'W2', counterparty: '京东', amountCents: 3161, status: '已全额退款' }),
      wxRefund({ externalId: 'R2', counterparty: '京东商城平台商户', amountCents: 3161, status: '已全额退款' }),
    ]);
    expect(out[1]!.refund!.linkedTo).toBe('W2');
  });

  it('正向（兜底）：被退回的转账（退款行对方为空）关联到时间最近的那笔全额退款转账', () => {
    const out = linkWx([
      wx({ externalId: 'T1', counterparty: '家人A', amountCents: 100000, status: '已全额退款', occurredAt: '2025-05-10 11:00:00', categoryHint: '转账' }),
      wx({ externalId: 'T2', counterparty: '家人B', amountCents: 100000, status: '已全额退款', occurredAt: '2025-06-15 11:00:00', categoryHint: '转账' }),
      wxRefund({ externalId: 'R3', counterparty: '', amountCents: 100000, status: '已全额退款', occurredAt: '2025-05-11 11:00:00', categoryHint: '转账-退款' }),
      wxRefund({ externalId: 'R4', counterparty: '', amountCents: 100000, status: '已全额退款', occurredAt: '2025-06-16 11:00:00', categoryHint: '转账-退款' }),
    ]);
    expect(out.filter((x) => x.refund).map((x) => x.refund!.linkedTo)).toEqual(['T1', 'T2']);
  });

  it('反向（兜底）：原消费晚于退款 → 不关联', () => {
    const out = linkWx([
      wx({ externalId: 'W5', counterparty: '甲', amountCents: 500, status: '已全额退款', occurredAt: '2025-05-20 12:00:00' }),
      wxRefund({ externalId: 'R5', counterparty: '乙', amountCents: 500, status: '已全额退款', occurredAt: '2025-05-02 12:00:00' }),
    ]);
    expect(out[1]!.refund!.linkedTo).toBeNull();
  });

  it('反向：原消费状态没有退款字样 → 不关联（避免把普通消费误当成原消费）', () => {
    const out = linkWx([wx({ externalId: 'W6', amountCents: 500, status: '支付成功' }), wxRefund({ externalId: 'R6', amountCents: 500, status: '已全额退款' })]);
    expect(out[1]!.refund!.linkedTo).toBeNull();
  });

  it('正向：退款不计入收入（微信把退款记成收入，方案 B 纠正）', () => {
    const out = linkWx([wx({ externalId: 'W7', amountCents: 2000, status: '已退款(￥5.00)' }), wxRefund({ externalId: 'R7', amountCents: 500, status: '已退款￥5.00' })]);
    const s = statsOf(out, 'wechat-xlsx');
    expect(s.incomeCents).toBe(0);
    expect(s.expenseCents).toBe(1500);
  });
});

// ───────────────────────── 真实样本 ─────────────────────────
describe.skipIf(!hasSamples)('真实样本退款', () => {
  for (const s of hasSamples ? currentFormatSamples().filter((x) => x.expected !== 'cmb-pdf') : []) {
    it(`${s.name}：全部退款都关联到原消费`, async () => {
      const r = parseWith(await readDoc(readFileSync(s.path)), byId(s.expected));
      expect(r.refundStats.linked).toBe(r.refundStats.refunds);
    });
  }

  // 最强的交叉验证：支付宝官方的支出汇总口径就是"退款冲减支出"，方案 B 算出的净支出必须与之分毫不差
  for (const s of hasSamples ? currentFormatSamples().filter((x) => x.expected === 'alipay-csv') : []) {
    it(`${s.name}：按方案 B 算出的净支出 = 支付宝文件声明的支出汇总`, async () => {
      const doc = await readDoc(readFileSync(s.path));
      expect(detect(doc, s.name, templates).kind).toBe('auto');
      const r = parseWith(doc, byId('alipay-csv'));
      // 用平台原始方向（不经分类规则改向），只检验退款冲减本身
      const st = computeStats(r.records.map((rec) => ({ rec, cls: { categoryKey: null, direction: rec.direction, source: 'none', reason: null } })));
      expect(st.expenseCents).toBe(r.summary.expense!.cents);
    });
  }
});
