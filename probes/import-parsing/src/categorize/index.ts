/**
 * 分类探针入口：加载预置分类、系统规则、来源映射
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRules, type ClassifierConfig, type Rule } from './rules.ts';

export * from './rules.ts';

const DATA = join(import.meta.dirname, 'data');
const readJson = (f: string) => JSON.parse(readFileSync(join(DATA, f), 'utf-8'));

interface PresetNode {
  key: string;
  name: string;
  children?: PresetNode[];
}

/** 展开预置分类树，得到全部合法分类键 */
export function presetKeys(): Set<string> {
  const preset = readJson('preset.json') as { groups: Record<string, PresetNode[]> };
  const keys = new Set<string>();
  const walk = (n: PresetNode) => {
    keys.add(n.key);
    n.children?.forEach(walk);
  };
  Object.values(preset.groups).flat().forEach(walk);
  return keys;
}

/**
 * 组装分类器配置，并做一致性检查：规则和映射里引用的分类键必须存在于预置分类中。
 * 这样预置分类改名或删除时，会在启动阶段就报错，而不是运行时静默归不上类。
 */
export function buildConfig(userRules: Rule[] = []): ClassifierConfig {
  const validKeys = presetKeys();
  const systemRules = loadRules(readJson('system-rules.json'));
  const sourceHints = readJson('source-hints.json') as Record<string, Record<string, string>>;
  const refs = [
    ...systemRules.map((r) => [`系统规则「${r.name}」`, r.action.categoryKey]),
    ...userRules.map((r) => [`用户规则「${r.name}」`, r.action.categoryKey]),
    ...Object.entries(sourceHints).flatMap(([src, m]) => Object.entries(m).map(([h, k]) => [`来源映射 ${src}/${h}`, k])),
  ];
  const broken = refs.filter(([, k]) => !validKeys.has(k!));
  if (broken.length) throw new Error(`引用了不存在的分类键: ${broken.map(([w, k]) => `${w} → ${k}`).join('; ')}`);
  return { userRules, systemRules, sourceHints, validKeys };
}
