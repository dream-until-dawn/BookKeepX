/**
 * 文件读取：把上传的字节流读成与模板无关的"原始文档"
 *
 * 一个文件只读取一次，然后交给所有候选模板打分和解析，避免重复解码。
 */
import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { decodeText } from '../adapters/alipay.ts';

/** 单元格：字符串、数字（Excel 数字单元格）、日期（Excel 日期单元格）或空 */
export type Cell = string | number | Date | null;

/** PDF 中的一个文字块及其坐标（y 轴向上） */
export interface PdfTextItem {
  page: number;
  x: number;
  y: number;
  s: string;
}

export type RawDoc =
  | { fileType: 'csv' | 'xlsx'; grid: Cell[][] }
  | { fileType: 'pdf'; items: PdfTextItem[] };

/** 根据文件头的魔数判断类型，不信任扩展名 */
export function sniffFileType(buf: Uint8Array): 'xlsx' | 'pdf' | 'csv' {
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'xlsx'; // "PK"：zip 容器
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'pdf'; // "%PDF"
  return 'csv';
}

export async function readDoc(buf: Buffer): Promise<RawDoc> {
  const type = sniffFileType(buf);

  if (type === 'csv') {
    // 整个文件按 csv 解析（不指定表头）；前言行一般只有一列，不影响后续按行定位表头。
    // 必须先统一换行符并显式指定：支付宝文件的前言与数据行换行符不一致，
    // 交给 PapaParse 自动判断时会认错，整份文件被读成一行（P0-1b 实测）
    const text = decodeText(buf).replace(/\r\n?/g, '\n');
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false, newline: '\n' });
    return { fileType: 'csv', grid: parsed.data.map((row) => row.map((c) => c)) };
  }

  if (type === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('xlsx 中没有工作表');
    const grid: Cell[][] = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      grid.push(
        (ws.getRow(r).values as unknown[]).slice(1).map((v) => {
          if (v === null || v === undefined) return null;
          if (v instanceof Date || typeof v === 'number' || typeof v === 'string') return v;
          // 富文本 / 公式等对象单元格：取其文本或结果
          const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
          if (o.richText) return o.richText.map((t) => t.text).join('');
          return String(o.text ?? o.result ?? '');
        }),
      );
    }
    return { fileType: 'xlsx', grid };
  }

  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
  const items: PdfTextItem[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    for (const it of content.items) {
      if (!('str' in it) || !it.str.trim()) continue;
      items.push({ page: p, x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), s: it.str.trim() });
    }
  }
  return { fileType: 'pdf', items };
}
