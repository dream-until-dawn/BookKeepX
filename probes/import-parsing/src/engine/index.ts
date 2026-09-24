/**
 * 引擎入口：加载内置模板 + 上传文件 → 识别 → 解析
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadTemplate, type ImportTemplate } from './template.ts';
import { readDoc } from './reader.ts';
import { detect, type DetectDecision } from './detect.ts';
import { extractTable } from './table.ts';
import { parseTable, type EngineResult } from './parse.ts';

export { loadTemplate, readDoc, detect, extractTable, parseTable };
export type { ImportTemplate, DetectDecision, EngineResult };

const TEMPLATE_DIR = join(import.meta.dirname, '../../templates');

/** 加载内置模板目录下的全部模板；任何一份不合法都会抛错（启动即失败，而不是运行时才发现） */
export function loadBuiltinTemplates(): ImportTemplate[] {
  return readdirSync(TEMPLATE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return loadTemplate(JSON.parse(readFileSync(join(TEMPLATE_DIR, f), 'utf-8')));
      } catch (e) {
        throw new Error(`内置模板 ${f} 加载失败: ${(e as Error).message}`);
      }
    });
}

/** 用指定模板解析文档；找不到表头时抛错 */
export function parseWith(doc: Awaited<ReturnType<typeof readDoc>>, t: ImportTemplate): EngineResult {
  const table = extractTable(doc, t);
  if (!table) throw new Error(`模板 ${t.id} 在文件中找不到表头`);
  return parseTable(table, t);
}
