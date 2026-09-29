/** 规则请求供管理页与学习提示共享；成功后刷新账本缓存。 */
import {
  categoryRuleListSchema,
  categoryRuleSchema,
  historyPreviewSchema,
  type RuleDraft,
  ruleApplyResultSchema,
  rulePreviewSchema,
} from '@bookkeepx/contracts';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiSend } from '../api/client.ts';
export const ruleBase = (ledgerId: string) => `/api/ledgers/${ledgerId}/category-rules`;
export const rulesKey = (ledgerId: string) => ['ledger', ledgerId, 'rules'] as const;
/** 加载当前账本所有用户规则。 */
export function useRules(ledgerId: string) {
  return useQuery({ queryKey: rulesKey(ledgerId), queryFn: () => apiGet(ruleBase(ledgerId), categoryRuleListSchema) });
}
/** 草稿只试跑，不写规则。 */
export const testRule = (ledgerId: string, rule: RuleDraft, ruleId?: string) =>
  apiSend('POST', `${ruleBase(ledgerId)}/preview`, { rule, ...(ruleId ? { ruleId } : {}) }, rulePreviewSchema);
/** 用户确认后才保存学习规则或普通规则。 */
export const saveRule = (ledgerId: string, rule: RuleDraft, ruleId?: string) =>
  apiSend(ruleId ? 'PATCH' : 'POST', ruleBase(ledgerId) + (ruleId ? `/${ruleId}` : ''), rule, categoryRuleSchema);
/** 请求完整历史范围的变更预览。 */
export const previewHistory = (ledgerId: string) =>
  apiSend('POST', `${ruleBase(ledgerId)}/history-preview`, {}, historyPreviewSchema);
/** 仅提交服务端给出的摘要，分类结果由服务端重算。 */
export const applyHistory = (ledgerId: string, digest: string) =>
  apiSend('POST', `${ruleBase(ledgerId)}/apply`, { digest }, ruleApplyResultSchema);
