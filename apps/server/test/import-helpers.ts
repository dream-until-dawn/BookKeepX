/**
 * 导入测试工具：multipart 上传、合成支付宝账单
 */
import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from '@bookkeepx/contracts';
import iconv from 'iconv-lite';
import type { buildApp } from '../src/app.ts';
import { SESSION_COOKIE } from '../src/modules/auth/sessions.ts';
import type { TestUser } from './api-helpers.ts';

type App = ReturnType<typeof buildApp>;

/** 以 multipart/form-data 上传一个文件（可附带普通字段） */
export function upload(app: App, user: TestUser, bytes: Buffer, fileName: string, fields: Record<string, string> = {}) {
  const boundary = `----bkx${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${encodeURIComponent(fileName)}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return app.inject({
    method: 'POST',
    url: `/api/ledgers/${user.ledgerId}/imports`,
    headers: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE, 'content-type': `multipart/form-data; boundary=${boundary}` },
    cookies: { [SESSION_COOKIE]: user.token },
    payload: Buffer.concat(parts),
  });
}

export interface AlipayRowSpec {
  time?: string;
  category?: string;
  counterparty?: string;
  desc?: string;
  dir?: '支出' | '收入' | '不计收支';
  amount: string;
  pay?: string;
  status?: string;
  id: string;
}

/**
 * 合成支付宝 csv（GBK、前言 CRLF、数据 LF，与真实文件一致）
 * 汇总按支付宝口径自动计算；传 summary 可覆盖以测试"汇总对不上"
 */
export function alipayCsv(rows: AlipayRowSpec[], opts: { summary?: string[]; holder?: string } = {}): Buffer {
  const cents = (s: string) => Math.round(Number(s) * 100); // 仅测试夹具内使用
  const full = rows.map((r) => ({
    time: '2026-09-01 12:00:00',
    category: '餐饮美食',
    counterparty: '某店',
    desc: '商品',
    dir: '支出' as const,
    pay: '余额宝',
    status: '交易成功',
    ...r,
  }));
  const sum = (d: string) => full.filter((r) => r.dir === d).reduce((a, r) => a + cents(r.amount), 0);
  const cnt = (d: string) => full.filter((r) => r.dir === d).length;
  const refunds = full.filter((r) => r.status === '退款成功').reduce((a, r) => a + cents(r.amount), 0);
  const y = (c: number) => (c / 100).toFixed(2);
  const summary = opts.summary ?? [
    `收入：${cnt('收入')}笔 ${y(sum('收入'))}元`,
    `支出：${cnt('支出')}笔 ${y(sum('支出') - refunds)}元`,
    `不计收支：${cnt('不计收支')}笔 ${y(sum('不计收支'))}元`,
  ];
  const preamble = [
    '导出信息：',
    `姓名：${opts.holder ?? '张三'}`,
    '支付宝账户：test@example.com',
    `共${full.length}笔记录`,
    ...summary,
    '------------------------支付宝支付科技有限公司  电子客户回单------------------------',
  ].join('\r\n');
  const header =
    '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,';
  const data = full.map(
    (r) =>
      `${r.time},${r.category},${r.counterparty},/,${r.desc},${r.dir},${r.amount},${r.pay},${r.status},${r.id}\t,\t,,`,
  );
  return iconv.encode(`${preamble}\r\n${header}\n${data.join('\n')}\n`, 'gbk');
}
