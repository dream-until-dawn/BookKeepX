/**
 * 批量识别：对 samples/ 下全部文件跑自动识别 + 解析 + 自校验，输出一行一个文件的汇总表
 * （只输出统计，不输出明细）
 *
 * 用法：npx tsx src/run-batch.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { detect, loadBuiltinTemplates, parseWith, readDoc } from './engine/index.ts';

const SAMPLES = join(import.meta.dirname, '../../../samples');
const templates = loadBuiltinTemplates();

for (const name of readdirSync(SAMPLES).sort()) {
  const short = name.length > 36 ? name.slice(0, 36) + '…' : name;
  try {
    const doc = await readDoc(readFileSync(join(SAMPLES, name)));
    const d = detect(doc, name, templates);
    const top = d.candidates[0];
    if (d.kind !== 'auto') {
      console.log(`${short.padEnd(40)} ${d.kind.padEnd(6)} 最高候选=${top ? `${top.templateId}(${top.score}) ${JSON.stringify(top.breakdown)}` : '无'}`);
      continue;
    }
    const r = parseWith(doc, templates.find((t) => t.id === d.templateId)!);
    const flag = r.issues.length ? `❌ ${r.issues.length} 项: ${r.issues.slice(0, 2).map((i) => `[${i.check}] ${i.detail}`).join(' | ')}` : '✅';
    console.log(`${short.padEnd(40)} auto   ${d.templateId.padEnd(12)} 入账${String(r.records.length).padStart(4)} 跳过${String(r.skipped.length).padStart(3)} ${flag}`);
  } catch (e) {
    console.log(`${short.padEnd(40)} 💥 ${(e as Error).message.slice(0, 120)}`);
  }
}
