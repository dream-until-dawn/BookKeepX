/**
 * 环境变量读取与校验
 *
 * 启动时一次性校验，缺失或非法直接报错退出 —— 宁可起不来，也不要带着错误配置运行。
 */
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url('DATABASE_URL 必须是合法的连接串，如 postgres://user:pass@host:5432/db'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * 解析环境变量
 * @throws 校验失败时抛出列出全部问题的错误
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const r = envSchema.safeParse(source);
  if (!r.success) {
    const detail = r.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`环境变量配置有误：\n${detail}`);
  }
  return r.data;
}
