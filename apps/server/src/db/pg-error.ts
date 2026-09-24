/**
 * 解析 PostgreSQL 错误（Drizzle 会把原始错误放在 cause 里）
 *
 * 用于把"唯一约束冲突""外键约束冲突"等数据库错误转成友好的业务错误。
 */
export interface PgErrorInfo {
  /** PostgreSQL 错误码，如 23505 唯一冲突、23503 外键冲突 */
  code: string | undefined;
  /** 触发的约束名 */
  constraint: string | undefined;
}

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';

export function pgErrorInfo(err: unknown): PgErrorInfo {
  const cause = (err as { cause?: { code?: string; constraint_name?: string } } | null)?.cause;
  return { code: cause?.code, constraint: cause?.constraint_name };
}

/** 是否为指定约束的唯一冲突 */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = pgErrorInfo(err);
  return e.code === PG_UNIQUE_VIOLATION && e.constraint === constraint;
}
