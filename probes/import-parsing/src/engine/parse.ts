/**
 * 规范化 + 自校验：Table → 标准流水记录
 *
 * 所有来源共用这一套逻辑，差异全部由模板配置表达。
 */
import { excelDateToWallClock, yuanToCents, type Direction, type FileSummary, type ParsedRecord } from '../common.ts';
import { checkBalanceChain, type CheckIssue } from '../verify.ts';
import type { Cell } from './reader.ts';
import type { Table } from './table.ts';
import type { ImportTemplate } from './template.ts';

export interface RowError {
  row: string;
  message: string;
}

export interface EngineResult {
  templateId: string;
  templateVersion: number;
  /** 可入账的记录 */
  records: (ParsedRecord & { categoryHint: string | null })[];
  /** 跳过的记录（0 元、按状态过滤）；保留下来用于汇总口径与预览展示 */
  skipped: (ParsedRecord & { skipReason: string })[];
  /** 无法解析的行 */
  errors: RowError[];
  summary: FileSummary;
  /** 自校验问题；为空才允许入库 */
  issues: CheckIssue[];
  /** 从说明文字中提取的元信息（如户主姓名） */
  meta: { holderName?: string };
}

const TIME_RE: Record<ImportTemplate['time']['format'], RegExp> = {
  'yyyy-MM-dd HH:mm:ss': /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/,
  'yyyy-MM-dd': /^(\d{4})-(\d{2})-(\d{2})$/,
  'yyyy/MM/dd HH:mm:ss': /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/,
  'yyyy/MM/dd': /^(\d{4})\/(\d{2})\/(\d{2})$/,
};

/** 把时间单元格统一成 "YYYY-MM-DD HH:mm:ss" 墙上时间 */
function toWallClock(c: Cell, format: ImportTemplate['time']['format']): string {
  if (c instanceof Date) return excelDateToWallClock(c);
  const s = String(c ?? '').trim();
  const m = TIME_RE[format].exec(s);
  if (!m) throw new Error(`时间 "${s}" 不符合格式 ${format}`);
  const [, y, mo, d, h = '00', mi = '00', se = '00'] = m;
  return `${y}-${mo}-${d} ${h}:${mi}:${se}`;
}

/** 转义正则元字符，保证模板里的文字只按字面匹配 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从 "标签：N笔 X元" 提取汇总 */
function summaryOf(preamble: string, label: string) {
  const m = new RegExp(`${escapeRegExp(label)}[：:]\\s*(\\d+)笔\\s*([\\d.,]+)元`).exec(preamble);
  return m ? { count: Number(m[1]), cents: yuanToCents(m[2]!) } : undefined;
}

/**
 * 按模板解析整张表
 * @param maxRows 仅解析前 N 行（识别阶段"试解析"用）
 */
export function parseTable(table: Table, t: ImportTemplate, maxRows = Infinity): EngineResult {
  // 列名 → 下标。别名列表中第一个在表头里出现的生效
  const colIndex = (ref?: string[]) => (ref ? table.header.findIndex((h) => ref.includes(h)) : -1);
  const idx = Object.fromEntries(Object.entries(t.columns).map(([k, v]) => [k, colIndex(v as string[])])) as Record<keyof ImportTemplate['columns'], number>;
  const dirCol = t.amount.mode === 'directionColumn' ? colIndex(t.amount.column) : -1;
  const statusCol = t.status ? colIndex(t.status.column) : -1;

  const isNull = (c: Cell) => c === null || t.nullTokens.includes(String(c).replace(/\t/g, '').trim());
  const text = (c: Cell | undefined): string | null => (c === undefined || isNull(c) ? null : String(c).replace(/\t/g, '').trim());
  const get = (row: Cell[], i: number) => (i >= 0 ? row[i] : undefined);

  const records: EngineResult['records'] = [];
  const skipped: EngineResult['skipped'] = [];
  const errors: RowError[] = [];

  table.rows.slice(0, maxRows).forEach((row, ri) => {
    try {
      // ① 金额与方向
      let direction: Direction;
      let cents: number;
      if (t.amount.mode === 'signed') {
        const signed = yuanToCents(text(get(row, idx.amount)) ?? '');
        if (signed === 0) throw new Error('金额为 0');
        direction = signed > 0 ? 'income' : 'expense';
        cents = Math.abs(signed);
      } else if (t.amount.mode === 'directionColumn') {
        const raw = get(row, idx.amount);
        cents = yuanToCents(typeof raw === 'number' ? raw : (text(raw) ?? ''));
        const d = String(get(row, dirCol) ?? '').trim();
        const mapped = t.amount.map[d];
        if (!mapped) throw new Error(`未知收支类型 "${d}"`);
        direction = mapped;
      } else {
        const inc = text(get(row, idx.income));
        const exp = text(get(row, idx.expense));
        if ((inc === null) === (exp === null)) throw new Error('收入列与支出列必须恰好填写一个');
        direction = inc !== null ? 'income' : 'expense';
        cents = Math.abs(yuanToCents((inc ?? exp)!));
      }
      // 0 元交易（全额优惠、医保全额支付等）：模板允许时跳过并记录原因，否则视为解析错误
      if (cents === 0 && t.zeroAmount !== 'skip') throw new Error('金额为 0');
      if (cents < 0) throw new Error('金额应为正数');

      // ② 币种
      const currency = text(get(row, idx.currency));
      if (t.acceptCurrencies.length && currency && !t.acceptCurrencies.includes(currency)) throw new Error(`不支持的币种 ${currency}`);

      const balanceText = text(get(row, idx.balance));
      const rec = {
        occurredAt: toWallClock(get(row, idx.occurredAt) ?? null, t.time.format),
        direction,
        amountCents: cents,
        counterparty: text(get(row, idx.counterparty)) ?? '',
        description: text(get(row, idx.description)) ?? '',
        externalId: text(get(row, idx.externalId)),
        paymentMethod: text(get(row, idx.paymentMethod)),
        status: text(get(row, statusCol)),
        categoryHint: text(get(row, idx.categoryHint)),
        ...(balanceText !== null ? { balanceCents: yuanToCents(balanceText) } : {}),
      };

      // ③ 跳过：0 元交易、按状态过滤（如"交易关闭"）。保留在 skipped 中，供汇总比对与预览展示
      if (cents === 0) skipped.push({ ...rec, skipReason: '金额为 0' });
      else if (t.status && rec.status && t.status.skip.includes(rec.status)) skipped.push({ ...rec, skipReason: `状态为「${rec.status}」` });
      else records.push(rec);
    } catch (e) {
      errors.push({ row: table.rowLabels[ri] ?? `#${ri}`, message: (e as Error).message });
    }
  });

  // ④ 自校验
  const issues: CheckIssue[] = errors.map((e) => ({ check: '行解析', detail: `${e.row}: ${e.message}` }));
  const summary: FileSummary = {};
  const sumCfg = t.verify.summary;
  if (sumCfg) {
    // 占位符模式 → 正则：先转义用户文字中的正则元字符，再把 {n} 换成数字捕获组
    const totalM = sumCfg.total ? new RegExp(escapeRegExp(sumCfg.total).replace('\\{n\\}', '(\\d+)')).exec(table.preamble) : null;
    if (totalM) summary.total = Number(totalM[1]);
    else if (sumCfg.total) issues.push({ check: '汇总缺失', detail: `模板声明了总笔数 "${sumCfg.total}"，但文件中未找到` });
    for (const [dir, label] of Object.entries(sumCfg.labels) as [Direction, string][]) {
      summary[dir] = summaryOf(table.preamble, label);
      // 模板声明了汇总却提取不到：说明格式变了或选错了模板，必须报出来，否则比对会被静默跳过
      if (!summary[dir]) issues.push({ check: '汇总缺失', detail: `模板声明了 "${label}" 汇总行，但文件中未找到` });
    }

    // 平台汇总的统计口径由模板声明（支付宝实测口径见 docs/probes/p0-1d-*.md）
    const counted = sumCfg.countIncludesSkipped ? [...records, ...skipped] : records;
    const summed = sumCfg.amountIncludesSkipped ? [...records, ...skipped] : records;
    const refundCents = summed.filter((r) => sumCfg.refundStatuses.includes(r.status ?? '')).reduce((s, r) => s + r.amountCents, 0);
    if (summary.total !== undefined && summary.total !== counted.length)
      issues.push({ check: '总笔数', detail: `文件声明 ${summary.total} 笔，解析 ${counted.length} 笔` });
    for (const dir of ['income', 'expense', 'neutral'] as Direction[]) {
      const exp = summary[dir];
      if (!exp) continue;
      const n = counted.filter((r) => r.direction === dir).length;
      // 支出汇总扣除退款：平台把退款记为中性，但在支出汇总里做了冲减
      const c = summed.filter((r) => r.direction === dir).reduce((s, r) => s + r.amountCents, 0) - (dir === 'expense' ? refundCents : 0);
      if (n !== exp.count) issues.push({ check: `${dir} 笔数`, detail: `声明 ${exp.count}，解析 ${n}` });
      if (c !== exp.cents) issues.push({ check: `${dir} 金额`, detail: `声明 ${exp.cents} 分，解析 ${c} 分` });
    }
  }
  if (t.verify.balanceChain) issues.push(...checkBalanceChain(records));

  // ⑤ 说明文字中的元信息
  const meta: EngineResult['meta'] = {};
  if (t.preambleFields.holderName) {
    const [before, after] = t.preambleFields.holderName.split('{v}') as [string, string];
    const m = new RegExp(`${escapeRegExp(before)}\\s*(\\S+?)\\s*${after ? escapeRegExp(after) : '(?:\\s|$)'}`, 'm').exec(table.preamble);
    if (m) meta.holderName = m[1];
  }

  return { templateId: t.id, templateVersion: t.version, records, skipped, errors, summary, issues, meta };
}
