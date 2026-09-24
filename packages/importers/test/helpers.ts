/**
 * 测试工具：合成账单（CI 上没有真实样本）与真实样本定位（仅本机 samples/ 下存在）
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import iconv from 'iconv-lite';

type AlipayRow = [
  time: string,
  category: string,
  dir: string,
  amount: string,
  status: string,
  id: string,
  desc?: string,
];

/**
 * 构造支付宝 csv（GBK 编码、前言 CRLF、数据 LF，与真实文件形态一致）
 * 汇总行按支付宝口径（全部计入、退款从支出扣除）自动计算，也可以手动覆盖以测试"汇总对不上"
 */
export function alipayCsv(rows: AlipayRow[], opts: { summary?: string[]; holder?: string } = {}): Buffer {
  const cents = (s: string) => Math.round(Number(s) * 100); // 仅测试夹具内使用
  const sum = (d: string) => rows.filter((r) => r[2] === d).reduce((a, r) => a + cents(r[3]), 0);
  const cnt = (d: string) => rows.filter((r) => r[2] === d).length;
  const refunds = rows.filter((r) => r[4] === '退款成功').reduce((a, r) => a + cents(r[3]), 0);
  const y = (c: number) => (c / 100).toFixed(2);
  const summary = opts.summary ?? [
    `收入：${cnt('收入')}笔 ${y(sum('收入'))}元`,
    `支出：${cnt('支出')}笔 ${y(sum('支出') - refunds)}元`,
    `不计收支：${cnt('不计收支')}笔 ${y(sum('不计收支'))}元`,
  ];
  const preamble = [
    '------------------------------------------------------------------------------------',
    '导出信息：',
    `姓名：${opts.holder ?? '张三'}`,
    '支付宝账户：test@example.com',
    `共${rows.length}笔记录`,
    ...summary,
    '------------------------支付宝支付科技有限公司  电子客户回单------------------------',
  ].join('\r\n');
  const header =
    '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,';
  const data = rows.map(
    ([time, category, dir, amount, status, id, desc = '商品']) =>
      `${time},${category},某店,/,${desc},${dir},${amount},余额宝,${status},${id}\t,\t,,`,
  );
  return iconv.encode(`${preamble}\r\n${header}\n${data.join('\n')}\n`, 'gbk');
}

/**
 * 构造"某银行"活期明细 csv（UTF-8）：收入、支出分两列，带余额；默认按时间倒序（新 → 旧），与多数银行导出一致
 * rows 按时间正序给出，[日期, 摘要, 对方, 收入, 支出]；余额从 opening 起自动累计
 */
export function bankCsv(
  rows: [date: string, memo: string, counterparty: string, income: string, expense: string][],
  opts: { opening?: number; order?: 'asc' | 'desc'; breakBalanceAt?: number } = {},
): Buffer {
  let balance = opts.opening ?? 100000;
  const lines = rows.map(([date, memo, cp, inc, exp], i) => {
    balance += Math.round(Number(inc || 0) * 100) - Math.round(Number(exp || 0) * 100);
    // 故意把某一行的余额写错，用于测试余额校验
    const shown = i === opts.breakBalanceAt ? balance + 1 : balance;
    return `${date},${memo},${cp},${inc},${exp},${(shown / 100).toFixed(2)}`;
  });
  if ((opts.order ?? 'desc') === 'desc') lines.reverse();
  const text = [
    '某某银行活期账户交易明细',
    '账号：6222 **** **** 5678',
    '',
    '交易日期,摘要,对方户名,收入金额,支出金额,账户余额',
    ...lines,
  ].join('\r\n');
  return Buffer.from(`${text}\r\n`, 'utf-8');
}

/** 上面这种银行文件的向导配置（spec） */
export const BANK_SPEC = {
  fileType: 'csv',
  sourceKind: 'bank_debit',
  header: ['交易日期', '摘要', '对方户名', '收入金额', '支出金额', '账户余额'],
  columns: {
    occurredAt: '交易日期',
    description: '摘要',
    counterparty: '对方户名',
    income: '收入金额',
    expense: '支出金额',
    balance: '账户余额',
  },
  amountMode: 'split',
  timeFormat: 'yyyy-MM-dd',
  balanceCheck: true,
} as const;

/** 旧版微信 csv 的向导配置（真实样本探针用，import.md §9.1） */
export const LEGACY_WECHAT_SPEC = {
  fileType: 'csv',
  sourceKind: 'wechat',
  header: [
    '交易时间',
    '交易类型',
    '交易对方',
    '商品',
    '收/支',
    '金额(元)',
    '支付方式',
    '当前状态',
    '交易单号',
    '商户单号',
    '备注',
  ],
  columns: {
    occurredAt: '交易时间',
    categoryHint: '交易类型',
    counterparty: '交易对方',
    description: '商品',
    direction: '收/支',
    amount: '金额(元)',
    paymentMethod: '支付方式',
    status: '当前状态',
    externalId: '交易单号',
  },
  amountMode: 'directionColumn',
  directionMap: { 收入: 'income', 支出: 'expense', '/': 'neutral' },
  timeFormat: 'yyyy-MM-dd HH:mm:ss',
} as const;

/** 旧版支付宝 csv（2021）的向导配置：时间为宽松格式 "2021/12/31 8:54" */
export const LEGACY_ALIPAY_SPEC = {
  fileType: 'csv',
  sourceKind: 'alipay',
  header: [
    '交易时间',
    '交易分类',
    '交易对方',
    '对方账号',
    '商品说明',
    '收/支',
    '金额',
    '收/付款方式',
    '交易状态',
    '交易订单号',
    '商家订单号',
    '备注',
  ],
  columns: {
    occurredAt: '交易时间',
    categoryHint: '交易分类',
    counterparty: '交易对方',
    description: '商品说明',
    direction: '收/支',
    amount: '金额',
    paymentMethod: '收/付款方式',
    status: '交易状态',
    externalId: '交易订单号',
  },
  amountMode: 'directionColumn',
  directionMap: { 收入: 'income', 支出: 'expense', 不计收支: 'neutral' },
  skipStatuses: ['交易关闭'],
  timeFormat: 'yyyy/M/d H:mm',
} as const;

// ───── 真实样本（本机 samples/，已 gitignore） ─────
export const SAMPLES = join(import.meta.dirname, '../../../samples');
const files = existsSync(SAMPLES) ? readdirSync(SAMPLES) : [];
/** 负责人决定不兼容的旧版格式（P0-1d） */
const isLegacy = (n: string) => /微信支付账单.*\.csv$/.test(n) || n === 'alipay_record_2021.csv';

export const hasSamples = files.some((n) => n.startsWith('支付宝交易明细'));

export function currentFormatSamples(): { name: string; path: string; expected: string }[] {
  return files
    .filter((n) => !isLegacy(n))
    .map((n) => {
      const expected = n.endsWith('.pdf')
        ? 'cmb-pdf'
        : n.endsWith('.xlsx') && n.includes('微信')
          ? 'wechat-xlsx'
          : /alipay|支付宝/.test(n)
            ? 'alipay-csv'
            : null;
      if (!expected) throw new Error(`无法判断样本 ${n} 的期望模板`);
      return { name: n, path: join(SAMPLES, n), expected };
    });
}

export const legacySamples = () => files.filter(isLegacy).map((n) => ({ name: n, path: join(SAMPLES, n) }));
