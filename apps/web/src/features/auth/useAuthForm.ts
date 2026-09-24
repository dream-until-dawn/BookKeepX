/**
 * 登录 / 注册表单的公共逻辑：
 *   1. 提交前用 contracts 的 schema 做前端校验（与服务端同一套规则），按字段显示错误；
 *   2. 提交成功后刷新"当前用户"缓存，并跳回登录前想去的页面（?next=）。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { z } from 'zod';
import { ApiError } from '../../shared/api/client.ts';
import { ME_QUERY_KEY } from './api.ts';

/** 只允许站内相对路径，防止 ?next=https://evil.com 这类开放重定向 */
export function safeNext(next: string | null): string {
  return next?.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export function useAuthForm<S extends z.ZodType, R>(schema: S, submit: (body: z.infer<S>) => Promise<R>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: submit,
    onSuccess: (user) => {
      queryClient.setQueryData(ME_QUERY_KEY, user);
      navigate(safeNext(params.get('next')), { replace: true });
    },
    onError: (e) => setFormError(e instanceof ApiError ? e.message : '操作失败，请重试'),
  });

  function onSubmit(values: unknown) {
    setFormError(null);
    const r = schema.safeParse(values);
    if (!r.success) {
      // 每个字段只显示第一条错误
      const errs: Record<string, string> = {};
      for (const issue of r.error.issues) {
        const key = String(issue.path[0] ?? '');
        errs[key] ??= issue.message;
      }
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    mutation.mutate(r.data);
  }

  return { onSubmit, fieldErrors, formError, pending: mutation.isPending };
}
