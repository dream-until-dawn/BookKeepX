/**
 * 自动识别：给上传的文件从候选模板中选出最合适的一个（ADR-0003 §3）
 *
 *   文件类型不符 → 淘汰
 *   指纹关键词命中率 × 0.3 ＋ 找到表头 × 0.4 ＋ 试解析前 20 行成功率 × 0.3 ＋ 文件名命中 0.05（封顶 1）
 *   没有配置标题关键词、且文件表头与模板必需列完全一致的模板（多为用户模板）：
 *     关键词项不参与，(表头 × 0.4 ＋ 试解析 × 0.3) / 0.7（import.md §9.4）
 *   ≥ 0.9 且领先第二名 ≥ 0.2 → 自动选用；≥ 0.4 → 候选；否则无候选
 */
import { parseTable } from './parse.ts';
import type { RawDoc } from './reader.ts';
import { extractTable } from './table.ts';
import type { ImportTemplate } from './template.ts';

export const AUTO_SELECT_MIN = 0.9;
export const AUTO_SELECT_MARGIN = 0.2;
export const CANDIDATE_MIN = 0.4;
const TRIAL_ROWS = 20;

export interface Candidate {
  templateId: string;
  templateName: string;
  score: number;
}

export type DetectDecision =
  | { kind: 'auto'; templateId: string; candidates: Candidate[] }
  | { kind: 'choose'; candidates: Candidate[] }
  | { kind: 'none'; candidates: Candidate[] };

function docHeadText(doc: RawDoc): string {
  if (doc.fileType === 'pdf')
    return doc.items
      .filter((i) => i.page === 1)
      .map((i) => i.s)
      .join('\n');
  return doc.grid
    .slice(0, 40)
    .map((r) => r.map((c) => String(c ?? '')).join(' '))
    .join('\n');
}

/** 表头的非空列名集合与必需列完全相同 */
function sameColumns(header: string[], required: string[]): boolean {
  const cols = new Set(header.filter((h) => h !== ''));
  return cols.size === required.length && required.every((r) => cols.has(r));
}

export function scoreTemplate(doc: RawDoc, fileName: string, t: ImportTemplate): Candidate | null {
  if (doc.fileType !== t.fileType) return null;
  let table: ReturnType<typeof extractTable>;
  try {
    table = extractTable(doc, t);
  } catch {
    return null;
  }
  const headText = table ? table.preamble : docHeadText(doc);
  const kws = t.fingerprint.titleKeywords;
  const keywords = kws.length ? kws.filter((k) => headText.includes(k)).length / kws.length : 0;
  let header = 0;
  let trial = 0;
  if (table) {
    header = 1;
    const sample = Math.min(TRIAL_ROWS, table.rows.length);
    if (sample > 0) trial = (sample - parseTable(table, t, sample).errors.length) / sample;
  }
  const byName = t.fingerprint.fileNameKeywords.some((k) => fileName.includes(k)) ? 1 : 0;
  // 表头完全一致才放大：只是"包含必需列"的宽泛模板（如只要求"时间、金额"）不能与内置模板打成平手
  const exactHeader = !!table && sameColumns(table.header, t.header.required);
  const base =
    kws.length === 0 && exactHeader ? (header * 0.4 + trial * 0.3) / 0.7 : keywords * 0.3 + header * 0.4 + trial * 0.3;
  const score = Math.min(1, base + byName * 0.05);
  return { templateId: t.id, templateName: t.name, score: Math.round(score * 1000) / 1000 };
}

export function detect(doc: RawDoc, fileName: string, templates: ImportTemplate[]): DetectDecision {
  const candidates = templates
    .map((t) => scoreTemplate(doc, fileName, t))
    .filter((c): c is Candidate => c !== null && c.score >= CANDIDATE_MIN)
    .sort((a, b) => b.score - a.score);
  const [first, second] = candidates;
  if (first && first.score >= AUTO_SELECT_MIN && first.score - (second?.score ?? 0) >= AUTO_SELECT_MARGIN) {
    return { kind: 'auto', templateId: first.templateId, candidates };
  }
  return first ? { kind: 'choose', candidates } : { kind: 'none', candidates };
}
