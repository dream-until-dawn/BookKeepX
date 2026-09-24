/**
 * 导入预览的纯函数（便于单独测试）
 *
 * 预览中用户的修改记在 edits 里（按行号），提交时只发送真正改动过的部分，
 * 与服务端的默认值一致：status 为 new 的行默认导入，其余默认不导入且不能勾选。
 */
import type { CommitRequest, ImportBatch, ImportRow } from '@bookkeepx/contracts';

export interface RowEdit {
  /** 改过的分类（null = 改为未分类）；undefined = 没改 */
  categoryId?: string | null;
  include?: boolean;
}

export type Edits = ReadonlyMap<number, RowEdit>;

/** 该行能否勾选导入（已导入过、按规则跳过的不能） */
export const canInclude = (row: ImportRow) => row.status === 'new';

export function isIncluded(row: ImportRow, edits: Edits): boolean {
  if (!canInclude(row)) return false;
  return edits.get(row.index)?.include ?? true;
}

export function effectiveCategoryId(row: ImportRow, edits: Edits): string | null {
  const e = edits.get(row.index);
  return e && e.categoryId !== undefined ? e.categoryId : row.categoryId;
}

/** 生成提交请求：只包含与默认值不同的修改 */
export function buildOverrides(rows: ImportRow[], edits: Edits): CommitRequest['overrides'] {
  const out: NonNullable<CommitRequest['overrides']> = [];
  for (const row of rows) {
    const e = edits.get(row.index);
    if (!e || !canInclude(row)) continue;
    const o: { index: number; categoryId?: string | null; include?: boolean } = { index: row.index };
    if (e.include !== undefined && e.include !== true) o.include = e.include;
    if (e.categoryId !== undefined && e.categoryId !== row.categoryId) o.categoryId = e.categoryId;
    if (Object.keys(o).length > 1) out.push(o);
  }
  return out;
}

/**
 * 将要导入部分的合计（与流水页的统计口径一致）：
 * 退款冲减支出、中性不计、跨来源重复中的银行那条不计入统计
 */
export function includedSummary(rows: ImportRow[], edits: Edits) {
  let count = 0;
  let incomeCents = 0;
  let expenseCents = 0;
  let uncategorized = 0;
  for (const row of rows) {
    if (!isIncluded(row, edits)) continue;
    count++;
    // 退款不单独分类（统计时冲减原消费），不算"未分类"
    if (!row.refund && effectiveCategoryId(row, edits) === null) uncategorized++;
    if (row.crossSource === 'bank_side') continue;
    if (row.refund) expenseCents -= row.amountCents;
    else if (row.direction === 'income') incomeCents += row.amountCents;
    else if (row.direction === 'expense') expenseCents += row.amountCents;
  }
  return { count, incomeCents, expenseCents, uncategorized };
}

/** 各状态的行数，用于预览顶部的筛选标签 */
export function statusCounts(rows: ImportRow[]) {
  const c = { new: 0, duplicate: 0, skipped: 0 };
  for (const r of rows) c[r.status]++;
  return c;
}

export const BATCH_STATUS_LABELS: Record<ImportBatch['status'], string> = {
  previewing: '待确认',
  committed: '已导入',
  reverted: '已撤销',
  expired: '已过期',
};

/** 分类来源的说明文字（鼠标悬停时显示） */
export function categorySourceText(row: ImportRow): string {
  switch (row.categorySource) {
    case 'user_rule':
      return `我的规则：${row.categoryReason ?? ''}`;
    case 'system_rule':
      return `系统规则：${row.categoryReason ?? ''}`;
    case 'source_hint':
      return row.categoryReason ?? '按账单原分类';
    case 'manual':
      return '手动选择';
    default:
      return '未能自动分类';
  }
}
