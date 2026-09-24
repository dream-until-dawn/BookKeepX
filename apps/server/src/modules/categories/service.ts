/**
 * 分类服务（docs/api.md "分类"）
 *
 * 所有函数都接收 LedgerScope（已通过权限校验），并始终以 scope.ledgerId 过滤数据。
 */
import type { Category, CreateCategoryRequest, UpdateCategoryRequest } from '@bookkeepx/contracts';
import { and, count, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { isUniqueViolation, PG_FOREIGN_KEY_VIOLATION, pgErrorInfo } from '../../db/pg-error.ts';
import { categories, transactions } from '../../db/schema/index.ts';
import { AppError } from '../../errors.ts';
import type { LedgerScope } from '../ledgers/access.ts';

const notFound = () => new AppError(404, 'CATEGORY_NOT_FOUND', '分类不存在');
const nameTaken = () => new AppError(409, 'CATEGORY_NAME_TAKEN', '同一级下已有同名分类');

/** 查询分类列表（附带引用它的流水数，含已软删除的流水——它们同样阻止删除） */
export async function listCategories(db: Db, scope: LedgerScope): Promise<Category[]> {
  const usage = db
    .select({ categoryId: transactions.categoryId, n: count().as('n') })
    .from(transactions)
    .where(eq(transactions.ledgerId, scope.ledgerId))
    .groupBy(transactions.categoryId)
    .as('usage');
  const rows = await db
    .select({
      id: categories.id,
      parentId: categories.parentId,
      group: categories.group,
      name: categories.name,
      presetKey: categories.presetKey,
      icon: categories.icon,
      sort: categories.sort,
      hidden: categories.hidden,
      transactionCount: sql<number>`coalesce(${usage.n}, 0)::int`,
    })
    .from(categories)
    .leftJoin(usage, eq(usage.categoryId, categories.id))
    .where(eq(categories.ledgerId, scope.ledgerId))
    .orderBy(categories.group, categories.sort, categories.name);
  return rows;
}

/** 在账本内按 id 取分类；不存在或属于其他账本时抛 404 */
async function getOwn(db: Db, scope: LedgerScope, id: string) {
  const [c] = await db
    .select()
    .from(categories)
    .where(and(eq(categories.id, id), eq(categories.ledgerId, scope.ledgerId)))
    .limit(1);
  if (!c) throw notFound();
  return c;
}

async function getOneWithUsage(db: Db, scope: LedgerScope, id: string): Promise<Category> {
  const all = await listCategories(db, scope);
  const found = all.find((c) => c.id === id);
  if (!found) throw notFound();
  return found;
}

export async function createCategory(db: Db, scope: LedgerScope, input: CreateCategoryRequest): Promise<Category> {
  const parentId = input.parentId ?? null;
  if (parentId) {
    const parent = await getOwn(db, scope, parentId);
    if (parent.parentId) throw new AppError(400, 'CATEGORY_TOO_DEEP', '分类最多两级，不能在子分类下再建分类');
    if (parent.group !== input.group)
      throw new AppError(400, 'CATEGORY_GROUP_MISMATCH', '子分类必须与上级分类属于同一类型');
  }
  // 新分类排在同级最后
  const [{ maxSort }] = (await db
    .select({ maxSort: sql<number>`coalesce(max(${categories.sort}), -1)::int` })
    .from(categories)
    .where(
      and(
        eq(categories.ledgerId, scope.ledgerId),
        eq(categories.group, input.group),
        parentId ? eq(categories.parentId, parentId) : sql`${categories.parentId} IS NULL`,
      ),
    )) as [{ maxSort: number }];
  try {
    const [row] = await db
      .insert(categories)
      .values({
        ledgerId: scope.ledgerId,
        parentId,
        group: input.group,
        name: input.name,
        icon: input.icon ?? null,
        sort: maxSort + 1,
      })
      .returning({ id: categories.id });
    return getOneWithUsage(db, scope, row!.id);
  } catch (err) {
    if (isUniqueViolation(err, 'categories_sibling_name_uq')) throw nameTaken();
    throw err;
  }
}

export async function updateCategory(
  db: Db,
  scope: LedgerScope,
  id: string,
  patch: UpdateCategoryRequest,
): Promise<Category> {
  await getOwn(db, scope, id);
  try {
    await db
      .update(categories)
      .set(patch)
      .where(and(eq(categories.id, id), eq(categories.ledgerId, scope.ledgerId)));
  } catch (err) {
    if (isUniqueViolation(err, 'categories_sibling_name_uq')) throw nameTaken();
    throw err;
  }
  return getOneWithUsage(db, scope, id);
}

export async function deleteCategory(db: Db, scope: LedgerScope, id: string): Promise<void> {
  const c = await getOwn(db, scope, id);
  if (c.presetKey) {
    throw new AppError(409, 'CATEGORY_PRESET', '预置分类不能删除，可以隐藏（自动分类规则依赖它）');
  }
  const [{ children }] = (await db
    .select({ children: count() })
    .from(categories)
    .where(and(eq(categories.parentId, id), eq(categories.ledgerId, scope.ledgerId)))) as [{ children: number }];
  if (children > 0) throw new AppError(409, 'CATEGORY_HAS_CHILDREN', '请先删除它的子分类（目前不支持移动分类）');

  const inUse = () => new AppError(409, 'CATEGORY_IN_USE', '已有流水使用该分类，不能删除，可以改为隐藏');
  const [{ used }] = (await db
    .select({ used: count() })
    .from(transactions)
    .where(and(eq(transactions.categoryId, id), eq(transactions.ledgerId, scope.ledgerId)))) as [{ used: number }];
  if (used > 0) throw inUse();
  try {
    await db.delete(categories).where(and(eq(categories.id, id), eq(categories.ledgerId, scope.ledgerId)));
  } catch (err) {
    // 检查与删除之间恰好有人用它记了一笔：由外键兜底，转成同样的友好提示
    if (pgErrorInfo(err).code === PG_FOREIGN_KEY_VIOLATION) throw inUse();
    throw err;
  }
}
