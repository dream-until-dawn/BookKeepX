/** 分类模块：系统预置分类树、分类规则引擎、系统规则与来源映射（ADR-0004） */
export {
  type CategoryGroup,
  type FlatPresetCategory,
  flattenPreset,
  PRESET_CATEGORIES,
  PRESET_VERSION,
  type PresetCategory,
  validatePreset,
} from './preset.ts';
export {
  type CategorySource,
  type Classifiable,
  type ClassifierCategory,
  type ClassifierConfig,
  type ClassifyResult,
  classify,
  matchCondition,
  matchRule,
  normalizeText,
  type RuleCondition,
  type SystemRule,
  type TextField,
  type UserRule,
} from './rules.ts';
export { SOURCE_HINTS, SYSTEM_RULES } from './system-rules.ts';
