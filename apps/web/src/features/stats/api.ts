/** 统计请求缓存属于账本，记账、导入或规则应用后的账本失效会同步刷新。 */
import { statsResponseSchema } from '@bookkeepx/contracts';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../shared/api/client.ts';
/** 查询指定月份；非法月份由页面校验，不向接口发送。 */
export function useStats(ledgerId: string, month: string, enabled: boolean) {
  return useQuery({
    queryKey: ['ledger', ledgerId, 'stats', month],
    queryFn: () => apiGet(`/api/ledgers/${ledgerId}/stats?month=${encodeURIComponent(month)}`, statsResponseSchema),
    enabled,
  });
}
