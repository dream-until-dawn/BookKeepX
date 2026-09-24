/**
 * 导入预览：逐行查看识别结果，可改分类、取消勾选，然后确认导入或放弃
 *
 * 行数可能上千，默认只渲染前 PAGE 行，"显示更多"再追加，避免一次渲染过多下拉框。
 */
import type { Account, Category, ImportBatch, ImportRow } from '@bookkeepx/contracts';
import { formatCents, toZonedDisplay } from '@bookkeepx/core';
import { useState } from 'react';
import { Badge, Button, inputClass } from '../../shared/ui/index.tsx';
import { amountClass, amountText, categoryOptions } from '../transactions/format.ts';
import {
  canInclude,
  categorySourceText,
  type Edits,
  effectiveCategoryId,
  includedSummary,
  isIncluded,
  type RowEdit,
  statusCounts,
} from './preview.ts';

const PAGE = 200;

type Filter = 'all' | ImportRow['status'];
const FILTER_LABELS: Record<Filter, string> = { all: '全部', new: '新记录', duplicate: '已导入过', skipped: '已跳过' };

export interface PreviewPanelProps {
  batch: ImportBatch;
  timezone: string;
  categories: Category[];
  accounts: Account[];
  edits: Edits;
  onEdit: (index: number, patch: RowEdit) => void;
  onCommit: () => void;
  onDiscard: () => void;
  /** 没能自动对应到账户时，选择账户后重新识别（需要浏览器里还保留着文件） */
  onChooseAccount?: ((accountId: string) => void) | undefined;
  pending: boolean;
}

export function PreviewPanel(p: PreviewPanelProps) {
  const { batch, timezone, categories, edits } = p;
  const rows = batch.rows ?? [];
  const [filter, setFilter] = useState<Filter>('all');
  const [shown, setShown] = useState(PAGE);
  const counts = statusCounts(rows);
  const sum = includedSummary(rows, edits);
  const visible = filter === 'all' ? rows : rows.filter((r) => r.status === filter);
  const account = p.accounts.find((a) => a.id === batch.accountId);

  return (
    <section aria-label="导入预览" className="space-y-4">
      <div className="rounded-lg bg-white p-4 text-sm ring-1 ring-gray-200">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{batch.fileName}</span>
          <Badge tone="blue">{batch.templateName}</Badge>
        </div>
        <div className="mt-1 text-gray-500">
          {[
            batch.periodStart && batch.periodEnd ? `${batch.periodStart} 至 ${batch.periodEnd}` : null,
            batch.holderName ? `户名：${batch.holderName}` : null,
            `共 ${batch.totalRows} 行`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-gray-500">资金账户：</span>
          {account ? (
            <span>{account.name}</span>
          ) : p.onChooseAccount ? (
            <select
              aria-label="选择资金账户"
              className={inputClass}
              value=""
              onChange={(e) => e.target.value && p.onChooseAccount?.(e.target.value)}
            >
              <option value="">未对应账户（选择后重新识别）</option>
              {p.accounts
                .filter((a) => !a.archived)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          ) : (
            <span className="text-gray-400">未对应账户</span>
          )}
        </div>
        {batch.sameFileImportedBefore && (
          <p role="status" className="mt-2 rounded bg-amber-50 px-2 py-1 text-amber-800">
            这个文件之前已经导入过，重复的记录已自动排除。
          </p>
        )}
      </div>

      {/* 将导入部分的合计 */}
      <div
        className="grid grid-cols-4 gap-2 rounded-lg bg-white p-3 text-center ring-1 ring-gray-200"
        data-testid="import-summary"
      >
        <Stat label="将导入" value={`${sum.count} 笔`} />
        <Stat label="收入" value={formatCents(sum.incomeCents)} className="text-green-600" />
        <Stat label="支出" value={formatCents(sum.expenseCents)} />
        <Stat label="未分类" value={`${sum.uncategorized} 笔`} className={sum.uncategorized ? 'text-amber-600' : ''} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1" role="tablist" aria-label="按状态筛选">
          {(Object.keys(FILTER_LABELS) as Filter[]).map((f) => (
            <Button
              key={f}
              role="tab"
              aria-selected={filter === f}
              variant={filter === f ? 'primary' : 'secondary'}
              onClick={() => {
                setFilter(f);
                setShown(PAGE);
              }}
            >
              {FILTER_LABELS[f]} {f === 'all' ? rows.length : counts[f]}
            </Button>
          ))}
        </div>
        <div className="flex gap-2">
          <Button variant="danger" disabled={p.pending} onClick={p.onDiscard}>
            放弃
          </Button>
          <Button variant="primary" disabled={p.pending || sum.count === 0} onClick={p.onCommit}>
            确认导入 {sum.count} 笔
          </Button>
        </div>
      </div>

      <ul className="divide-y divide-gray-100 rounded-lg bg-white ring-1 ring-gray-200">
        {visible.slice(0, shown).map((row) => (
          <PreviewRow
            key={row.index}
            row={row}
            timezone={timezone}
            categories={categories}
            included={isIncluded(row, edits)}
            categoryId={effectiveCategoryId(row, edits)}
            onEdit={(patch) => p.onEdit(row.index, patch)}
          />
        ))}
        {visible.length === 0 && <li className="p-6 text-center text-sm text-gray-500">没有这类记录</li>}
      </ul>
      {visible.length > shown && (
        <div className="text-center">
          <Button onClick={() => setShown((n) => n + PAGE)}>显示更多（还有 {visible.length - shown} 行）</Button>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, className = '' }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`font-medium ${className}`}>{value}</div>
    </div>
  );
}

function PreviewRow({
  row,
  timezone,
  categories,
  included,
  categoryId,
  onEdit,
}: {
  row: ImportRow;
  timezone: string;
  categories: Category[];
  included: boolean;
  categoryId: string | null;
  onEdit: (patch: RowEdit) => void;
}) {
  const at = toZonedDisplay(row.occurredAt, timezone);
  const when = row.timePrecision === 'day' ? at.date : `${at.date} ${at.time}`;
  const title = row.counterparty || row.description || row.rowLabel;
  const isRefund = row.refund !== null;
  const money = { direction: row.direction, amountCents: row.amountCents, isRefund };
  return (
    <li
      className={`flex flex-wrap items-center gap-3 px-3 py-2 text-sm ${included ? '' : 'bg-gray-50 text-gray-400'}`}
      data-testid="preview-row"
    >
      <input
        type="checkbox"
        aria-label={`导入 ${row.rowLabel}`}
        checked={included}
        disabled={!canInclude(row)}
        onChange={(e) => onEdit({ include: e.target.checked })}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{title}</span>
          {row.status === 'duplicate' && <Badge>已导入过</Badge>}
          {row.status === 'skipped' && <Badge>跳过：{row.reason}</Badge>}
          {isRefund && <Badge tone="amber">{row.refund?.linked ? '退款·已关联原消费' : '退款·未找到原消费'}</Badge>}
          {row.crossSource === 'bank_side' && <Badge tone="amber">与平台账单重复，不计入统计</Badge>}
          {row.crossSource === 'platform_side' && <Badge tone="blue">银行卡支付，银行那条将不计入统计</Badge>}
          {row.direction !== row.originalDirection && <Badge>已识别为中性</Badge>}
        </div>
        <div className="text-xs text-gray-500">
          {[when, row.counterparty && row.description ? row.description : null, row.paymentMethod, row.rowLabel]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
      {isRefund ? (
        <span className="w-44 text-xs text-gray-500">冲减原消费的分类</span>
      ) : (
        <select
          aria-label={`分类 ${row.rowLabel}`}
          title={categorySourceText(row)}
          className={`${inputClass} w-44`}
          disabled={!included}
          value={categoryId ?? ''}
          onChange={(e) => onEdit({ categoryId: e.target.value || null })}
        >
          <option value="">未分类</option>
          {categoryOptions(categories, row.direction).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      <span className={`w-24 text-right tabular-nums ${included ? amountClass(money) : ''}`}>{amountText(money)}</span>
    </li>
  );
}
