/**
 * 请求参数校验：用 contracts 中的 zod schema 解析，不合法时返回 400 和第一条中文错误信息
 */
import type { z } from 'zod';
import { AppError } from '../errors.ts';

export function parseOrThrow<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new AppError(400, 'VALIDATION_FAILED', first?.message ?? '请求参数不合法');
  }
  return r.data;
}
