/**
 * 流水服务（docs/api.md "流水"）
 *
 * 所有函数都接收 LedgerScope（已通过权限校验），并始终以 scope.ledgerId 过滤数据。
 */
import type {
  CreateTransactionRequest,
  Direction,
  Transaction,
  TransactionList,
  TransactionQuery,
  UpdateTransactionRequest,
} from '@bookkeepx/contracts';
import { and, desc, eq, isNotNull, isNull, or, type SQL, sql } from 'drizzle-orm';
import { type Db, toSafeInt } from '../../db/client.ts';
import { isUniqueViolation } from '../../db/pg-error.ts';
import { accounts, categories, ledgers, transactions } from '../../db/schema/index.ts';
import { AppError } from '../../errors.ts';
import type { LedgerScope } from '../ledgers/access.ts';

type Row = typeof transactions.$inferSelect;
/** 服务层拿到的请求体是 zod 解析后的结果：amount 已是"分" */
type CreateInput = Omit<CreateTransactionRequest, 'amount'> & { amount: number };
type UpdateInput = Omit<UpdateTransactionRequest, 'amount'> & { amount?: number };

const notFound = () => new AppError(404, 'TRANSACTION_NOT_FOUND', '流水不存在');

/** 数据库行 → 接口响应（时间转 ISO，去掉内部字段） */
export function toTransaction(r: Row): Transaction {
  return {
    id: r.id,
    direction: r.direction,
    amountCents: r.amountCents,
    occurredAt: r.occurredAt.toISOString(),
    timePrecision: r.timePrecision,
    categoryId: r.categoryId,
    accountId: r.accountId,
    counterparty: r.counterparty,
    description: r.description,
    note: r.note,
    source: r.source,
    categorySource: r.categorySource,
    isRefund: r.isRefund,
    refundOfId: r.refundOfId,
    duplicateOfId: r.duplicateOfId,
    createdBy: r.createdBy,
    deletedAt: r.deletedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

async function ledgerTimezone(db: Db, scope: LedgerScope): Promise<string> {
  const [l] = await db.select({ tz: ledgers.timezone }).from(ledgers).where(eq(ledgers.id, scope.ledgerId));
  return l!.tz;
}

/** LIKE 查询中转义 % _ \，让用户输入只按字面匹配 */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** 根据查询参数构造筛选条件（不含"是否已删除"之外的分页） */
function buildFilters(scope: LedgerScope, q: TransactionQuery, tz: string): SQL[] {
  const t = transactions;
  const where: SQL[] = [eq(t.ledgerId, scope.ledgerId)];
  where.push(q.deleted === 'true' ? isNotNull(t.deletedAt) : isNull(t.deletedAt));

  // 日期范围按账本时区切分；把边界换算成 UTC 时刻再比较，可以用上 (ledger_id, occurred_at) 索引
  if (q.month) {
    const start = `${q.month}-01`;
    where.push(sql`${t.occurredAt} >= (${start}::date::timestamp AT TIME ZONE ${tz})`);
    where.push(sql`${t.occurredAt} < ((${start}::date + interval '1 month')::timestamp AT TIME ZONE ${tz})`);
  }
  if (q.from) where.push(sql`${t.occurredAt} >= (${q.from}::date::timestamp AT TIME ZONE ${tz})`);
  if (q.to) where.push(sql`${t.occurredAt} < ((${q.to}::date + 1)::timestamp AT TIME ZONE ${tz})`);

  if (q.direction) where.push(eq(t.direction, q.direction));
  if (q.accountId) where.push(eq(t.accountId, q.accountId));
  if (q.categoryId) {
    // 选一级分类时包含其子分类
    where.push(
      sql`${t.categoryId} IN (SELECT ${categories.id} FROM ${categories} WHERE ${categories.ledgerId} = ${scope.ledgerId}
          AND (${categories.id} = ${q.categoryId} OR ${categories.parentId} = ${q.categoryId}))`,
    );
  }
  if (q.q) {
    const p = likePattern(q.q);
    where.push(
      or(
        sql`${t.counterparty} ILIKE ${p} ESCAPE '\\'`,
        sql`${t.description} ILIKE ${p} ESCAPE '\\'`,
        sql`${t.note} ILIKE ${p} ESCAPE '\\'`,
      )!,
    );
  }
  return where;
}

export async function listTransactions(db: Db, scope: LedgerScope, q: TransactionQuery): Promise<TransactionList> {
  const tz = await ledgerTimezone(db, scope);
  const where = and(...buildFilters(scope, q, tz));
  const t = transactions;

  const [agg] = await db
    .select({
      total: sql<string>`count(*)`,
      // 合计口径：收入不含退款；支出 = 支出 − 退款；中性不计；跨来源重复不计
      income: sql<string>`coalesce(sum(${t.amountCents}) FILTER (WHERE ${t.direction} = 'income' AND NOT ${t.isRefund} AND ${t.duplicateOfId} IS NULL), 0)`,
      expense: sql<string>`coalesce(sum(${t.amountCents}) FILTER (WHERE ${t.direction} = 'expense' AND NOT ${t.isRefund} AND ${t.duplicateOfId} IS NULL), 0)
        - coalesce(sum(${t.amountCents}) FILTER (WHERE ${t.isRefund} AND ${t.duplicateOfId} IS NULL), 0)`,
    })
    .from(t)
    .where(where);

  const rows = await db
    .select()
    .from(t)
    .where(where)
    .orderBy(desc(t.occurredAt), desc(t.createdAt), desc(t.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);

  return {
    items: rows.map(toTransaction),
    total: toSafeInt(agg!.total),
    page: q.page,
    pageSize: q.pageSize,
    summary: { incomeCents: toSafeInt(agg!.income), expenseCents: toSafeInt(agg!.expense) },
  };
}

async function getRow(db: Db, scope: LedgerScope, id: string, opts: { deleted: boolean }): Promise<Row> {
  const [r] = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.id, id),
        eq(transactions.ledgerId, scope.ledgerId),
        opts.deleted ? isNotNull(transactions.deletedAt) : isNull(transactions.deletedAt),
      ),
    )
    .limit(1);
  if (!r) throw notFound();
  return r;
}

export async function getTransaction(db: Db, scope: LedgerScope, id: string): Promise<Transaction> {
  return toTransaction(await getRow(db, scope, id, { deleted: false }));
}

/**
 * 校验要使用的分类：属于本账本、组别与方向一致；新选择的不能是隐藏分类
 * @param isNewChoice 是否是本次新选择的（原本就在用的隐藏分类允许保留）
 */
async function checkCategory(
  db: Db,
  scope: LedgerScope,
  categoryId: string,
  direction: Direction,
  isNewChoice: boolean,
) {
  const [c] = await db
    .select({ group: categories.group, hidden: categories.hidden })
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.ledgerId, scope.ledgerId)));
  if (!c) throw new AppError(404, 'CATEGORY_NOT_FOUND', '分类不存在');
  if (c.group !== direction) throw new AppError(400, 'CATEGORY_DIRECTION_MISMATCH', '分类与收支类型不一致');
  if (isNewChoice && c.hidden) throw new AppError(400, 'CATEGORY_HIDDEN', '该分类已隐藏，不能再选择');
}

async function checkAccount(db: Db, scope: LedgerScope, accountId: string, isNewChoice: boolean) {
  const [a] = await db
    .select({ archivedAt: accounts.archivedAt })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.ledgerId, scope.ledgerId)));
  if (!a) throw new AppError(404, 'ACCOUNT_NOT_FOUND', '账户不存在');
  if (isNewChoice && a.archivedAt) throw new AppError(400, 'ACCOUNT_ARCHIVED', '该账户已停用，不能再选择');
}

export async function createTransaction(db: Db, scope: LedgerScope, input: CreateInput): Promise<Transaction> {
  if (input.categoryId) await checkCategory(db, scope, input.categoryId, input.direction, true);
  if (input.accountId) await checkAccount(db, scope, input.accountId, true);
  const [row] = await db
    .insert(transactions)
    .values({
      ledgerId: scope.ledgerId,
      createdBy: scope.userId,
      direction: input.direction,
      amountCents: input.amount,
      occurredAt: new Date(input.occurredAt),
      categoryId: input.categoryId ?? null,
      categorySource: input.categoryId ? 'manual' : 'none',
      accountId: input.accountId ?? null,
      counterparty: input.counterparty ?? '',
      note: input.note ?? '',
      source: 'manual',
    })
    .returning();
  return toTransaction(row!);
}

/** 导入的流水允许修改的字段：金额、时间、方向、对方以账单为准 */
const IMPORTED_EDITABLE = new Set(['categoryId', 'accountId', 'note']);

export async function updateTransaction(
  db: Db,
  scope: LedgerScope,
  id: string,
  patch: UpdateInput,
): Promise<Transaction> {
  const existing = await getRow(db, scope, id, { deleted: false });
  if (existing.source === 'import') {
    const locked = Object.keys(patch).filter((k) => !IMPORTED_EDITABLE.has(k));
    if (locked.length > 0) {
      throw new AppError(400, 'IMPORTED_FIELD_READONLY', '导入的流水只能修改分类、账户和备注，金额、时间等以账单为准');
    }
  }

  const direction = patch.direction ?? existing.direction;
  const categoryChanged = patch.categoryId !== undefined && patch.categoryId !== existing.categoryId;
  const categoryId = patch.categoryId !== undefined ? patch.categoryId : existing.categoryId;
  // 方向变了但分类没换：原分类的组别可能不再匹配，同样要校验
  if (categoryId) await checkCategory(db, scope, categoryId, direction, categoryChanged);
  if (patch.accountId && patch.accountId !== existing.accountId) await checkAccount(db, scope, patch.accountId, true);

  const set: Partial<typeof transactions.$inferInsert> = {
    ...(patch.direction !== undefined ? { direction: patch.direction } : {}),
    ...(patch.amount !== undefined ? { amountCents: patch.amount } : {}),
    ...(patch.occurredAt !== undefined
      ? { occurredAt: new Date(patch.occurredAt), timePrecision: 'second' as const }
      : {}),
    ...(patch.accountId !== undefined ? { accountId: patch.accountId } : {}),
    ...(patch.counterparty !== undefined ? { counterparty: patch.counterparty } : {}),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
    // 用户手动改分类：记为 manual，此后任何自动规则都不会覆盖（ADR-0004）
    ...(patch.categoryId !== undefined
      ? {
          categoryId: patch.categoryId,
          categorySource: patch.categoryId ? ('manual' as const) : ('none' as const),
          categoryRuleId: null,
        }
      : {}),
  };
  const [row] = await db
    .update(transactions)
    .set(set)
    .where(and(eq(transactions.id, id), eq(transactions.ledgerId, scope.ledgerId)))
    .returning();
  return toTransaction(row!);
}

export async function deleteTransaction(db: Db, scope: LedgerScope, id: string): Promise<void> {
  const rows = await db
    .update(transactions)
    .set({ deletedAt: new Date() })
    .where(and(eq(transactions.id, id), eq(transactions.ledgerId, scope.ledgerId), isNull(transactions.deletedAt)))
    .returning({ id: transactions.id });
  if (rows.length === 0) throw notFound();
}

export async function restoreTransaction(db: Db, scope: LedgerScope, id: string): Promise<Transaction> {
  await getRow(db, scope, id, { deleted: true });
  try {
    const [row] = await db
      .update(transactions)
      .set({ deletedAt: null })
      .where(and(eq(transactions.id, id), eq(transactions.ledgerId, scope.ledgerId)))
      .returning();
    return toTransaction(row!);
  } catch (err) {
    // 删除后同一平台单号已被重新导入：恢复会造成重复
    if (isUniqueViolation(err, 'transactions_external_uq')) {
      throw new AppError(409, 'TRANSACTION_DUPLICATE', '同一笔账单记录已被重新导入，不能恢复');
    }
    throw err;
  }
}
