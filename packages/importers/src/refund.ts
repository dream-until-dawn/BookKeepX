/**
 * 文件内的退款关联（ADR-0004 Q4，P0-1e）
 *
 * 支付宝：退款单号 = 原订单号 + "_" / "*" + …，按前缀精确关联；全额退款后原消费变为"交易关闭"，关联后恢复入账
 * 微信：  按对方 + 状态 + 金额启发式关联（对方名不一致、转账退回时按"已全额退款 + 金额相同"兜底）
 *
 * 文件内找不到原消费时，支付宝仍给出原订单号（ofExternalId），供服务端到数据库里的历史导入中查找。
 */
import type { ImportRecord } from './parse.ts';
import type { ImportTemplate } from './template.ts';

/** 按分隔符取单号前缀（不用正则：分隔符来自模板配置） */
function prefixOf(id: string, separators: string[]): string {
  let cut = id.length;
  for (const s of separators) {
    const i = id.indexOf(s);
    if (i > 0 && i < cut) cut = i;
  }
  return id.slice(0, cut);
}

export function isRefundRecord(r: ImportRecord, t: ImportTemplate): boolean {
  const cfg = t.refund;
  if (!cfg) return false;
  return (
    (!!r.status && cfg.detect.statuses.includes(r.status)) ||
    (!!cfg.detect.hintSuffix && !!r.categoryHint?.endsWith(cfg.detect.hintSuffix))
  );
}

/** 就地填写每条退款记录的 refund 字段；被关联的"交易关闭"原消费恢复入账（清空 skipReason） */
export function linkRefundsInFile(records: ImportRecord[], t: ImportTemplate): void {
  const cfg = t.refund;
  if (!cfg) return;
  const refunded = new Map<number, number>();
  const remaining = (o: ImportRecord) => o.amountCents - (refunded.get(o.index) ?? 0);
  // 原消费的候选：支出（含被跳过的交易关闭，但不含 0 元）
  const candidates = records.filter((r) => r.direction === 'expense' && r.amountCents > 0 && !isRefundRecord(r, t));
  const nearest = (list: ImportRecord[], rf: ImportRecord) =>
    [...list].sort(
      (a, b) =>
        Math.abs(Date.parse(a.occurredAt) - Date.parse(rf.occurredAt)) -
        Math.abs(Date.parse(b.occurredAt) - Date.parse(rf.occurredAt)),
    )[0];

  for (const rf of records) {
    if (!isRefundRecord(rf, t) || rf.skipReason === '金额为 0') continue;
    let original: ImportRecord | undefined;
    let ofExternalId: string | null = null;

    if (cfg.link.mode === 'externalIdPrefix') {
      const key = rf.externalId ? prefixOf(rf.externalId, cfg.link.separators) : null;
      if (key && key !== rf.externalId) {
        ofExternalId = key;
        original = candidates.find((o) => o.externalId === key);
      }
    } else {
      original = nearest(
        candidates.filter(
          (o) =>
            o.counterparty === rf.counterparty && (o.status ?? '').includes('退款') && remaining(o) >= rf.amountCents,
        ),
        rf,
      );
      if (!original) {
        const yuan = (rf.amountCents / 100).toFixed(2); // 仅用于与状态文字比对
        original = nearest(
          candidates.filter(
            (o) =>
              o.occurredAt <= rf.occurredAt &&
              remaining(o) >= rf.amountCents &&
              ((o.status === '已全额退款' && o.amountCents === rf.amountCents) ||
                (o.status ?? '').includes(`(￥${yuan})`)),
          ),
          rf,
        );
      }
    }
    // 禁止超额冲减：同一原消费多次部分退款累计计算
    if (original && remaining(original) < rf.amountCents) original = undefined;

    rf.refund = { ofIndex: original?.index ?? null, ofExternalId: original ? original.externalId : ofExternalId };
    if (original) {
      refunded.set(original.index, (refunded.get(original.index) ?? 0) + rf.amountCents);
      // 全额退款后原消费变成"交易关闭"：它确实付过钱，恢复入账并与退款抵消
      if (original.skipReason?.startsWith('状态为')) original.skipReason = null;
    }
  }
}
