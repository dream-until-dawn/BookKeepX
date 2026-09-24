/**
 * 自动识别：给上传的文件从候选模板中选出最合适的一个
 *
 * 打分维度（见 ADR-0003）：
 *   文件类型不符 → 直接淘汰
 *   指纹关键词命中率 × 0.3
 *   找到表头 × 0.4
 *   试解析前 N 行的成功率 × 0.3
 *   文件名命中 → +0.05（封顶 1）
 */
import { extractTable } from './table.ts';
import { parseTable } from './parse.ts';
import type { RawDoc } from './reader.ts';
import type { ImportTemplate } from './template.ts';

export const AUTO_SELECT_MIN = 0.9;
export const AUTO_SELECT_MARGIN = 0.2;
export const CANDIDATE_MIN = 0.4;
const TRIAL_ROWS = 20;

export interface Candidate {
  templateId: string;
  score: number;
  /** 各维度得分明细，展示给用户 / 排错用 */
  breakdown: { keywords: number; header: number; trial: number; fileName: number };
}

export type DetectDecision =
  | { kind: 'auto'; templateId: string; candidates: Candidate[] }
  | { kind: 'choose'; candidates: Candidate[] } // 让用户从候选中选
  | { kind: 'custom'; candidates: Candidate[] }; // 没有合适模板，引导自定义

export function scoreTemplate(doc: RawDoc, fileName: string, t: ImportTemplate): Candidate | null {
  if (doc.fileType !== t.fileType) return null;
  const table = extractTable(doc, t);

  // 指纹关键词：在表头之前的文字里找；找不到表头时在整个文档前部找
  const headText = table ? table.preamble : docHeadText(doc);
  const kws = t.fingerprint.titleKeywords;
  const keywords = kws.length ? kws.filter((k) => headText.includes(k)).length / kws.length : 0;

  let header = 0;
  let trial = 0;
  if (table) {
    header = 1;
    const sample = Math.min(TRIAL_ROWS, table.rows.length);
    if (sample > 0) {
      const r = parseTable(table, t, sample);
      trial = (sample - r.errors.length) / sample;
    }
  }
  const fileName_ = t.fingerprint.fileNameKeywords.some((k) => fileName.includes(k)) ? 1 : 0;
  const score = Math.min(1, keywords * 0.3 + header * 0.4 + trial * 0.3 + fileName_ * 0.05);
  return { templateId: t.id, score: Math.round(score * 1000) / 1000, breakdown: { keywords, header, trial, fileName: fileName_ } };
}

export function detect(doc: RawDoc, fileName: string, templates: ImportTemplate[]): DetectDecision {
  const candidates = templates
    .map((t) => scoreTemplate(doc, fileName, t))
    .filter((c): c is Candidate => c !== null && c.score >= CANDIDATE_MIN)
    .sort((a, b) => b.score - a.score);
  const [first, second] = candidates;
  if (first && first.score >= AUTO_SELECT_MIN && first.score - (second?.score ?? 0) >= AUTO_SELECT_MARGIN)
    return { kind: 'auto', templateId: first.templateId, candidates };
  if (first) return { kind: 'choose', candidates };
  return { kind: 'custom', candidates };
}

/** 取文档开头部分的文字（找不到表头时用于关键词匹配） */
function docHeadText(doc: RawDoc): string {
  if (doc.fileType === 'pdf') return doc.items.filter((i) => i.page === 1).map((i) => i.s).join('\n');
  return doc.grid
    .slice(0, 40)
    .map((r) => r.map((c) => String(c ?? '')).join(' '))
    .join('\n');
}
