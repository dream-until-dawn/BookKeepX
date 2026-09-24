/** 分类模块：系统预置分类树（ADR-0004）；分类规则引擎在 P1-8 加入 */
export {
  type CategoryGroup,
  type FlatPresetCategory,
  flattenPreset,
  PRESET_CATEGORIES,
  PRESET_VERSION,
  type PresetCategory,
  validatePreset,
} from './preset.ts';
