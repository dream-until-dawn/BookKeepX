/**
 * 资金账户管理（docs/api.md "资金账户"）
 *
 * 新增、编辑、停用 / 恢复、删除。已被使用的账户不能删除，只能停用。
 */
import {
  ACCOUNT_KIND_LABELS,
  type Account,
  type AccountKind,
  type CreateAccountRequest,
  createAccountRequestSchema,
} from '@bookkeepx/contracts';
import { useState } from 'react';
import { ApiError } from '../../shared/api/client.ts';
import { Badge, Button, ErrorBanner, inputClass, PageTitle } from '../../shared/ui/index.tsx';
import { useLedgerId } from '../ledger/useLedgerId.ts';
import { useAccountMutations, useAccounts } from './api.ts';

const KINDS = Object.entries(ACCOUNT_KIND_LABELS) as [AccountKind, string][];

export function AccountsPage() {
  const ledgerId = useLedgerId();
  if (!ledgerId) return null;
  return <AccountsEditor ledgerId={ledgerId} />;
}

function AccountsEditor({ ledgerId }: { ledgerId: string }) {
  const { data, isPending, error: loadError } = useAccounts(ledgerId);
  const m = useAccountMutations(ledgerId);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '操作失败，请重试');
      return false;
    }
  };

  if (isPending) return <p className="p-6 text-gray-500">正在加载…</p>;
  if (loadError) return <ErrorBanner message={`加载账户失败：${loadError.message}`} />;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <PageTitle description="钱从哪付、进了哪。银行卡填写卡号后四位，导入账单时能自动对应。">资金账户</PageTitle>
      <ErrorBanner message={error} onClose={() => setError(null)} />

      {data.length === 0 ? (
        <p className="mb-4 rounded-lg bg-white p-4 text-sm text-gray-500 ring-1 ring-gray-200">
          还没有账户，先在下面添加一个吧。
        </p>
      ) : (
        <ul className="mb-6 divide-y divide-gray-100 rounded-lg bg-white ring-1 ring-gray-200">
          {data.map((a) =>
            editingId === a.id ? (
              <li key={a.id} className="p-3">
                <AccountForm
                  initial={a}
                  submitLabel="保存"
                  onCancel={() => setEditingId(null)}
                  onSubmit={async (body) => {
                    if (await run(() => m.update.mutateAsync({ id: a.id, patch: body }))) setEditingId(null);
                  }}
                />
              </li>
            ) : (
              <AccountRow
                key={a.id}
                account={a}
                onEdit={() => setEditingId(a.id)}
                onToggleArchived={() => run(() => m.update.mutateAsync({ id: a.id, patch: { archived: !a.archived } }))}
                onDelete={() => run(() => m.remove.mutateAsync(a.id))}
              />
            ),
          )}
        </ul>
      )}

      <h2 className="mb-2 font-medium">添加账户</h2>
      <div className="rounded-lg bg-white p-3 ring-1 ring-gray-200">
        <AccountForm submitLabel="添加" onSubmit={async (body) => void (await run(() => m.create.mutateAsync(body)))} />
      </div>
    </main>
  );
}

function AccountRow({
  account: a,
  onEdit,
  onToggleArchived,
  onDelete,
}: {
  account: Account;
  onEdit: () => void;
  onToggleArchived: () => void;
  onDelete: () => void;
}) {
  const inUse = a.transactionCount > 0;
  return (
    <li className="flex items-center justify-between gap-2 px-3 py-2" data-testid={`account-${a.name}`}>
      <span className={`flex flex-wrap items-center gap-2 ${a.archived ? 'text-gray-400' : ''}`}>
        <span className="font-medium">{a.name}</span>
        <Badge>{ACCOUNT_KIND_LABELS[a.kind]}</Badge>
        {a.institution && <span className="text-sm text-gray-500">{a.institution}</span>}
        {a.cardLast4 && <span className="text-sm text-gray-500">尾号 {a.cardLast4}</span>}
        {a.archived && <Badge tone="amber">已停用</Badge>}
        {inUse && <Badge tone="blue">{a.transactionCount} 笔</Badge>}
      </span>
      <span className="flex gap-1">
        <Button variant="ghost" onClick={onEdit}>
          编辑
        </Button>
        <Button variant="ghost" onClick={onToggleArchived}>
          {a.archived ? '恢复' : '停用'}
        </Button>
        <Button
          variant="danger"
          disabled={inUse}
          title={inUse ? `已有 ${a.transactionCount} 笔流水使用，不能删除，可以停用` : '删除该账户'}
          onClick={() => {
            if (window.confirm(`确定删除账户"${a.name}"吗？`)) onDelete();
          }}
        >
          删除
        </Button>
      </span>
    </li>
  );
}

/** 新增 / 编辑共用的表单；提交前用契约 schema 校验（与服务端同一套规则） */
function AccountForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Account;
  submitLabel: string;
  onSubmit: (body: CreateAccountRequest) => Promise<void>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<AccountKind>(initial?.kind ?? 'wechat');
  const [institution, setInstitution] = useState(initial?.institution ?? '');
  const [cardLast4, setCardLast4] = useState(initial?.cardLast4 ?? '');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const isCard = kind === 'bank_debit' || kind === 'credit_card';

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const r = createAccountRequestSchema.safeParse({
          name,
          kind,
          institution: institution.trim() || null,
          cardLast4: isCard ? cardLast4 : null,
        });
        if (!r.success) {
          setFieldError(r.error.issues[0]?.message ?? '输入不合法');
          return;
        }
        setFieldError(null);
        await onSubmit(r.data);
        if (!initial) {
          setName('');
          setInstitution('');
          setCardLast4('');
        }
      }}
    >
      <label className="flex flex-col text-sm">
        名称
        <input
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如：招行储蓄卡"
        />
      </label>
      <label className="flex flex-col text-sm">
        类型
        <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as AccountKind)}>
          {KINDS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col text-sm">
        机构（可选）
        <input
          className={inputClass}
          value={institution}
          onChange={(e) => setInstitution(e.target.value)}
          placeholder="如：招商银行"
        />
      </label>
      {isCard && (
        <label className="flex flex-col text-sm">
          卡号后四位
          <input
            className={`${inputClass} w-24`}
            inputMode="numeric"
            value={cardLast4}
            onChange={(e) => setCardLast4(e.target.value)}
          />
        </label>
      )}
      <Button type="submit" variant="primary">
        {submitLabel}
      </Button>
      {onCancel && <Button onClick={onCancel}>取消</Button>}
      {fieldError && (
        <p role="alert" className="w-full text-sm text-red-600">
          {fieldError}
        </p>
      )}
    </form>
  );
}
