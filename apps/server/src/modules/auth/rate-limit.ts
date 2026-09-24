/**
 * 滑动窗口限流（内存实现，docs/auth.md §5）
 *
 * 单实例自托管足够；多实例部署时替换为 Redis 实现，接口保持不变。
 * 时钟可注入，测试可以精确控制"窗口是否已过"。
 */
export class SlidingWindowLimiter {
  /** key → 窗口内每次记录的时间戳（毫秒） */
  private readonly hits = new Map<string, number[]>();

  constructor(
    /** 窗口内允许的次数 */
    private readonly limit: number,
    /** 窗口长度（毫秒） */
    private readonly windowMs: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** 取出窗口内的记录，并顺带清理过期记录 */
  private recent(key: string): number[] {
    const since = this.clock().getTime() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }

  /** 是否已达到上限 */
  isBlocked(key: string): boolean {
    return this.recent(key).length >= this.limit;
  }

  /** 记录一次 */
  hit(key: string): void {
    this.hits.set(key, [...this.recent(key), this.clock().getTime()]);
  }

  /** 清零（例如登录成功后清除该邮箱的失败记录） */
  reset(key: string): void {
    this.hits.delete(key);
  }
}

const MINUTE = 60 * 1000;

/** 鉴权相关的全部限流器 */
export interface AuthLimiters {
  loginFailuresByEmail: SlidingWindowLimiter;
  loginFailuresByIp: SlidingWindowLimiter;
  registerByIp: SlidingWindowLimiter;
}

export function createAuthLimiters(clock: () => Date): AuthLimiters {
  return {
    loginFailuresByEmail: new SlidingWindowLimiter(5, 15 * MINUTE, clock),
    loginFailuresByIp: new SlidingWindowLimiter(20, 15 * MINUTE, clock),
    registerByIp: new SlidingWindowLimiter(10, 60 * MINUTE, clock),
  };
}
