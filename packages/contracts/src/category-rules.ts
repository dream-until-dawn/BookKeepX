/** 分类规则请求与预览契约：条件白名单，不接受正则或任意脚本。 */
import { z } from 'zod';
import { categoryGroupSchema } from './categories.ts';

const words = z.array(z.string().trim().min(1).max(200)).min(1).max(20);
export const ruleConditionSchema = z.union([
  z
    .object({
      field: z.enum(['counterparty', 'description', 'note', 'paymentMethod', 'sourceHint', 'source', 'anyText']),
      op: z.enum(['containsAny', 'notContains', 'equals', 'startsWith', 'endsWith']),
      values: words,
    })
    .strict(),
  z
    .object({
      field: z.literal('direction'),
      op: z.literal('equals'),
      values: z.array(categoryGroupSchema).min(1).max(3),
    })
    .strict(),
  z
    .object({
      field: z.literal('amount'),
      op: z.enum(['gte', 'lte']),
      value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z.object({ field: z.literal('isSelf'), op: z.literal('equals'), value: z.boolean() }).strict(),
]);
export const ruleDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean(),
    priority: z.number().int().min(0).max(10000),
    match: z.enum(['all', 'any']),
    conditions: z.array(ruleConditionSchema).min(1).max(20),
    action: z.object({ categoryId: z.uuid(), setDirection: z.literal('neutral').optional() }).strict(),
    origin: z.enum(['manual', 'learned']),
  })
  .strict();
export const categoryRuleSchema = ruleDraftSchema.extend({
  id: z.uuid(),
  hitCount: z.number().int().nonnegative(),
  lastHitAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const categoryRuleListSchema = z.array(categoryRuleSchema);
export const rulePreviewRequestSchema = z.object({ rule: ruleDraftSchema, ruleId: z.uuid().optional() }).strict();
const outcomeSchema = z.object({
  categoryId: z.uuid().nullable(),
  direction: categoryGroupSchema,
  ruleId: z.uuid().nullable(),
  source: z.string(),
});
export const ruleSampleSchema = z.object({
  id: z.uuid(),
  counterparty: z.string(),
  occurredAt: z.string(),
  amountCents: z.number().int(),
  before: outcomeSchema,
  after: outcomeSchema,
  protected: z.boolean(),
  matchingRules: z.array(z.object({ id: z.string(), name: z.string() })),
  conflict: z.boolean(),
});
export const rulePreviewSchema = z.object({
  scanned: z.number().int(),
  matched: z.number().int(),
  conflicts: z.number().int(),
  samples: z.array(ruleSampleSchema),
});
export const historyPreviewSchema = z.object({
  digest: z.string(),
  scanned: z.number().int(),
  changed: z.number().int(),
  protectedCount: z.number().int(),
  samples: z.array(ruleSampleSchema),
});
export const ruleApplyRequestSchema = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const ruleApplyResultSchema = z.object({ changed: z.number().int() });
/** 编辑器的完整规则草稿。 */
export type RuleDraft = z.infer<typeof ruleDraftSchema>;
/** 已保存规则，包含命中统计。 */
export type CategoryRule = z.infer<typeof categoryRuleSchema>;
export type RulePreview = z.infer<typeof rulePreviewSchema>;
export type HistoryPreview = z.infer<typeof historyPreviewSchema>;
export type RuleSample = z.infer<typeof ruleSampleSchema>;
