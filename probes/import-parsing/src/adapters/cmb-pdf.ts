/**
 * 招商银行交易流水（PDF）解析探针
 *
 * 观察到的格式（2026-09 申请的样本）：
 *   - 带文字层的 PDF（非扫描件），可直接提取文字及坐标
 *   - 列按 x 坐标对齐：记账日期≈36、货币≈99、交易金额≈156、联机余额≈235、交易摘要≈308、对手信息≈418
 *   - 每页顶部重复中英双语表头；页脚 "n/总页数"；最后一页末尾有"温馨提示"
 *   - 交易金额带符号和千分位（"-2,500.00"），只有日期没有时间，没有交易单号
 *   - 对手信息过长时拆成两段，分别在数据行的上方和下方约 6pt 处
 *
 * 策略：不按"行"而按"锚点"解析 —— 以记账日期单元格为一条记录的锚点，
 *       对手信息列中 y 距离锚点 ±12pt 内的文字按从上到下拼接。
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { yuanToCents, type ParseResult, type ParsedRecord } from '../common.ts';

/** 各列左边界的 x 坐标区间（pt）。以列名所在位置为准，允许 ±20 的偏差 */
const COLUMNS = { date: 36, currency: 99, amount: 156, balance: 235, type: 308, counterparty: 418 } as const;
const X_TOLERANCE = 20;
/** 对手信息折行与锚点行的最大竖直距离（行距约 26pt，折行偏移约 6pt） */
const WRAP_Y_TOLERANCE = 12;

interface TextItem {
  page: number;
  x: number;
  y: number;
  s: string;
}

function columnOf(x: number): keyof typeof COLUMNS | null {
  for (const [k, cx] of Object.entries(COLUMNS)) if (Math.abs(x - cx) <= X_TOLERANCE) return k as keyof typeof COLUMNS;
  return null;
}

export async function parseCmbPdf(data: Uint8Array): Promise<ParseResult> {
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;

  // ① 提取所有文字及坐标
  const items: TextItem[] = [];
  let headerText = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    for (const it of content.items) {
      if (!('str' in it) || !it.str.trim()) continue;
      items.push({ page: p, x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), s: it.str.trim() });
      if (p === 1) headerText += it.str;
    }
  }
  if (!headerText.includes('招商银行交易流水')) throw new Error('招行流水：未找到标题"招商银行交易流水"，可能不是招行流水');

  // ② 以日期单元格为锚点
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const anchors = items.filter((it) => columnOf(it.x) === 'date' && DATE_RE.test(it.s));
  if (anchors.length === 0) throw new Error('招行流水：未找到任何交易行');

  const records: ParsedRecord[] = anchors.map((a) => {
    const sameRow = items.filter((it) => it.page === a.page && it.y === a.y);
    const cell = (c: keyof typeof COLUMNS) => sameRow.find((it) => columnOf(it.x) === c)?.s ?? null;

    // 对手信息：同页、同列、y 在锚点附近的所有片段，从上到下拼接（PDF 的 y 轴向上，所以 y 大的在上）
    const counterparty = items
      .filter((it) => it.page === a.page && columnOf(it.x) === 'counterparty' && Math.abs(it.y - a.y) <= WRAP_Y_TOLERANCE)
      .sort((p, q) => q.y - p.y)
      .map((it) => it.s)
      .join('');

    const amountText = cell('amount');
    const balanceText = cell('balance');
    const currency = cell('currency');
    if (!amountText || !balanceText) throw new Error(`招行流水第 ${a.page} 页 ${a.s}：缺少金额或余额`);
    if (currency !== 'CNY') throw new Error(`招行流水 ${a.s}：暂不支持币种 ${currency}`);

    const signed = yuanToCents(amountText);
    return {
      occurredAt: `${a.s} 00:00:00`,
      direction: signed > 0 ? 'income' : 'expense',
      amountCents: Math.abs(signed),
      counterparty,
      description: cell('type') ?? '',
      externalId: null,
      paymentMethod: '招商银行',
      status: null,
      balanceCents: yuanToCents(balanceText),
    };
  });

  // PDF 没有汇总行，校验靠"余额链"（见 verify.ts）
  return { source: 'cmb-pdf', records, summary: {} };
}
