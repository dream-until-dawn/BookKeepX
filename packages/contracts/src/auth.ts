/**
 * 鉴权接口契约（docs/auth.md）
 */
import { z } from 'zod';

/** 修改数据的请求必须带的请求头（CSRF 防护，docs/auth.md §4） */
export const CLIENT_HEADER = 'x-bookkeepx-client';
export const CLIENT_HEADER_VALUE = 'web';

const email = z.string().trim().toLowerCase().pipe(z.email('邮箱格式不正确').max(254, '邮箱过长'));

const password = z
  .string()
  .min(8, '密码至少 8 个字符')
  .max(128, '密码最多 128 个字符')
  .refine((s) => s.trim().length > 0, '密码不能全是空白');

export const registerRequestSchema = z
  .object({
    email,
    password,
    displayName: z.string().trim().min(1, '请填写昵称').max(30, '昵称最多 30 个字符'),
  })
  .strict();

export const loginRequestSchema = z
  .object({
    email,
    // 登录时不校验密码规则：规则可能调整，老用户仍需能用旧密码登录
    password: z.string().min(1, '请填写密码').max(128, '密码最多 128 个字符'),
  })
  .strict();

/** 当前用户：响应中只允许出现这些字段（严格模式，防止误带出密码哈希等内部字段） */
export const currentUserSchema = z
  .object({
    id: z.uuid(),
    email: z.string(),
    displayName: z.string(),
    defaultLedgerId: z.uuid().nullable(),
  })
  .strict();

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type CurrentUser = z.infer<typeof currentUserSchema>;

/** 鉴权相关的错误码（前端据此显示提示） */
export const AUTH_ERROR_CODES = [
  'EMAIL_TAKEN',
  'INVALID_CREDENTIALS',
  'TOO_MANY_ATTEMPTS',
  'UNAUTHENTICATED',
  'CSRF_REJECTED',
] as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];
