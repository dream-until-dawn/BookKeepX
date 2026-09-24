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
