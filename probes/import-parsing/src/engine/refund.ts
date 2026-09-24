/**
 * 退款关联：把每条退款挂到它的原消费上（负责人决定方案 B：退款冲减原消费的支出）
 *
 * 在自校验之后执行 —— 自校验要用平台的原始口径，关联只影响入账与统计。
 *
 * 实测形态（P0-1e）：
 *   支付宝：退款是一条"不计收支 / 退款成功"，单号 = 原订单号 + "_" 或 "*" + …；
 *          全额退款后原消费的状态会变成"交易关闭"（此前被当作未发生而跳过）。
 *   微信：  退款是一条"收入"，交易类型为"xxx-退款"；原消费状态变为"已退款(￥x)"或"已全额退款"，单号无关联。
 */
import type { ParsedRecord } from '../common.ts';
import type { ImportTemplate } from './template.ts';

/** 带退款信息的记录 */
export type LinkedRecord = ParsedRecord & {
  categoryHint: string | null;
  /** 是退款时存在：linkedTo 为原消费的单号，找不到原消费时为 null（需要用户确认） */
  refund?: { linkedTo: string | null };
};

export interface RefundLinkResult {
  records: LinkedRecord[];
  /** 仍被跳过的记录 */
  skipped: (ParsedRecord & { skipReason: string })[];
  stats: { refunds: number; linked: number; restored: number };
}

/** 按分隔符取单号前缀（不用正则：分隔符来自模板配置） */
function prefixOf(id: string, separators: string[]): string {
  let cut = id.length;
  for (const s of separators) {
    const i = id.indexOf(s);
    if (i > 0 && i < cut) cut = i;
  }
  return id.slice(0, cut);
}

export function linkRefunds(
  records: LinkedRecord[],
  skipped: (ParsedRecord & { skipReason: string })[],
  t: ImportTemplate,
): RefundLinkResult {
  const cfg = t.refund;
  if (!cfg) return { records, skipped, stats: { refunds: 0, linked: 0, restored: 0 } };

  const isRefund = (r: LinkedRecord) =>
    (!!r.status && cfg.detect.statuses.includes(r.status)) || (!!cfg.detect.hintSuffix && !!r.categoryHint?.endsWith(cfg.detect.hintSuffix));

  // 复制一份再改，不修改调用方传入的数组
  const out: LinkedRecord[] = records.map((r) => ({ ...r }));
  let stillSkipped = skipped.map((r) => ({ ...r }));
  const refunds = out.filter(isRefund);
  // 原消费的候选：已入账的支出 + 被跳过的支出（全额退款后变成"交易关闭"的那些）
  const pool = (): LinkedRecord[] => [...out.filter((r) => r.direction === 'expense' && !isRefund(r)), ...stillSkipped.filter((r) => r.direction === 'expense' && r.amountCents > 0)];
  /** 每笔原消费已被退款冲减的金额，防止超额冲减 */
  const refundedSoFar = new Map<LinkedRecord, number>();
  let linked = 0;
  let restored = 0;

  for (const rf of refunds) {
    let original: LinkedRecord | undefined;
    if (cfg.link.mode === 'externalIdPrefix') {
      const key = rf.externalId ? prefixOf(rf.externalId, cfg.link.separators) : null;
      original = key && key !== rf.externalId ? pool().find((o) => o.externalId === key) : undefined;
    } else {
      const remaining = (o: LinkedRecord) => o.amountCents - (refundedSoFar.get(o) ?? 0);
      const nearest = (list: LinkedRecord[]) =>
        list.sort((a, b) => Math.abs(Date.parse(a.occurredAt) - Date.parse(rf.occurredAt)) - Math.abs(Date.parse(b.occurredAt) - Date.parse(rf.occurredAt)))[0];

      // 第一层：同对方、状态里有"退款"字样、剩余可退金额足够
      original = nearest(pool().filter((o) => o.counterparty === rf.counterparty && (o.status ?? '').includes('退款') && remaining(o) >= rf.amountCents));

      // 第二层（兜底）：对方名称对不上时（实测：退款行写"京东商城平台商户"、原消费写"京东"；
      // 被退回的转账，退款行的对方为空），按"状态写明的退款金额"精确匹配，且原消费须早于退款
      if (!original) {
        const yuan = (rf.amountCents / 100).toFixed(2); // 仅用于和状态文字比对，不参与计算
        original = nearest(
          pool().filter(
            (o) =>
              o.occurredAt <= rf.occurredAt &&
              remaining(o) >= rf.amountCents &&
              ((o.status === '已全额退款' && o.amountCents === rf.amountCents) || (o.status ?? '').includes(`(￥${yuan})`)),
          ),
        );
      }
    }
    // 超额冲减视为关联失败（例如金额对不上），宁可交给用户确认
    if (original && original.amountCents - (refundedSoFar.get(original) ?? 0) < rf.amountCents) original = undefined;

    rf.refund = { linkedTo: original?.externalId ?? null };
    if (!original) continue;
    linked++;
    refundedSoFar.set(original, (refundedSoFar.get(original) ?? 0) + rf.amountCents);

    // 原消费若被跳过（交易关闭），恢复入账：它确实付过钱，随后被退款抵消
    // 移动的是同一个对象，保证后续对同一原消费的部分退款仍能累计已冲减金额
    const idx = stillSkipped.indexOf(original as (typeof stillSkipped)[number]);
    if (idx >= 0) {
      const moved = stillSkipped[idx]! as Partial<(typeof stillSkipped)[number]>;
      delete moved.skipReason;
      out.push(moved as LinkedRecord);
      stillSkipped = stillSkipped.filter((_, i) => i !== idx);
      restored++;
    }
  }
  return { records: out, skipped: stillSkipped, stats: { refunds: refunds.length, linked, restored } };
}
