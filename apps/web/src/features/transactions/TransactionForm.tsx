/**
 * 记一笔 / 编辑流水 的表单
 *
 * - 时间输入框是账本时区的墙上时间，提交时换算成带偏移的 ISO 时间（core 的 wallTimeToIso）
 * - 提交前用契约 schema 校验，与服务端同一套规则
 * - 编辑导入的流水时，金额、时间、方向、对方锁定（服务端同样拒绝修改，docs/api.md）
 */
import {
  type Account,
  type Category,
  createTransactionRequestSchema,
  DIRECTION_LABELS,
  type Direction,
  type Transaction,
} from '@bookkeepx/contracts';
import { formatCents, toZonedDisplay, wallTimeToIso } from '@bookkeepx/core';
import { useState } from 'react';
import { Button, inputClass } from '../../shared/ui/index.tsx';
import { accountOptions, categoryOptions } from './format.ts';

export interface TransactionFormValues {
  direction: Direction;
  /** 元字符串 */
  amount: string;
  /** 带偏移的 ISO 时间 */
  occurredAt: string;
  categoryId: string | null;
  accountId: string | null;
  counterparty: string;
  note: string;
}

interface Props {
  categories: Category[];
  accounts: Account[];
  timezone: string;
  /** 编辑时传入原流水；新增时不传 */
  initial?: Transaction;
  submitLabel: string;
  pending: boolean;
  onSubmit: (values: TransactionFormValues) => void;
  onCancel?: () => void;
  onDelete?: () => void;
}

export function TransactionForm({
  categories,
  accounts,
  timezone,
  initial,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
  onDelete,
}: Props) {
  const imported = initial?.source === 'import';
  const [direction, setDirection] = useState<Direction>(initial?.direction ?? 'expense');
  const [amount, setAmount] = useState(initial ? formatCents(initial.amountCents, { grouping: false }) : '');
  const [wall, setWall] = useState(toZonedDisplay(initial?.occurredAt ?? new Date(), timezone).wall);
  const [categoryId, setCategoryId] = useState<string | null>(initial?.categoryId ?? null);
  const [accountId, setAccountId] = useState<string | null>(initial?.accountId ?? null);
  const [counterparty, setCounterparty] = useState(initial?.counterparty ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [error, setError] = useState<string | null>(null);

  const catOptions = categoryOptions(categories, direction, initial?.categoryId);
  const accOptions = accountOptions(accounts, initial?.accountId);

  function changeDirection(d: Direction) {
    setDirection(d);
    // 分类与方向必须一致：换方向时清空已选分类
    setCategoryId(null);
  }

  function submit() {
    let occurredAt: string;
    try {
      occurredAt = wallTimeToIso(wall, timezone);
    } catch {
      setError('请填写正确的时间');
      return;
    }
    const values = { direction, amount, occurredAt, categoryId, accountId, counterparty, note };
    const r = createTransactionRequestSchema.safeParse(values);
    if (!r.success) {
      setError(r.error.issues[0]?.message ?? '输入不合法');
      return;
    }
    setError(null);
    onSubmit(values);
  }

  return (
    <form
      noValidate
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {imported && (
        <p className="rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-700">
          这笔来自导入的账单：金额、时间、收支类型和交易对方以账单为准，不能修改。
        </p>
      )}
      {/* 原生单选框（视觉上隐藏）+ 胶囊样式的文字：键盘、屏幕阅读器都能正常使用 */}
      <fieldset className="flex gap-2" disabled={imported}>
        <legend className="sr-only">收支类型</legend>
        {(Object.keys(DIRECTION_LABELS) as Direction[]).map((d) => (
          <label key={d} className="cursor-pointer">
            <input
              type="radio"
              name="direction"
              value={d}
              checked={direction === d}
              onChange={() => changeDirection(d)}
              className="peer sr-only"
            />
            <span
              className={`inline-block rounded-full px-4 py-1 text-sm peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-disabled:opacity-60 ${
                direction === d ? 'bg-blue-600 text-white' : 'bg-white ring-1 ring-gray-300'
              }`}
            >
              {DIRECTION_LABELS[d]}
            </span>
          </label>
        ))}
      </fieldset>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col text-sm">
          金额（元）
          <input
            className={inputClass}
            inputMode="decimal"
            value={amount}
            disabled={imported}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="如 32.5"
          />
        </label>
        <label className="flex flex-col text-sm">
          时间
          <input
            className={inputClass}
            type="datetime-local"
            value={wall}
            disabled={imported}
            onChange={(e) => setWall(e.target.value)}
          />
        </label>
        <label className="flex flex-col text-sm">
          分类
          <select
            className={inputClass}
            value={categoryId ?? ''}
            onChange={(e) => setCategoryId(e.target.value || null)}
          >
            <option value="">未分类</option>
            {catOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-sm">
          账户
          <select className={inputClass} value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value || null)}>
            <option value="">不指定</option>
            {accOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-sm">
          交易对方
          <input
            className={inputClass}
            value={counterparty}
            disabled={imported}
            onChange={(e) => setCounterparty(e.target.value)}
          />
        </label>
        <label className="flex flex-col text-sm">
          备注
          <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      {initial?.description && <p className="text-sm text-gray-500">账单说明：{initial.description}</p>}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? '保存中…' : submitLabel}
        </Button>
        {onCancel && <Button onClick={onCancel}>取消</Button>}
        {onDelete && (
          <Button variant="danger" className="ml-auto" onClick={onDelete}>
            删除
          </Button>
        )}
      </div>
    </form>
  );
}
