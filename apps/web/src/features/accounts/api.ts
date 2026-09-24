/** 资金账户的请求与缓存 */
import {
  accountListSchema,
  accountSchema,
  type CreateAccountRequest,
  type UpdateAccountRequest,
} from '@bookkeepx/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend } from '../../shared/api/client.ts';

const base = (ledgerId: string) => `/api/ledgers/${ledgerId}/accounts`;
export const accountsKey = (ledgerId: string) => ['ledger', ledgerId, 'accounts'] as const;

export function useAccounts(ledgerId: string) {
  return useQuery({ queryKey: accountsKey(ledgerId), queryFn: () => apiGet(base(ledgerId), accountListSchema) });
}

/** 账户的增、改、删；成功后刷新账户列表 */
export function useAccountMutations(ledgerId: string) {
  const queryClient = useQueryClient();
  const onSuccess = () => queryClient.invalidateQueries({ queryKey: accountsKey(ledgerId) });
  return {
    create: useMutation({
      mutationFn: (body: CreateAccountRequest) => apiSend('POST', base(ledgerId), body, accountSchema),
      onSuccess,
    }),
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: UpdateAccountRequest }) =>
        apiSend('PATCH', `${base(ledgerId)}/${id}`, patch, accountSchema),
      onSuccess,
    }),
    remove: useMutation({
      mutationFn: (id: string) => apiSend('DELETE', `${base(ledgerId)}/${id}`, undefined, null),
      onSuccess,
    }),
  };
}
