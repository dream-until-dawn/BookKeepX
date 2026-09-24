/**
 * 表格抽取：按模板的表头定义，从原始文档中找出"表头之前的说明文字"和"数据行"
 *
 * 输出统一的 Table 结构，之后的规范化步骤不再关心文件是 csv、xlsx 还是 pdf。
 */
import type { ImportTemplate } from './template.ts';
import type { Cell, PdfTextItem, RawDoc } from './reader.ts';

export interface Table {
  /** 表头之前的全部文字（识别指纹、提取汇总用） */
  preamble: string;
  header: string[];
  /** 数据行，与 header 按下标对应 */
  rows: Cell[][];
  /** 数据行在原文件中的位置描述，报错时告诉用户是哪一行 */
  rowLabels: string[];
}

const cellText = (c: Cell) => (c instanceof Date ? c.toISOString() : String(c ?? '')).trim();

/** @returns 找不到表头时返回 null（说明该模板不适用于这个文件） */
export function extractTable(doc: RawDoc, t: ImportTemplate): Table | null {
  if (doc.fileType !== t.fileType) return null;
  return doc.fileType === 'pdf' ? extractFromPdf(doc.items, t) : extractFromGrid(doc.grid, t);
}

function extractFromGrid(grid: Cell[][], t: ImportTemplate): Table | null {
  const idx = grid.findIndex((row) => {
    const texts = row.map(cellText);
    return t.header.required.every((h) => texts.includes(h));
  });
  if (idx < 0) return null;
  // xlsx 合并单元格会让说明文字在每列重复，只取每行第一个非空单元格
  const preamble = grid
    .slice(0, idx)
    .map((row) => row.map(cellText).find((s) => s) ?? '')
    .join('\n');
  const rows: Cell[][] = [];
  const rowLabels: string[] = [];
  grid.slice(idx + 1).forEach((row, i) => {
    if (row.every((c) => cellText(c) === '')) return; // 跳过空行
    rows.push(row);
    rowLabels.push(`第 ${idx + 2 + i} 行`);
  });
  return { preamble, header: grid[idx]!.map(cellText), rows, rowLabels };
}

/**
 * PDF：没有"行列"概念，只有带坐标的文字块。
 *   1. 在每一页找到表头行（同一 y 上出现全部 required 列名），用列名的 x 坐标确定各列左边界
 *   2. 以"时间列"中的文字块为锚点，每个锚点代表一条记录
 *   3. 每列取与锚点竖直距离在 wrapTolerance 内的文字块，从上到下拼接（处理折行）
 */
function extractFromPdf(items: PdfTextItem[], t: ImportTemplate): Table | null {
  const tol = t.pdf?.wrapTolerance ?? 12;
  const headerHeight = t.pdf?.headerHeight ?? 30;
  const pages = [...new Set(items.map((i) => i.page))].sort((a, b) => a - b);

  let header: string[] | null = null;
  let preamble = '';
  const rows: Cell[][] = [];
  const rowLabels: string[] = [];

  for (const page of pages) {
    const onPage = items.filter((i) => i.page === page);
    // 按 y 分组找表头行
    const byY = new Map<number, PdfTextItem[]>();
    for (const it of onPage) (byY.get(it.y) ?? byY.set(it.y, []).get(it.y)!).push(it);
    const headerLine = [...byY.entries()].find(([, line]) => t.header.required.every((h) => line.some((it) => it.s === h)));
    if (!headerLine) continue;
    const [headerY, line] = headerLine;
    const cols = [...line].sort((a, b) => a.x - b.x);
    const pageHeader = cols.map((c) => c.s);
    if (!header) {
      header = pageHeader;
      // 第一页表头之上的文字作为前言
      preamble = onPage
        .filter((i) => i.y > headerY)
        .sort((a, b) => b.y - a.y || a.x - b.x)
        .map((i) => i.s)
        .join('\n');
    } else if (pageHeader.join('|') !== header.join('|')) {
      throw new Error(`PDF 第 ${page} 页的表头与第 1 页不一致，可能不是同一份流水`);
    }

    // 文字块归列：取左边界 <= x + 容差 的最后一列
    const colOf = (x: number) => {
      let k = -1;
      cols.forEach((c, i) => {
        if (c.x <= x + 5) k = i;
      });
      return k;
    };
    const dataItems = onPage.filter((i) => i.y < headerY - headerHeight);

    // 锚点：时间列中的文字块
    const timeCol = pageHeader.findIndex((h) => t.columns.occurredAt.includes(h));
    const anchors = dataItems.filter((i) => colOf(i.x) === timeCol && /^\d{4}[-/]\d{2}[-/]\d{2}/.test(i.s));

    for (const a of anchors) {
      const row: Cell[] = pageHeader.map((_, ci) => {
        const parts = dataItems
          .filter((i) => colOf(i.x) === ci && Math.abs(i.y - a.y) <= tol)
          .sort((p, q) => q.y - p.y || p.x - q.x);
        return parts.length ? parts.map((p) => p.s).join('') : null;
      });
      rows.push(row);
      rowLabels.push(`第 ${page} 页 ${a.s}`);
    }
  }
  if (!header) return null;
  return { preamble, header, rows, rowLabels };
}
