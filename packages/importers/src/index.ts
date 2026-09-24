/**
 * @bookkeepx/importers 公开入口
 *
 * parseBill：上传的字节 → 识别模板 → 解析 → 自校验 → 文件内退款关联
 * 与数据库相关的步骤（去重、跨来源重复、历史退款、分类）在服务端完成（docs/import.md）。
 */
import { type DetectDecision, detect } from './detect.ts';
import { type ImportRecord, type ParsedFile, parseTable, type VerifyIssue } from './parse.ts';
import { readDoc } from './reader.ts';
import { isRefundRecord, linkRefundsInFile } from './refund.ts';
import { extractTable } from './table.ts';
import { type ImportTemplate, loadTemplate } from './template.ts';
import alipayCsv from './templates/alipay-csv.json' with { type: 'json' };
import cmbPdf from './templates/cmb-pdf.json' with { type: 'json' };
import wechatXlsx from './templates/wechat-xlsx.json' with { type: 'json' };

export type { Candidate, DetectDecision } from './detect.ts';
export type { Direction, ImportRecord, ParsedFile, VerifyIssue } from './parse.ts';
export { type FileType, sniffFileType } from './reader.ts';
export { type ImportTemplate, loadTemplate, templateSchema } from './template.ts';

/** 内置模板；加载时即做严格校验，模板写错会在启动时直接报错 */
export const BUILTIN_TEMPLATES: ImportTemplate[] = [wechatXlsx, alipayCsv, cmbPdf].map((json) => loadTemplate(json));

export type ParseBillResult =
  /** 解析成功（自校验结果在 file.issues 中，非空表示不应导入） */
  | { status: 'parsed'; template: ImportTemplate; score: number; file: ParsedFile & { refundCount: number } }
  /** 需要用户从候选中选择模板 */
  | { status: 'choose_template'; candidates: DetectDecision['candidates'] }
  /** 没有任何模板认识这个文件 */
  | { status: 'unsupported' };

export interface ParseBillOptions {
  /** 用户指定的模板 id（识别不确定时由用户选择） */
  templateId?: string | undefined;
  templates?: ImportTemplate[];
}

/**
 * 解析一份账单
 * @throws Error 文件损坏 / 格式无法读取；指定的模板不存在或与文件不匹配
 */
export async function parseBill(
  bytes: Uint8Array,
  fileName: string,
  opts: ParseBillOptions = {},
): Promise<ParseBillResult> {
  const templates = opts.templates ?? BUILTIN_TEMPLATES;
  const doc = await readDoc(bytes);
  const decision = detect(doc, fileName, templates);

  let templateId: string;
  if (opts.templateId) {
    templateId = opts.templateId;
  } else if (decision.kind === 'auto') {
    templateId = decision.templateId;
  } else if (decision.kind === 'choose') {
    return { status: 'choose_template', candidates: decision.candidates };
  } else {
    return { status: 'unsupported' };
  }

  const template = templates.find((t) => t.id === templateId);
  if (!template) throw new Error(`模板不存在：${templateId}`);
  const table = extractTable(doc, template);
  if (!table) throw new Error(`所选模板"${template.name}"与该文件不匹配（找不到表头）`);
  const file = parseTable(table, template);
  linkRefundsInFile(file.records, template);
  const score = decision.candidates.find((c) => c.templateId === templateId)?.score ?? 0;
  return {
    status: 'parsed',
    template,
    score,
    file: { ...file, refundCount: file.records.filter((r) => r.refund).length },
  };
}

export type { ImportRecord as BillRecord, VerifyIssue as BillIssue };
export { isRefundRecord };
