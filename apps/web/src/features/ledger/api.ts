/** 当前账本信息（时区、角色） */
import { ledgerSchema } from '@bookkeepx/contracts';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../shared/api/client.ts';

export function useLedger(ledgerId: string) {
  return useQuery({
    queryKey: ['ledger', ledgerId, 'info'],
    queryFn: () => apiGet(`/api/ledgers/${ledgerId}`, ledgerSchema),
    staleTime: 5 * 60_000,
  });
}
