/**
 * API 客户端
 *
 * - 所有响应都用 contracts 中的 zod schema 校验：服务端返回的结构与约定不一致时立刻报错，
 *   而不是让错误数据流进界面；
 * - 修改数据的请求自动带上客户端标识头（CSRF 防护，docs/auth.md §4）。
 */
import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from '@bookkeepx/contracts';
import type { z } from 'zod';

/** 请求失败（网络错误、非预期状态码、响应结构不符） */
export class ApiError extends Error {
  constructor(
    message: string,
    /** HTTP 状态码；网络错误时为 0 */
    readonly status: number,
    /** 服务端返回的业务错误码（如 INVALID_CREDENTIALS），没有时为 undefined */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  /** 除 2xx 外，也按正常响应解析的状态码（例如健康检查的 503 仍带有合法 body） */
  acceptStatus?: number[];
}

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers[CLIENT_HEADER] = CLIENT_HEADER_VALUE;
  if (body !== undefined) headers['content-type'] = 'application/json';
  try {
    return await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError('无法连接服务器，请检查网络', 0);
  }
}

/** 非 2xx：尽量取出服务端给出的中文错误信息和错误码 */
async function toApiError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
  return new ApiError(body?.error ?? `请求失败（${res.status}）`, res.status, body?.code);
}

async function parse<S extends z.ZodType>(res: Response, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new ApiError('服务器返回的数据格式不符合约定', res.status);
  return parsed.data;
}

/**
 * GET 请求并按 schema 校验响应
 * @throws ApiError
 */
export async function apiGet<S extends z.ZodType>(
  path: string,
  schema: S,
  opts: RequestOptions = {},
): Promise<z.infer<S>> {
  const res = await request('GET', path);
  if (!res.ok && !opts.acceptStatus?.includes(res.status)) throw await toApiError(res);
  return parse(res, schema);
}

/**
 * 修改类请求（POST / PUT / PATCH / DELETE）
 * @param schema 响应的 schema；传 null 表示不关心响应体（如 204）
 * @throws ApiError
 */
export async function apiSend<S extends z.ZodType>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  schema: S | null,
): Promise<S extends z.ZodType ? z.infer<S> : undefined> {
  const res = await request(method, path, body);
  if (!res.ok) throw await toApiError(res);
  return (schema ? await parse(res, schema) : undefined) as S extends z.ZodType ? z.infer<S> : undefined;
}
