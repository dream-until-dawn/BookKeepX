/**
 * 规范化 + 自校验：Table → 标准导入记录
 *
 * 所有来源共用这一套逻辑，差异全部由模板配置表达（ADR-0003）。
 * 自校验用文件自带的冗余信息反证解析是否正确（P0-1）：汇总比对、银行余额链。
 */

import { TIME_FORMAT_PATTERNS } from '@bookkeepx/contracts';
import { MoneyParseError, parseYuanToCents, wallTimeToIso } from '@bookkeepx/core';
import type { Cell } from './reader.ts';
import type { Table } from './table.ts';
import type { ImportTemplate } from './template.ts';

export type Direction = 'income' | 'expense' | 'neutral';

/** 一条导入记录 */
export interface ImportRecord {
  /** 在文件中的顺序（从 0 开始），预览与提交时用它指代这一行 */
  index: number;
  /** 行位置描述，如"第 25 行"，用于提示 */
  rowLabel: string;
  /** 带时区偏移的 ISO 时间 */
  occurredAt: string;
  timePrecision: 'second' | 'day';
  direction: Direction;
  /** 金额（分），恒为正 */
  amountCents: number;
  counterparty: string;
  description: string;
  externalId: string | null;
  paymentMethod: string | null;
  status: string | null;
  /** 账单原生分类 */
  categoryHint: string | null;
  /** 银行流水的交易后余额（分） */
  balanceCents: number | null;
  /** 原始行：表头 → 单元格文字，写入流水的 raw 字段 */
  raw: Record<string, string>;
  /** 被跳过的原因（交易关闭、0 元等）；为 null 表示正常入账 */
  skipReason: string | null;
  /** 退款信息（退款关联步骤填写）；不是退款时为 null */
  refund: { ofIndex: number | null; ofExternalId: string | null } | null;
}

export interface VerifyIssue {
  check: string;
  detail: string;
}

export interface ParsedFile {
  records: ImportRecord[];
  /** 无法解析的行；非空时自校验失败 */
  errors: { row: string; message: string }[];
  issues: VerifyIssue[];
  meta: {
    holderName: string | null;
    /** 文件中账号的末 4 位数字（银行流水） */
    accountLast4: string | null;
    /** 账单覆盖的时间范围（取记录中的最早、最晚日期） */
    periodStart: string | null;
    periodEnd: string | null;
  };
}

const TIME_RE = TIME_FORMAT_PATTERNS;

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * 时间单元格 → 墙上时间 "YYYY-MM-DDTHH:mm:ss"
 * Excel 日期单元格没有时区，读取库按 UTC 解释成 Date，所以它的 UTC 字段才是账单上写的数字（P0-1 发现）
 */
function toWall(c: Cell, format: ImportTemplate['time']['format']): { wall: string; precision: 'second' | 'day' } {
  if (c instanceof Date) {
    const wall = `${c.getUTCFullYear()}-${pad(c.getUTCMonth() + 1)}-${pad(c.getUTCDate())}T${pad(c.getUTCHours())}:${pad(c.getUTCMinutes())}:${pad(c.getUTCSeconds())}`;
    return { wall, precision: 'second' };
  }
  const s = String(c ?? '').trim();
  const m = TIME_RE[format].exec(s);
  if (!m) throw new Error(`时间 "${s}" 不符合格式 ${format}`);
  const [, y, mo, d, h, mi, se] = m;
  // 宽松格式的月、日、时可能是一位数，统一补零；省略的秒按 00
  const two = (x: string | undefined) => (x ?? '0').padStart(2, '0');
  const date = `${y}-${two(mo)}-${two(d)}`;
  return h === undefined
    ? { wall: `${date}T00:00:00`, precision: 'day' }
    : { wall: `${date}T${two(h)}:${mi}:${two(se)}`, precision: 'second' };
}

/** 转义正则元字符，保证模板里的文字只按字面匹配 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 金额文字 → 分；把 MoneyParseError 转成行级错误信息 */
function cents(input: string | number): number {
  try {
    return parseYuanToCents(input);
  } catch (e) {
    throw new Error(e instanceof MoneyParseError ? e.message : `金额不合法：${String(input)}`);
  }
}

/** 从 "标签：N笔 X元" 提取汇总 */
function summaryOf(preamble: string, label: string) {
  // 金额可能为负（退款多于支出时）
  const m = new RegExp(`${escapeRegExp(label)}[：:]\\s*(\\d+)笔\\s*(-?[\\d.,]+)元`).exec(preamble);
  return m ? { count: Number(m[1]), cents: parseYuanToCents(m[2]!) } : undefined;
}

/** 从说明文字中按占位符提取一个值（取到行尾或空白为止） */
function extractPreamble(preamble: string, pattern: string | undefined): string | null {
  if (!pattern) return null;
  const [before = '', after = ''] = pattern.split('{v}');
  const m = new RegExp(`${escapeRegExp(before)}\\s*(\\S+?)\\s*${after ? escapeRegExp(after) : '(?:\\s|$)'}`, 'm').exec(
    preamble,
  );
  return m?.[1] ?? null;
}

/**
 * 按模板解析整张表
 * @param maxRows 仅解析前 N 行（识别阶段"试解析"用），此时不做自校验
 */
export function parseTable(table: Table, t: ImportTemplate, maxRows = Number.POSITIVE_INFINITY): ParsedFile {
  const colIndex = (ref?: string[]) => (ref ? table.header.findIndex((h) => ref.includes(h)) : -1);
  const idx = Object.fromEntries(Object.entries(t.columns).map(([k, v]) => [k, colIndex(v as string[])])) as Record<
    keyof ImportTemplate['columns'],
    number
  >;
  const dirCol = t.amount.mode === 'directionColumn' ? colIndex(t.amount.column) : -1;
  const statusCol = t.status ? colIndex(t.status.column) : -1;

  const clean = (c: Cell | undefined): string | null => {
    if (c === undefined || c === null) return null;
    // 支付宝为防 Excel 科学计数法在单号后加了制表符
    const s = (c instanceof Date ? c.toISOString() : String(c)).replace(/\t/g, '').trim();
    return t.nullTokens.includes(s) ? null : s;
  };
  const get = (row: Cell[], i: number) => (i >= 0 ? row[i] : undefined);

  const records: ImportRecord[] = [];
  const errors: ParsedFile['errors'] = [];

  table.rows.slice(0, maxRows).forEach((row, ri) => {
    const rowLabel = table.rowLabels[ri] ?? `#${ri}`;
    try {
      let direction: Direction;
      let amount: number;
      if (t.amount.mode === 'signed') {
        const signed = cents(clean(get(row, idx.amount)) ?? '');
        direction = signed >= 0 ? 'income' : 'expense';
        amount = Math.abs(signed);
      } else if (t.amount.mode === 'directionColumn') {
        const rawAmount = get(row, idx.amount);
        amount = cents(typeof rawAmount === 'number' ? rawAmount : (clean(rawAmount) ?? ''));
        const d = String(get(row, dirCol) ?? '').trim();
        const mapped = t.amount.map[d];
        if (!mapped) throw new Error(`未知收支类型 "${d}"`);
        direction = mapped;
      } else {
        const inc = clean(get(row, idx.income));
        const exp = clean(get(row, idx.expense));
        if ((inc === null) === (exp === null)) throw new Error('收入列与支出列必须恰好填写一个');
        direction = inc !== null ? 'income' : 'expense';
        amount = Math.abs(cents((inc ?? exp)!));
      }
      if (amount < 0) throw new Error('金额应为正数');
      if (amount === 0 && t.zeroAmount !== 'skip') throw new Error('金额为 0');

      const currency = clean(get(row, idx.currency));
      if (t.acceptCurrencies.length && currency && !t.acceptCurrencies.includes(currency)) {
        throw new Error(`不支持的币种 ${currency}`);
      }

      const { wall, precision } = toWall(get(row, idx.occurredAt) ?? null, t.time.format);
      const balance = clean(get(row, idx.balance));
      const status = clean(get(row, statusCol));
      const raw = Object.fromEntries(table.header.map((h, i) => [h, clean(row[i]) ?? '']).filter(([h]) => h));

      records.push({
        index: records.length,
        rowLabel,
        occurredAt: wallTimeToIso(wall, t.time.timezone),
        timePrecision: precision,
        direction,
        amountCents: amount,
        counterparty: clean(get(row, idx.counterparty)) ?? '',
        description: clean(get(row, idx.description)) ?? '',
        externalId: clean(get(row, idx.externalId)),
        paymentMethod: clean(get(row, idx.paymentMethod)),
        status,
        categoryHint: clean(get(row, idx.categoryHint)),
        balanceCents: balance === null ? null : cents(balance),
        raw,
        skipReason:
          amount === 0
            ? '金额为 0'
            : t.status && status && t.status.skip.includes(status)
              ? `状态为「${status}」`
              : null,
        refund: null,
      });
    } catch (e) {
      errors.push({ row: rowLabel, message: (e as Error).message });
    }
  });

  const dates = records.map((r) => r.occurredAt.slice(0, 10)).sort();
  const accountNumber = extractPreamble(table.preamble, t.preambleFields.accountNumber);
  const last4 = accountNumber?.replace(/\D/g, '').slice(-4) ?? '';
  const meta: ParsedFile['meta'] = {
    holderName: extractPreamble(table.preamble, t.preambleFields.holderName),
    accountLast4: last4.length === 4 ? last4 : null,
    periodStart: dates[0] ?? null,
    periodEnd: dates.at(-1) ?? null,
  };

  const issues = Number.isFinite(maxRows) ? [] : verify(table, t, records, errors);
  return { records, errors, issues, meta };
}

/** 退款中原消费不在本文件的那些（仅"按单号前缀关联"的模板能判断；其他模板视为全部在文件内） */
function orphanRefunds(t: ImportTemplate, records: ImportRecord[], refunds: ImportRecord[]): ImportRecord[] {
  const link = t.refund?.link;
  if (link?.mode !== 'externalIdPrefix') return [];
  const ids = new Set(records.map((r) => r.externalId).filter(Boolean));
  return refunds.filter((r) => {
    if (!r.externalId) return false;
    let cut = r.externalId.length;
    for (const s of link.separators) {
      const i = r.externalId.indexOf(s);
      if (i > 0 && i < cut) cut = i;
    }
    return !ids.has(r.externalId.slice(0, cut));
  });
}

/** 自校验：行解析错误、平台汇总比对、银行余额链 */
function verify(table: Table, t: ImportTemplate, records: ImportRecord[], errors: ParsedFile['errors']): VerifyIssue[] {
  const issues: VerifyIssue[] = errors.map((e) => ({ check: '行解析', detail: `${e.row}：${e.message}` }));
  const cfg = t.verify.summary;
  if (cfg) {
    const kept = records.filter((r) => r.skipReason === null);
    const counted = cfg.countIncludesSkipped ? records : kept;
    const summed = cfg.amountIncludesSkipped ? records : kept;
    const refundRecords = summed.filter((r) => cfg.refundStatuses.includes(r.status ?? ''));
    const refundCents = refundRecords.reduce((s, r) => s + r.amountCents, 0);
    /**
     * 原消费不在本文件中的退款（跨账单周期：上月买、本月退）。
     * 支付宝对这类退款是否也从支出汇总中扣除，现有样本无法验证（样本中的原消费都在同一文件内），
     * 因此两种口径都接受：扣除全部退款 / 只扣除原消费在本文件中的退款。见 docs/import.md §8。
     */
    const orphanRefundCents = orphanRefunds(t, records, refundRecords).reduce((s, r) => s + r.amountCents, 0);

    if (cfg.total) {
      const m = new RegExp(escapeRegExp(cfg.total).replace('\\{n\\}', '(\\d+)')).exec(table.preamble);
      if (!m) issues.push({ check: '汇总缺失', detail: `文件中找不到"${cfg.total}"` });
      else if (Number(m[1]) !== counted.length)
        issues.push({ check: '总笔数', detail: `账单写明 ${m[1]} 笔，实际解析出 ${counted.length} 笔` });
    }
    for (const [dir, label] of Object.entries(cfg.labels) as [Direction, string][]) {
      const expected = summaryOf(table.preamble, label);
      if (!expected) {
        issues.push({ check: '汇总缺失', detail: `文件中找不到"${label}"汇总行` });
        continue;
      }
      const n = counted.filter((r) => r.direction === dir).length;
      // 支付宝口径：退款从支出汇总中扣除（P0-1d 用 5 份文件验证）
      const c =
        summed.filter((r) => r.direction === dir).reduce((s, r) => s + r.amountCents, 0) -
        (dir === 'expense' ? refundCents : 0);
      // 另一种口径：跨周期退款不扣除
      const alt = dir === 'expense' ? c + orphanRefundCents : c;
      if (n !== expected.count)
        issues.push({ check: `${label}笔数`, detail: `账单写明 ${expected.count} 笔，实际 ${n} 笔` });
      if (c !== expected.cents && alt !== expected.cents)
        issues.push({ check: `${label}金额`, detail: `账单写明 ${expected.cents} 分，实际 ${c} 分` });
    }
  }
  if (t.verify.balanceChain) {
    // 账单可能按时间正序（旧 → 新）或倒序（新 → 旧）排列：任一方向整条链对得上即通过；
    // 都对不上时报告正序的问题（与账单顺序一致，便于用户对照）
    const asc = balanceChainIssues(records);
    if (asc.length > 0 && balanceChainIssues([...records].reverse()).length > 0) issues.push(...asc);
  }
  return issues;
}

/** 余额链：上一笔余额 + 本笔金额 = 本笔余额（按传入顺序） */
function balanceChainIssues(records: ImportRecord[]): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1]!;
    const cur = records[i]!;
    const signed = cur.direction === 'income' ? cur.amountCents : -cur.amountCents;
    if (prev.balanceCents === null || cur.balanceCents === null) {
      issues.push({ check: '余额链', detail: `${cur.rowLabel} 缺少余额` });
    } else if (prev.balanceCents + signed !== cur.balanceCents) {
      issues.push({ check: '余额链', detail: `${cur.rowLabel} 余额对不上，可能漏了记录或解析有误` });
    }
  }
  return issues;
}
