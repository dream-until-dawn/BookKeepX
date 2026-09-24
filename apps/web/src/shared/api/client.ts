/**
 * API 客户端
 *
 * 所有请求都用 contracts 中的 zod schema 校验响应：服务端返回的结构和约定不一致时立刻报错，
 * 而不是让错误数据流进界面。
 */
import type { z } from 'zod';

/** 请求失败（网络错误、非预期状态码、响应结构不符） */
export class ApiError extends Error {
  constructor(
    message: string,
    /** HTTP 状态码；网络错误时为 0 */
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface GetOptions {
  /** 除 2xx 外，也按正常响应解析的状态码（例如健康检查的 503 仍带有合法 body） */
  acceptStatus?: number[];
}

/**
 * GET 请求并按 schema 校验响应
 * @throws ApiError
 */
export async function apiGet<S extends z.ZodType>(path: string, schema: S, opts: GetOptions = {}): Promise<z.infer<S>> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
  } catch {
    throw new ApiError('无法连接服务器，请检查网络', 0);
  }
  if (!res.ok && !opts.acceptStatus?.includes(res.status)) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `请求失败（${res.status}）`, res.status);
  }
  const parsed = schema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new ApiError('服务器返回的数据格式不符合约定', res.status);
  return parsed.data;
}
