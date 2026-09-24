/**
 * 生成导入预览（docs/import.md §2 ⑤⑥⑦）：
 * 解析结果 + 账本已有数据 → 每行的状态（新 / 已导入过 / 跳过）、分类、退款与跨来源重复关联
 */
import { createHash } from 'node:crypto';
import type { ImportRow } from '@bookkeepx/contracts';
import { classify } from '@bookkeepx/core';
import { type BillRecord, type ImportTemplate, isRefundRecord } from '@bookkeepx/importers';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { accounts, transactions } from '../../db/schema/index.ts';
import type { LedgerScope } from '../ledgers/access.ts';
import { loadClassifierConfig, loadSelfNames } from './classifier.ts';

/** 存在 import_batches.preview 中的一行：接口返回的字段 + 提交时需要的内部字段 */
export interface StoredRow extends ImportRow {
  externalId: string | null;
  balanceCents: number | null;
  raw: Record<string, string>;
  dedupeKey: string | null;
  categoryRuleId: string | null;
  isRefund: boolean;
  /** 退款对应的原消费：同一文件中的行，或数据库中已有的流水 */
  refundOf: { index: number | null; transactionId: string | null } | null;
  /** 本行是银行记录，与已有的平台记录重复：写入时 duplicate_of_id 指向它 */
  duplicateOfTransactionId: string | null;
  /** 本行是平台记录，已有的银行记录与之重复：提交后把那条银行记录的 duplicate_of_id 指向本行 */
  bankTransactionIdToMark: string | null;
}

export interface PreviewInput {
  template: ImportTemplate;
  records: BillRecord[];
  holderName: string | null;
  accountId: string | null;
  timezone: string;
}

/** 银行流水没有单号：用 账户 + 日期 + 带符号金额 + 交易后余额 作为去重键（余额可区分同日同额的两笔） */
export function bankDedupeKey(accountId: string | null, r: BillRecord): string | null {
  if (r.externalId || r.balanceCents === null) return null;
  const signed = r.direction === 'expense' ? -r.amountCents : r.amountCents;
  return createHash('sha256')
    .update(`${accountId ?? 'none'}|${r.occurredAt.slice(0, 10)}|${signed}|${r.balanceCents}`)
    .digest('hex');
}

const isBankTemplate = (t: ImportTemplate) => t.account?.kind === 'bank_debit' || t.account?.kind === 'credit_card';

export async function buildPreview(db: Db, scope: LedgerScope, input: PreviewInput): Promise<StoredRow[]> {
  const { template: t, records, accountId, timezone } = input;
  const ledger = scope.ledgerId;

  // ── 同来源去重：平台单号 / 银行去重键 ──
  const ids = records.map((r) => r.externalId).filter((x): x is string => !!x);
  const existingIds = new Set(
    ids.length === 0
      ? []
      : (
          await db
            .select({ id: transactions.externalId })
            .from(transactions)
            .where(
              and(
                eq(transactions.ledgerId, ledger),
                eq(transactions.externalSource, t.source),
                inArray(transactions.externalId, ids),
                isNull(transactions.deletedAt),
              ),
            )
        ).map((r) => r.id),
  );
  const keys = records.map((r) => bankDedupeKey(accountId, r)).filter((x): x is string => !!x);
  const existingKeys = new Set(
    keys.length === 0
      ? []
      : (
          await db
            .select({ k: transactions.dedupeKey })
            .from(transactions)
            .where(
              and(
                eq(transactions.ledgerId, ledger),
                inArray(transactions.dedupeKey, keys),
                isNull(transactions.deletedAt),
              ),
            )
        ).map((r) => r.k),
  );

  // ── 退款的原消费在历史导入中的记录：按原订单号查找。
  //    文件内找不到原消费时靠它；文件内找到了但原消费之前已导入过（本次不再写入）时也靠它 ──
  const refundLookups = records.filter((r) => r.refund?.ofExternalId);
  const originals = new Map(
    refundLookups.length === 0
      ? []
      : (
          await db
            .select({ id: transactions.id, externalId: transactions.externalId })
            .from(transactions)
            .where(
              and(
                eq(transactions.ledgerId, ledger),
                eq(transactions.externalSource, t.source),
                inArray(
                  transactions.externalId,
                  refundLookups.map((r) => r.refund!.ofExternalId!),
                ),
                isNull(transactions.deletedAt),
              ),
            )
        ).map((r) => [r.externalId!, r.id] as const),
  );

  // ── 跨来源重复（ADR-0004 Q2-B）──
  const cardAccounts = await db
    .select({ id: accounts.id, last4: accounts.cardLast4 })
    .from(accounts)
    .where(and(eq(accounts.ledgerId, ledger), sql`${accounts.cardLast4} IS NOT NULL`));
  const [thisAccount] = accountId ? cardAccounts.filter((a) => a.id === accountId) : [];

  /** 在库中找与某行"同一天、同金额"的候选流水 */
  const sameDay = (r: BillRecord) =>
    and(
      eq(transactions.ledgerId, ledger),
      eq(transactions.amountCents, r.amountCents),
      eq(transactions.direction, 'expense'),
      isNull(transactions.deletedAt),
      isNull(transactions.duplicateOfId),
      sql`(${transactions.occurredAt} AT TIME ZONE ${timezone})::date = ${r.occurredAt.slice(0, 10)}::date`,
    );

  const cfg = await loadClassifierConfig(db, scope);
  const selfNames = [...(await loadSelfNames(db, scope)), ...(input.holderName ? [input.holderName] : [])];

  const rows: StoredRow[] = [];
  for (const r of records) {
    const refund = isRefundRecord(r, t) && r.refund ? r.refund : null;
    const dedupeKey = bankDedupeKey(accountId, r);
    const duplicate = (r.externalId && existingIds.has(r.externalId)) || (dedupeKey && existingKeys.has(dedupeKey));
    const status: ImportRow['status'] = r.skipReason ? 'skipped' : duplicate ? 'duplicate' : 'new';

    // 分类：退款不单独分类（统计时冲减原消费的分类）
    const c = refund
      ? { categoryId: null, direction: r.direction, source: 'none' as const, ruleId: null, reason: null }
      : classify(
          {
            direction: r.direction,
            amountCents: r.amountCents,
            counterparty: r.counterparty,
            description: r.description,
            paymentMethod: r.paymentMethod,
            sourceHint: r.categoryHint,
            source: t.source,
            selfNames,
          },
          cfg,
        );

    let duplicateOfTransactionId: string | null = null;
    let bankTransactionIdToMark: string | null = null;
    // 用分类后的方向判断：银行转入理财的那笔原始方向是支出，但已被识别为中性（Q2-A），不属于重复消费
    if (status === 'new' && c.direction === 'expense' && !refund) {
      if (isBankTemplate(t) && thisAccount?.last4) {
        // 本文件是银行流水：找平台账单里用这张卡付款的同一笔消费
        const [p] = await db
          .select({ id: transactions.id })
          .from(transactions)
          .where(
            and(
              sameDay(r),
              inArray(transactions.externalSource, ['alipay', 'wechat']),
              sql`${transactions.paymentMethod} LIKE ${`%(${thisAccount.last4})%`}`,
            ),
          )
          .limit(1);
        duplicateOfTransactionId = p?.id ?? null;
      } else if (!isBankTemplate(t) && r.paymentMethod) {
        // 本文件是平台账单：付款方式里提到哪张卡，就到那张卡的账户里找同一笔
        const card = cardAccounts.find((a) => r.paymentMethod!.includes(`(${a.last4})`));
        if (card) {
          const [b] = await db
            .select({ id: transactions.id })
            .from(transactions)
            .where(and(sameDay(r), eq(transactions.accountId, card.id), isNull(transactions.externalId)))
            .limit(1);
          bankTransactionIdToMark = b?.id ?? null;
        }
      }
    }

    rows.push({
      index: r.index,
      rowLabel: r.rowLabel,
      status,
      reason: status === 'skipped' ? r.skipReason : status === 'duplicate' ? '已导入过' : null,
      occurredAt: r.occurredAt,
      timePrecision: r.timePrecision,
      direction: c.direction,
      originalDirection: r.direction,
      amountCents: r.amountCents,
      counterparty: r.counterparty,
      description: r.description,
      paymentMethod: r.paymentMethod,
      sourceHint: r.categoryHint,
      categoryId: c.categoryId,
      categorySource: c.source,
      categoryReason: c.reason,
      refund: refund
        ? { linked: refund.ofIndex !== null || (!!refund.ofExternalId && originals.has(refund.ofExternalId)) }
        : null,
      crossSource: duplicateOfTransactionId ? 'bank_side' : bankTransactionIdToMark ? 'platform_side' : null,
      externalId: r.externalId,
      balanceCents: r.balanceCents,
      raw: r.raw,
      dedupeKey,
      categoryRuleId: c.ruleId,
      isRefund: !!refund,
      refundOf: refund
        ? {
            index: refund.ofIndex,
            transactionId: refund.ofExternalId ? (originals.get(refund.ofExternalId) ?? null) : null,
          }
        : null,
      duplicateOfTransactionId,
      bankTransactionIdToMark,
    });
  }
  return rows;
}
