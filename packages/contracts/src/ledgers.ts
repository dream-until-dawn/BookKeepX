/** 账本信息契约（ADR-0006） */
import { z } from 'zod';

export const ledgerRoleSchema = z.enum(['owner', 'editor', 'viewer']);

export const ledgerSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    currency: z.string(),
    /** 账本时区：日期筛选、统计切月、界面显示时间都按它 */
    timezone: z.string(),
    /** 当前用户在该账本中的角色（前端据此决定是否显示编辑按钮） */
    role: ledgerRoleSchema,
  })
  .strict();

export type Ledger = z.infer<typeof ledgerSchema>;
export type LedgerRoleValue = z.infer<typeof ledgerRoleSchema>;
