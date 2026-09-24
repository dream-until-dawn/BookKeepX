/**
 * 微信支付账单（xlsx）解析探针
 *
 * 观察到的格式（2026-09 导出样本）：
 *   - 单工作表；第 1~16 行是说明（合并单元格，每列重复同一文字），含汇总："收入：N笔 X元" 等
 *   - 表头行含"交易时间 | 交易类型 | 交易对方 | 商品 | 收/支 | 金额(元) | 支付方式 | 当前状态 | 交易单号 | 商户单号 | 备注"
 *   - 交易时间是 Excel 日期单元格（北京时间墙上时间），金额是数字单元格，单号是字符串
 *   - 空值用 "/" 表示
 */
import ExcelJS from 'exceljs';
import { clean, excelDateToWallClock, parseSummaryLine, yuanToCents, type Direction, type ParseResult, type ParsedRecord } from '../common.ts';

/** 表头必须包含的列；按列名定位而不是按列号，微信调整列顺序时不至于解析错位 */
const REQUIRED = ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)', '支付方式', '当前状态', '交易单号'] as const;

const DIRECTION_MAP: Record<string, Direction> = { 收入: 'income', 支出: 'expense', '/': 'neutral' };

export async function parseWechat(input: Buffer | string): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  if (typeof input === 'string') await wb.xlsx.readFile(input);
  else await wb.xlsx.load(input as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('微信账单：找不到工作表');

  const rowValues = (r: number) => (ws.getRow(r).values as unknown[]).slice(1);

  // ① 扫描前若干行：收集汇总文字、定位表头
  let headerRow = -1;
  let preamble = '';
  for (let r = 1; r <= Math.min(ws.rowCount, 40); r++) {
    const vals = rowValues(r).map((v) => String(v ?? ''));
    if (REQUIRED.every((h) => vals.includes(h))) {
      headerRow = r;
      break;
    }
    preamble += (vals[0] ?? '') + '\n';
  }
  if (headerRow < 0) throw new Error('微信账单：未找到表头行，可能不是微信账单或格式已变更');

  const header = rowValues(headerRow).map((v) => String(v ?? ''));
  const col = (name: string) => header.indexOf(name);

  // ② 逐行解析
  const records: ParsedRecord[] = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const v = rowValues(r);
    if (v.every((x) => clean(x) === null)) continue; // 跳过空行
    const time = v[col('交易时间')];
    if (!(time instanceof Date)) throw new Error(`微信账单第 ${r} 行：交易时间不是日期 (${String(time)})`);
    const dirText = String(v[col('收/支')] ?? '').trim();
    const direction = DIRECTION_MAP[dirText];
    if (!direction) throw new Error(`微信账单第 ${r} 行：未知收支类型 "${dirText}"`);
    const cents = yuanToCents(v[col('金额(元)')] as string | number);
    if (cents <= 0) throw new Error(`微信账单第 ${r} 行：金额应为正数`);
    records.push({
      occurredAt: excelDateToWallClock(time),
      direction,
      amountCents: cents,
      counterparty: clean(v[col('交易对方')]) ?? '',
      description: clean(v[col('商品')]) ?? '',
      externalId: clean(v[col('交易单号')]),
      paymentMethod: clean(v[col('支付方式')]),
      status: clean(v[col('当前状态')]),
    });
  }

  const total = /共(\d+)笔记录/.exec(preamble);
  return {
    source: 'wechat',
    records,
    summary: {
      total: total ? Number(total[1]) : undefined,
      income: parseSummaryLine(preamble, '收入'),
      expense: parseSummaryLine(preamble, '支出'),
      neutral: parseSummaryLine(preamble, '中性交易'),
    },
  };
}
