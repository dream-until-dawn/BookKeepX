/**
 * 密码哈希（P0-3：验证 @node-rs/argon2 在 Windows 与 Linux 容器内都能用）
 *
 * 参数取 OWASP 推荐的 argon2id 配置之一：内存 19 MiB、迭代 2 次、并行度 1。
 */
import { hash, verify } from '@node-rs/argon2';

const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

/** 生成密码哈希；结果自带算法、参数和随机盐，同一密码每次结果不同 */
export function hashPassword(plain: string): Promise<string> {
  if (plain.length < 8) throw new Error('密码至少 8 位');
  return hash(plain, OPTIONS);
}

/** 校验密码；哈希格式损坏时返回 false 而不是抛错，避免把内部错误暴露给登录接口 */
export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}
