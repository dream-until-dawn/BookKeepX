/** 流水的请求与缓存 */
import {
  type CreateTransactionRequest,
  transactionListSchema,
  transactionSchema,
  type UpdateTransactionRequest,
} from '@bookkeepx/contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend } from '../../shared/api/client.ts';

const base = (ledgerId: string) => `/api/ledgers/${ledgerId}/transactions`;

/** 列表查询参数（值为空的参数不发送） */
export type ListParams = Record<string, string | number | undefined>;

export function toQueryString(params: ListParams): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** @param opts.enabled 为 false 时不发请求（例如依赖的账本时区还没加载好） */
export function useTransactions(ledgerId: string, params: ListParams, opts: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: opts.enabled ?? true,
    queryKey: ['ledger', ledgerId, 'transactions', params],
    queryFn: () => apiGet(`${base(ledgerId)}${toQueryString(params)}`, transactionListSchema),
    // 翻页、换筛选条件时先保留上一页内容，避免列表闪烁
    placeholderData: keepPreviousData,
  });
}

/** 增、改、删、恢复；成功后刷新流水，以及分类 / 账户上的"使用次数" */
export function useTransactionMutations(ledgerId: string) {
  const queryClient = useQueryClient();
  const onSuccess = () => queryClient.invalidateQueries({ queryKey: ['ledger', ledgerId] });
  return {
    create: useMutation({
      mutationFn: (body: CreateTransactionRequest) => apiSend('POST', base(ledgerId), body, transactionSchema),
      onSuccess,
    }),
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: UpdateTransactionRequest }) =>
        apiSend('PATCH', `${base(ledgerId)}/${id}`, patch, transactionSchema),
      onSuccess,
    }),
    remove: useMutation({
      mutationFn: (id: string) => apiSend('DELETE', `${base(ledgerId)}/${id}`, undefined, null),
      onSuccess,
    }),
    restore: useMutation({
      mutationFn: (id: string) => apiSend('POST', `${base(ledgerId)}/${id}/restore`, {}, transactionSchema),
      onSuccess,
    }),
  };
}
