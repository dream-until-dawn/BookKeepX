/**
 * 分类接口契约（docs/api.md "分类"）
 */
import { z } from 'zod';

export const categoryGroupSchema = z.enum(['expense', 'income', 'neutral']);
export type CategoryGroupValue = z.infer<typeof categoryGroupSchema>;

const categoryName = z.string().trim().min(1, '请填写分类名称').max(20, '分类名称最多 20 个字符');
const icon = z.string().trim().max(32).nullable();

export const categorySchema = z
  .object({
    id: z.uuid(),
    parentId: z.uuid().nullable(),
    group: categoryGroupSchema,
    name: z.string(),
    presetKey: z.string().nullable(),
    icon: z.string().nullable(),
    sort: z.number().int(),
    hidden: z.boolean(),
    /** 引用该分类的流水数（含已软删除的）；大于 0 时不能删除 */
    transactionCount: z.number().int().nonnegative(),
  })
  .strict();

export const categoryListSchema = z.array(categorySchema);

export const createCategoryRequestSchema = z
  .object({
    group: categoryGroupSchema,
    parentId: z.uuid().nullable().optional(),
    name: categoryName,
    icon: icon.optional(),
  })
  .strict();

export const updateCategoryRequestSchema = z
  .object({
    name: categoryName.optional(),
    icon: icon.optional(),
    hidden: z.boolean().optional(),
    sort: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, '没有需要修改的内容');

export type Category = z.infer<typeof categorySchema>;
export type CreateCategoryRequest = z.infer<typeof createCategoryRequestSchema>;
export type UpdateCategoryRequest = z.infer<typeof updateCategoryRequestSchema>;
