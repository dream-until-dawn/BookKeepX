/**
 * P0-1c：对真实样本自动分类，统计各层覆盖率（只输出统计，不输出明细）
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { detect, loadBuiltinTemplates, parseWith, readDoc } from './engine/index.ts';
import { buildConfig, classify, loadRules, type CategorySource } from './categorize/index.ts';

const SAMPLES = join(import.meta.dirname, '../../../samples');
const templates = loadBuiltinTemplates();

// 模拟用户：只加了一条需求里举例的规则
const userRules = loadRules([
  { name: '（用户）地铁 → 交通', priority: 1, conditions: [{ field: 'anyText', op: 'containsAny', values: ['地铁'] }], action: { categoryKey: 'expense.transport.public' } },
]);
const cfg = buildConfig(userRules);

for (const name of readdirSync(SAMPLES)) {
  const doc = await readDoc(readFileSync(join(SAMPLES, name)));
  const d = detect(doc, name, templates);
  if (d.kind !== 'auto') continue;
  const r = parseWith(doc, templates.find((t) => t.id === d.templateId)!);

  const bySource = new Map<CategorySource, number>();
  const directionChanged = { n: 0, cents: 0 };
  const uncategorized = new Map<string, number>();
  // 模拟"从修改中学习"：按交易对方去重，用户每纠正一个对方就生成一条规则
  const uncatCounterparties = new Set<string>();
  for (const rec of r.records) {
    const c = classify({ ...rec, source: d.templateId, holderName: r.meta.holderName }, cfg);
    bySource.set(c.source, (bySource.get(c.source) ?? 0) + 1);
    if (c.direction !== rec.direction) {
      directionChanged.n++;
      directionChanged.cents += rec.amountCents;
    }
    if (c.source === 'none') {
      const k = `${rec.direction}|${rec.categoryHint ?? ''}`;
      uncategorized.set(k, (uncategorized.get(k) ?? 0) + 1);
      uncatCounterparties.add(rec.counterparty);
    }
  }
  const total = r.records.length;
  const pct = (n = 0) => `${n}（${((n / total) * 100).toFixed(0)}%）`;
  console.log(`\n### ${d.templateId}  共 ${total} 笔`);
  console.log(`  用户规则 ${pct(bySource.get('user_rule'))}  系统规则 ${pct(bySource.get('system_rule'))}  来源映射 ${pct(bySource.get('source_hint'))}  未分类 ${pct(bySource.get('none'))}`);
  console.log(`  规则改为中性: ${directionChanged.n} 笔，${(directionChanged.cents / 100).toFixed(2)} 元`);
  const u = bySource.get('none') ?? 0;
  if (u) console.log(`  学习效果：未分类 ${u} 笔来自 ${uncatCounterparties.size} 个不同对方 → 用户纠正 ${uncatCounterparties.size} 次即可全部覆盖（平均每次 ${(u / uncatCounterparties.size).toFixed(1)} 笔）`);
  console.log(`  未分类按"方向|原生分类"分布:`, JSON.stringify([...uncategorized].sort((a, b) => b[1] - a[1])));
}
