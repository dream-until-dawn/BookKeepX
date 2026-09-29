/** 自定义解析模板的请求与缓存（docs/import.md §9.6） */
import {
  type CreateUserTemplateRequest,
  inspectResponseSchema,
  templateTestResponseSchema,
  type UpdateUserTemplateRequest,
  type UserTemplateSpecInput,
  userTemplateListSchema,
  userTemplateSchema,
} from '@bookkeepx/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend } from '../../shared/api/client.ts';

const BASE = '/api/import-templates';
/** 模板属于用户而不是账本，缓存键不带账本 id */
export const templatesKey = ['import-templates'] as const;

/** 普通字段放在文件之前：服务端按流读取，文件之后的字段读不到 */
function fileForm(file: File, fields: Record<string, string | undefined> = {}): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.append(k, v);
  form.append('file', file, file.name);
  return form;
}

export function useUserTemplates() {
  return useQuery({ queryKey: templatesKey, queryFn: () => apiGet(BASE, userTemplateListSchema) });
}

export function useTemplateMutations() {
  const queryClient = useQueryClient();
  const onSuccess = () => queryClient.invalidateQueries({ queryKey: templatesKey });
  return {
    inspect: useMutation({
      mutationFn: (file: File) => apiSend('POST', `${BASE}/inspect`, fileForm(file), inspectResponseSchema),
    }),
    test: useMutation({
      mutationFn: ({ file, spec, templateId }: { file: File; spec: UserTemplateSpecInput; templateId?: string }) =>
        apiSend(
          'POST',
          `${BASE}/test`,
          fileForm(file, { spec: JSON.stringify(spec), templateId }),
          templateTestResponseSchema,
        ),
    }),
    create: useMutation({
      mutationFn: (body: CreateUserTemplateRequest) => apiSend('POST', BASE, body, userTemplateSchema),
      onSuccess,
    }),
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: UpdateUserTemplateRequest }) =>
        apiSend('PATCH', `${BASE}/${id}`, patch, userTemplateSchema),
      onSuccess,
    }),
    remove: useMutation({
      mutationFn: (id: string) => apiSend('DELETE', `${BASE}/${id}`, undefined, null),
      onSuccess,
    }),
  };
}
