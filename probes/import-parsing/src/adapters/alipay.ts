/**
 * 支付宝交易明细（csv）解析探针
 *
 * 观察到的格式（2026-09 导出样本）：
 *   - GBK 编码、无 BOM
 *   - 前 20 余行是说明，含"共N笔记录""支出：N笔 X元""不计收支：N笔 X元"
 *   - 表头："交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,"
 *     行尾多一个逗号 → 多出一个空列
 *   - 订单号后带制表符（防止 Excel 把长数字变成科学计数法）
 *   - 收/支 取值：收入 / 支出 / 不计收支
 */
import iconv from 'iconv-lite';
import Papa from 'papaparse';
import { clean, parseSummaryLine, yuanToCents, type Direction, type ParseResult, type ParsedRecord } from '../common.ts';

const REQUIRED = ['交易时间', '交易对方', '商品说明', '收/支', '金额', '收/付款方式', '交易状态', '交易订单号'] as const;
const DIRECTION_MAP: Record<string, Direction> = { 收入: 'income', 支出: 'expense', 不计收支: 'neutral' };

/** 识别编码：合法 UTF-8 就按 UTF-8，否则按 GBK（国内平台导出的 csv 只见过这两种） */
export function decodeText(buf: Buffer): string {
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return s.replace(/^﻿/, '');
  } catch {
    return iconv.decode(buf, 'gbk');
  }
}

export function parseAlipay(buf: Buffer): ParseResult {
  const text = decodeText(buf);
  const lines = text.split(/\r?\n/);

  // ① 定位表头：第一行同时包含全部必需列名的行
  const headerIdx = lines.findIndex((l) => REQUIRED.every((h) => l.includes(h)));
  if (headerIdx < 0) throw new Error('支付宝账单：未找到表头行，可能不是支付宝账单或格式已变更');
  const preamble = lines.slice(0, headerIdx).join('\n');

  // ② 表头以下交给 CSV 解析器（处理引号、字段内逗号等）
  const parsed = Papa.parse<Record<string, string>>(lines.slice(headerIdx).join('\n'), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });
  if (parsed.errors.length) throw new Error(`支付宝账单 CSV 解析错误: ${parsed.errors[0]!.message}（第 ${parsed.errors[0]!.row} 行）`);

  const records: ParsedRecord[] = parsed.data.map((row, i) => {
    const lineNo = headerIdx + 2 + i;
    const time = clean(row['交易时间']);
    if (!time || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(time)) throw new Error(`支付宝账单第 ${lineNo} 行：交易时间格式非法 "${time}"`);
    const dirText = clean(row['收/支']) ?? '';
    const direction = DIRECTION_MAP[dirText];
    if (!direction) throw new Error(`支付宝账单第 ${lineNo} 行：未知收支类型 "${dirText}"`);
    const cents = yuanToCents(clean(row['金额']) ?? '');
    if (cents <= 0) throw new Error(`支付宝账单第 ${lineNo} 行：金额应为正数`);
    return {
      occurredAt: time,
      direction,
      amountCents: cents,
      counterparty: clean(row['交易对方']) ?? '',
      description: clean(row['商品说明']) ?? '',
      externalId: clean(row['交易订单号']),
      paymentMethod: clean(row['收/付款方式']),
      status: clean(row['交易状态']),
    };
  });

  const total = /共(\d+)笔记录/.exec(preamble);
  return {
    source: 'alipay',
    records,
    summary: {
      total: total ? Number(total[1]) : undefined,
      income: parseSummaryLine(preamble, '收入'),
      expense: parseSummaryLine(preamble, '支出'),
      neutral: parseSummaryLine(preamble, '不计收支'),
    },
  };
}
