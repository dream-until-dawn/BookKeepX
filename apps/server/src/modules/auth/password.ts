/**
 * 密码哈希（argon2id，P0-3 验证：Windows 与 Alpine 容器均可用，单次约 10 ms）
 */
import { hash, verify } from '@node-rs/argon2';

/** OWASP 推荐的 argon2id 参数之一：内存 19 MiB、迭代 2 次、并行度 1（@node-rs/argon2 默认算法即 argon2id） */
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

/** 校验密码；哈希格式损坏时返回 false，不把内部错误暴露给登录接口 */
export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * 对"邮箱不存在"的登录也做一次同等开销的哈希校验，使响应时间与"密码错误"接近，
 * 防止通过耗时差异探测哪些邮箱已注册（docs/auth.md §2）
 */
export async function verifyAgainstDummy(plain: string): Promise<false> {
  dummyHash ??= hashPassword('dummy-password-for-timing-equalization');
  await verifyPassword(await dummyHash, plain);
  return false;
}
