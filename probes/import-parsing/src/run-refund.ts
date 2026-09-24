/**
 * P0-1e：退款关联 + 冲减支出（方案 B）在全部新版样本上的效果（只输出统计）
 *
 * 用法：npx tsx src/run-refund.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { detect, loadBuiltinTemplates, parseWith, readDoc } from './engine/index.ts';
import { buildConfig, classify } from './categorize/index.ts';
import { computeStats } from './stats.ts';

const SAMPLES = join(import.meta.dirname, '../../../samples');
const templates = loadBuiltinTemplates();
const cfg = buildConfig();
const yuan = (c: number) => (c / 100).toFixed(2);

for (const name of readdirSync(SAMPLES).sort()) {
  const doc = await readDoc(readFileSync(join(SAMPLES, name)));
  const d = detect(doc, name, templates);
  if (d.kind !== 'auto') continue;
  const r = parseWith(doc, templates.find((t) => t.id === d.templateId)!);
  if (!r.refundStats.refunds) continue;

  const items = r.records.map((rec) => ({ rec, cls: classify({ ...rec, source: d.templateId, holderName: r.meta.holderName }, cfg) }));
  const after = computeStats(items);
  // 对照：不做退款处理时（退款按平台原方向计入）
  const before = computeStats(items.map((i) => ({ ...i, rec: { ...i.rec, refund: undefined } })));
  const { refunds, linked, restored } = r.refundStats;
  console.log(
    `${name.slice(0, 26).padEnd(26)} 退款${String(refunds).padStart(3)} 关联${String(linked).padStart(3)}（${((linked / refunds) * 100).toFixed(0)}%） 恢复交易关闭原消费${String(restored).padStart(2)} | ` +
      `收入 ${yuan(before.incomeCents)} → ${yuan(after.incomeCents)}  支出 ${yuan(before.expenseCents)} → ${yuan(after.expenseCents)}  待确认退款 ${after.unlinkedRefunds}`,
  );
}
