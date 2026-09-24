/** P0-3 密码哈希：argon2id 可用性、正反向、耗时 */
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.ts';

describe('argon2id 密码哈希', () => {
  it('正向：哈希后能用原密码校验通过，且使用 argon2id 与预期参数', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
  });

  it('反向：错误密码校验失败', async () => {
    const h = await hashPassword('correct horse battery');
    expect(await verifyPassword(h, 'correct horse batterY')).toBe(false);
  });

  it('正向：同一密码两次哈希结果不同（随机盐）', async () => {
    expect(await hashPassword('same-password')).not.toBe(await hashPassword('same-password'));
  });

  it('反向：哈希字符串损坏时返回 false 而不是抛错', async () => {
    expect(await verifyPassword('not-a-hash', 'whatever1')).toBe(false);
  });

  it('反向：少于 8 位的密码拒绝', () => {
    expect(() => hashPassword('short')).toThrow(/至少 8 位/);
  });

  it('性能：单次哈希耗时在可接受范围（< 500ms），并输出实测值', async () => {
    const t0 = performance.now();
    await hashPassword('timing-test-password');
    const ms = performance.now() - t0;
    console.log(`[P0-3] argon2id 单次哈希耗时 ${ms.toFixed(1)} ms（${process.platform}）`);
    expect(ms).toBeLessThan(500);
  });
});
