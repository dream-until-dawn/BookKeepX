/**
 * 资金账户服务（docs/api.md "资金账户"）
 *
 * 所有函数都接收 LedgerScope（已通过权限校验），并始终以 scope.ledgerId 过滤数据。
 */
import type { Account, CreateAccountRequest, UpdateAccountRequest } from '@bookkeepx/contracts';
import { and, count, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { isUniqueViolation, PG_FOREIGN_KEY_VIOLATION, pgErrorInfo } from '../../db/pg-error.ts';
import { accounts, importBatches, transactions } from '../../db/schema/index.ts';
import { AppError } from '../../errors.ts';
import type { LedgerScope } from '../ledgers/access.ts';

const notFound = () => new AppError(404, 'ACCOUNT_NOT_FOUND', '账户不存在');
const nameTaken = () => new AppError(409, 'ACCOUNT_NAME_TAKEN', '已有同名账户');

export async function listAccounts(db: Db, scope: LedgerScope): Promise<Account[]> {
  const usage = db
    .select({ accountId: transactions.accountId, n: count().as('n') })
    .from(transactions)
    .where(eq(transactions.ledgerId, scope.ledgerId))
    .groupBy(transactions.accountId)
    .as('usage');
  return (
    db
      .select({
        id: accounts.id,
        name: accounts.name,
        kind: accounts.kind,
        institution: accounts.institution,
        cardLast4: accounts.cardLast4,
        sort: accounts.sort,
        archived: sql<boolean>`${accounts.archivedAt} IS NOT NULL`,
        transactionCount: sql<number>`coalesce(${usage.n}, 0)::int`,
      })
      .from(accounts)
      .leftJoin(usage, eq(usage.accountId, accounts.id))
      .where(eq(accounts.ledgerId, scope.ledgerId))
      // 先未停用、后已停用。注意不能直接按 archived_at 升序：PostgreSQL 升序默认把 NULL（未停用）排在最后
      .orderBy(sql`${accounts.archivedAt} IS NOT NULL`, accounts.sort, accounts.name)
  );
}

async function getOneWithUsage(db: Db, scope: LedgerScope, id: string): Promise<Account> {
  const found = (await listAccounts(db, scope)).find((a) => a.id === id);
  if (!found) throw notFound();
  return found;
}

async function assertOwn(db: Db, scope: LedgerScope, id: string) {
  const [a] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.ledgerId, scope.ledgerId)))
    .limit(1);
  if (!a) throw notFound();
}

export async function createAccount(db: Db, scope: LedgerScope, input: CreateAccountRequest): Promise<Account> {
  const [{ maxSort }] = (await db
    .select({ maxSort: sql<number>`coalesce(max(${accounts.sort}), -1)::int` })
    .from(accounts)
    .where(eq(accounts.ledgerId, scope.ledgerId))) as [{ maxSort: number }];
  try {
    const [row] = await db
      .insert(accounts)
      .values({
        ledgerId: scope.ledgerId,
        name: input.name,
        kind: input.kind,
        institution: input.institution ?? null,
        cardLast4: input.cardLast4 ?? null,
        sort: maxSort + 1,
      })
      .returning({ id: accounts.id });
    return getOneWithUsage(db, scope, row!.id);
  } catch (err) {
    if (isUniqueViolation(err, 'accounts_ledger_name_uq')) throw nameTaken();
    throw err;
  }
}

export async function updateAccount(
  db: Db,
  scope: LedgerScope,
  id: string,
  patch: UpdateAccountRequest,
): Promise<Account> {
  await assertOwn(db, scope, id);
  const { archived, ...rest } = patch;
  const set = {
    ...rest,
    // archived 是接口上的布尔值，数据库里用"停用时间"表示
    ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }),
  };
  try {
    await db
      .update(accounts)
      .set(set)
      .where(and(eq(accounts.id, id), eq(accounts.ledgerId, scope.ledgerId)));
  } catch (err) {
    if (isUniqueViolation(err, 'accounts_ledger_name_uq')) throw nameTaken();
    throw err;
  }
  return getOneWithUsage(db, scope, id);
}

export async function deleteAccount(db: Db, scope: LedgerScope, id: string): Promise<void> {
  await assertOwn(db, scope, id);
  const inUse = () => new AppError(409, 'ACCOUNT_IN_USE', '已有流水或导入记录使用该账户，不能删除，可以改为停用');
  const [{ tx }] = (await db
    .select({ tx: count() })
    .from(transactions)
    .where(and(eq(transactions.accountId, id), eq(transactions.ledgerId, scope.ledgerId)))) as [{ tx: number }];
  const [{ batches }] = (await db
    .select({ batches: count() })
    .from(importBatches)
    .where(and(eq(importBatches.accountId, id), eq(importBatches.ledgerId, scope.ledgerId)))) as [{ batches: number }];
  if (tx > 0 || batches > 0) throw inUse();
  try {
    await db.delete(accounts).where(and(eq(accounts.id, id), eq(accounts.ledgerId, scope.ledgerId)));
  } catch (err) {
    if (pgErrorInfo(err).code === PG_FOREIGN_KEY_VIOLATION) throw inUse();
    throw err;
  }
}
