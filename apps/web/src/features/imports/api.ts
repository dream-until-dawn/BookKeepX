/** 账单导入的请求与缓存（docs/import.md §3） */
import {
  type CommitRequest,
  importBatchListSchema,
  importBatchSchema,
  uploadResponseSchema,
  verifyIssueSchema,
} from '@bookkeepx/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiError, apiGet, apiSend } from '../../shared/api/client.ts';

const base = (ledgerId: string) => `/api/ledgers/${ledgerId}/imports`;
export const importsKey = (ledgerId: string) => ['ledger', ledgerId, 'imports'] as const;

export interface UploadInput {
  file: File;
  /** 用户指定的模板（自动识别不确定、用户从候选中选定后） */
  templateId?: string | undefined;
  /** 用户指定的资金账户；不传时服务端自动推断 */
  accountId?: string | undefined;
}

/**
 * 组装上传表单
 * 注意：普通字段必须放在文件之前——服务端按流读取，只能拿到文件之前出现的字段。
 */
export function buildUploadForm(input: UploadInput): FormData {
  const form = new FormData();
  if (input.templateId) form.append('templateId', input.templateId);
  if (input.accountId) form.append('accountId', input.accountId);
  form.append('file', input.file, input.file.name);
  return form;
}

/** 从"自校验未通过"错误中取出问题列表；不是这类错误时返回 null */
export function verifyIssuesOf(e: unknown) {
  if (!(e instanceof ApiError) || e.code !== 'IMPORT_VERIFY_FAILED') return null;
  const parsed = z.array(verifyIssueSchema).safeParse(e.details);
  return parsed.success ? parsed.data : [];
}

export function useImportBatches(ledgerId: string) {
  return useQuery({ queryKey: importsKey(ledgerId), queryFn: () => apiGet(base(ledgerId), importBatchListSchema) });
}

/** 上传、提交、撤销、放弃；成功后刷新导入历史以及账本下的流水、分类使用次数等 */
export function useImportMutations(ledgerId: string) {
  const queryClient = useQueryClient();
  const onSuccess = () => queryClient.invalidateQueries({ queryKey: ['ledger', ledgerId] });
  return {
    upload: useMutation({
      mutationFn: (input: UploadInput) => apiSend('POST', base(ledgerId), buildUploadForm(input), uploadResponseSchema),
      onSuccess,
    }),
    /** 打开导入历史中尚未提交的预览（需要带预览行） */
    open: useMutation({
      mutationFn: (batchId: string) => apiGet(`${base(ledgerId)}/${batchId}`, importBatchSchema),
    }),
    commit: useMutation({
      mutationFn: ({ batchId, body }: { batchId: string; body: CommitRequest }) =>
        apiSend('POST', `${base(ledgerId)}/${batchId}/commit`, body, importBatchSchema),
      onSuccess,
    }),
    revert: useMutation({
      mutationFn: (batchId: string) => apiSend('POST', `${base(ledgerId)}/${batchId}/revert`, {}, importBatchSchema),
      onSuccess,
    }),
    discard: useMutation({
      mutationFn: (batchId: string) => apiSend('DELETE', `${base(ledgerId)}/${batchId}`, undefined, null),
      onSuccess,
    }),
  };
}
