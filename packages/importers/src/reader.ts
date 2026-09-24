/**
 * 文件读取：把上传的字节读成与模板无关的"原始文档"
 *
 * 一个文件只读取一次，然后交给所有候选模板打分和解析。
 */
import ExcelJS from 'exceljs';
import iconv from 'iconv-lite';
import Papa from 'papaparse';

/** 单元格：字符串、数字（Excel 数字单元格）、日期（Excel 日期单元格）或空 */
export type Cell = string | number | Date | null;

/** PDF 中的一个文字块及其坐标（y 轴向上） */
export interface PdfTextItem {
  page: number;
  x: number;
  y: number;
  s: string;
}

export type RawDoc = { fileType: 'csv' | 'xlsx'; grid: Cell[][] } | { fileType: 'pdf'; items: PdfTextItem[] };

export type FileType = RawDoc['fileType'];

/** 按文件头的魔数判断类型，不信任扩展名 */
export function sniffFileType(buf: Uint8Array): FileType {
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'xlsx'; // "PK"：zip 容器
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'pdf'; // "%PDF"
  return 'csv';
}

/** 识别编码：合法 UTF-8（可带 BOM）按 UTF-8，否则按 GBK（国内平台导出的 csv 只见过这两种） */
export function decodeText(buf: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return iconv.decode(Buffer.from(buf), 'gbk');
  }
}

/** 文件不是纯文本（csv 分支拿到了二进制）时的判断：含大量控制字符 */
function looksBinary(text: string): boolean {
  const sample = text.slice(0, 2000);
  let control = 0;
  for (const ch of sample) {
    const c = ch.charCodeAt(0);
    if (c < 9 || (c > 13 && c < 32)) control++;
  }
  return control > sample.length * 0.05;
}

/**
 * 读取文件
 * @throws Error 文件损坏或不是支持的格式
 */
export async function readDoc(buf: Uint8Array): Promise<RawDoc> {
  const type = sniffFileType(buf);

  if (type === 'csv') {
    // 支付宝 csv 的前言用 CRLF、数据用 LF（P0-1b 实测）：先统一换行再显式指定，避免被读成一行
    const text = decodeText(buf).replace(/\r\n?/g, '\n');
    if (looksBinary(text)) throw new Error('无法识别的文件格式，请上传 csv、xlsx 或 pdf 账单');
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false, newline: '\n' });
    return { fileType: 'csv', grid: parsed.data };
  }

  if (type === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(Buffer.from(buf) as unknown as ArrayBuffer);
    } catch {
      throw new Error('xlsx 文件已损坏或不是 Excel 文件');
    }
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('xlsx 中没有工作表');
    const grid: Cell[][] = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      grid.push(
        (ws.getRow(r).values as unknown[]).slice(1).map((v): Cell => {
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

  // pdfjs 体积较大，只在真正遇到 PDF 时才加载
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
  } catch {
    throw new Error('PDF 文件已损坏或无法读取');
  }
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
