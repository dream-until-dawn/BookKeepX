/**
 * 结构查看脚本（仅探针阶段使用）
 *
 * 目的：在不泄露隐私的前提下，快速看清三种原始账单的"长相"：
 *   - 文件编码、表头在第几行、有哪些列、说明行里有什么
 * 输出时对长数字串打码，避免把卡号 / 订单号 / 手机号打到终端里。
 *
 * 用法：npx tsx src/inspect.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import iconv from 'iconv-lite';
import ExcelJS from 'exceljs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const SAMPLES_DIR = join(import.meta.dirname, '../../../samples');

/** 打码：连续 5 位以上数字只保留首尾各 2 位 */
function mask(text: string): string {
  return text.replace(/\d{5,}/g, (s) => `${s.slice(0, 2)}***${s.slice(-2)}`);
}

/** 判断一段字节是否为合法 UTF-8（用于编码识别） */
function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

async function inspectCsv(file: string): Promise<void> {
  const buf = readFileSync(file);
  const utf8 = isValidUtf8(buf);
  const text = utf8 ? buf.toString('utf-8') : iconv.decode(buf, 'gbk');
  const lines = text.split(/\r?\n/);
  console.log(`编码: ${utf8 ? 'UTF-8' : 'GBK(推断)'}  BOM: ${buf[0] === 0xef}  总行数: ${lines.length}`);
  lines.slice(0, 30).forEach((l, i) => console.log(`${String(i).padStart(3)}| ${mask(l).slice(0, 200)}`));
  console.log('... 末尾 5 行:');
  lines.slice(-5).forEach((l) => console.log(`   | ${mask(l).slice(0, 200)}`));
}

async function inspectXlsx(file: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  for (const ws of wb.worksheets) {
    console.log(`工作表: ${ws.name}  行数: ${ws.rowCount}  列数: ${ws.columnCount}`);
    for (let r = 1; r <= Math.min(ws.rowCount, 25); r++) {
      const vals = (ws.getRow(r).values as unknown[]).slice(1).map((v) =>
        v instanceof Date ? `Date(${v.toISOString()})` : typeof v === 'object' && v ? JSON.stringify(v) : String(v ?? ''),
      );
      console.log(`${String(r).padStart(3)}| ${mask(vals.join(' | ')).slice(0, 220)}`);
    }
    // 看一下单元格原始类型：金额是数字还是带 ¥ 的字符串
    const sample = ws.getRow(Math.min(ws.rowCount, 20));
    console.log('第 20 行各单元格类型:', (sample.values as unknown[]).slice(1).map((v) => (v instanceof Date ? 'Date' : typeof v)));
  }
}

async function inspectPdf(file: string): Promise<void> {
  const data = new Uint8Array(readFileSync(file));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  console.log(`PDF 页数: ${doc.numPages}`);
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  // 按 y 坐标（行）分组，观察是否能还原成表格
  const rows = new Map<number, { x: number; s: string }[]>();
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const y = Math.round(item.transform[5]);
    const x = Math.round(item.transform[4]);
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y)!.push({ x, s: item.str });
  }
  const sorted = [...rows.entries()].sort((a, b) => b[0] - a[0]);
  console.log(`第 1 页文本行数(按 y 分组): ${sorted.length}`);
  for (const [y, cells] of sorted.slice(0, 30)) {
    const line = cells.sort((a, b) => a.x - b.x).map((c) => `${c.s}@${c.x}`).join('  ');
    console.log(`y=${String(y).padStart(4)}| ${mask(line).slice(0, 220)}`);
  }
}

for (const name of readdirSync(SAMPLES_DIR)) {
  const file = join(SAMPLES_DIR, name);
  console.log(`\n==================== ${name.slice(0, 12)}… ====================`);
  if (name.endsWith('.csv')) await inspectCsv(file);
  else if (name.endsWith('.xlsx')) await inspectXlsx(file);
  else if (name.endsWith('.pdf')) await inspectPdf(file);
}
