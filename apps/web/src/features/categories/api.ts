/** 分类的请求与缓存 */
import {
  type CreateCategoryRequest,
  categoryListSchema,
  categorySchema,
  type UpdateCategoryRequest,
} from '@bookkeepx/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend } from '../../shared/api/client.ts';

const base = (ledgerId: string) => `/api/ledgers/${ledgerId}/categories`;
export const categoriesKey = (ledgerId: string) => ['ledger', ledgerId, 'categories'] as const;

export function useCategories(ledgerId: string) {
  return useQuery({ queryKey: categoriesKey(ledgerId), queryFn: () => apiGet(base(ledgerId), categoryListSchema) });
}

/** 分类的增、改、删；成功后刷新分类列表 */
export function useCategoryMutations(ledgerId: string) {
  const queryClient = useQueryClient();
  const onSuccess = () => queryClient.invalidateQueries({ queryKey: categoriesKey(ledgerId) });
  return {
    create: useMutation({
      mutationFn: (body: CreateCategoryRequest) => apiSend('POST', base(ledgerId), body, categorySchema),
      onSuccess,
    }),
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: UpdateCategoryRequest }) =>
        apiSend('PATCH', `${base(ledgerId)}/${id}`, patch, categorySchema),
      onSuccess,
    }),
    remove: useMutation({
      mutationFn: (id: string) => apiSend('DELETE', `${base(ledgerId)}/${id}`, undefined, null),
      onSuccess,
    }),
  };
}
