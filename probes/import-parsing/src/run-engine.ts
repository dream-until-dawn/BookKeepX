/**
 * P0-1b：通用引擎 + 声明式模板，对真实样本做"识别 → 解析 → 自校验"，
 * 并与 P0-1 的专用适配器结果逐笔比对。只输出统计信息。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { detect, loadBuiltinTemplates, parseWith, readDoc } from './engine/index.ts';
import { parseWechat } from './adapters/wechat.ts';
import { parseAlipay } from './adapters/alipay.ts';
import { parseCmbPdf } from './adapters/cmb-pdf.ts';
import type { ParsedRecord } from './common.ts';

const SAMPLES = join(import.meta.dirname, '../../../samples');
const templates = loadBuiltinTemplates();
console.log(`已加载模板: ${templates.map((t) => `${t.id}@${t.version}`).join(', ')}`);

/** 逐笔比较两组记录的关键字段 */
const key = (r: ParsedRecord) => [r.occurredAt, r.direction, r.amountCents, r.counterparty, r.externalId ?? '', r.balanceCents ?? ''].join('|');

for (const name of readdirSync(SAMPLES)) {
  const buf = readFileSync(join(SAMPLES, name));
  const doc = await readDoc(buf);
  const decision = detect(doc, name, templates);
  console.log(`\n### ${name.slice(0, 8)}…  识别结果: ${decision.kind}${decision.kind === 'auto' ? ` → ${decision.templateId}` : ''}`);
  decision.candidates.forEach((c) => console.log(`   候选 ${c.templateId}: ${c.score}`, JSON.stringify(c.breakdown)));
  if (decision.kind !== 'auto') continue;

  const t = templates.find((x) => x.id === decision.templateId)!;
  const r = parseWith(doc, t);
  console.log(`   入账 ${r.records.length} 笔，跳过 ${r.skipped.length} 笔，行错误 ${r.errors.length}，自校验: ${r.issues.length ? '❌ ' + JSON.stringify(r.issues.slice(0, 3)) : '✅ 通过'}`);

  // 与 P0-1 专用适配器对比（适配器不做状态过滤，所以把 skipped 合并回来）
  const legacy =
    t.id === 'wechat-xlsx' ? (await parseWechat(buf)).records : t.id === 'alipay-csv' ? parseAlipay(buf).records : (await parseCmbPdf(new Uint8Array(buf))).records;
  const a = [...r.records, ...r.skipped].map(key).sort();
  const b = legacy.map(key).sort();
  const same = a.length === b.length && a.every((k, i) => k === b[i]);
  console.log(`   与 P0-1 适配器逐笔比对: ${same ? '✅ 完全一致' : `❌ 不一致（引擎 ${a.length} / 适配器 ${b.length}）`}`);
}
