/**
 * 分类管理（docs/api.md "分类"）
 *
 * 按支出 / 收入 / 中性分页签展示两级分类树；支持新增、改名、隐藏 / 恢复、删除。
 * 删除按钮按服务端规则预先置灰并说明原因（预置分类、有子分类、已被使用），服务端仍会再校验。
 */
import type { Category, CategoryGroupValue } from '@bookkeepx/contracts';
import { useState } from 'react';
import { ApiError } from '../../shared/api/client.ts';
import { Badge, Button, ErrorBanner, inputClass, PageTitle } from '../../shared/ui/index.tsx';
import { useLedgerId } from '../ledger/useLedgerId.ts';
import { useCategories, useCategoryMutations } from './api.ts';

const GROUPS: { value: CategoryGroupValue; label: string; hint: string }[] = [
  { value: 'expense', label: '支出', hint: '' },
  { value: 'income', label: '收入', hint: '' },
  { value: 'neutral', label: '中性', hint: '中性：自己账户之间的资金流动（理财、充值、转给自己），不计入收支统计' },
];

/** 不能删除的原因；可以删除时返回 null */
export function deleteBlockReason(c: Category, hasChildren: boolean): string | null {
  if (c.presetKey) return '预置分类不能删除，可以隐藏';
  if (hasChildren) return '请先删除它的子分类（目前不支持移动分类）';
  if (c.transactionCount > 0) return `已有 ${c.transactionCount} 笔流水使用，不能删除，可以隐藏`;
  return null;
}

export function CategoriesPage() {
  const ledgerId = useLedgerId();
  if (!ledgerId) return null;
  return <CategoriesEditor ledgerId={ledgerId} />;
}

function CategoriesEditor({ ledgerId }: { ledgerId: string }) {
  const [group, setGroup] = useState<CategoryGroupValue>('expense');
  const [error, setError] = useState<string | null>(null);
  const { data, isPending, error: loadError } = useCategories(ledgerId);
  const m = useCategoryMutations(ledgerId);

  /** 执行一个修改操作；失败时在页面顶部显示服务端给出的原因。返回是否成功 */
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
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
  if (loadError) return <ErrorBanner message={`加载分类失败：${loadError.message}`} />;

  const inGroup = data.filter((c) => c.group === group);
  const tops = inGroup.filter((c) => !c.parentId).sort((a, b) => a.sort - b.sort);
  const childrenOf = (id: string) => inGroup.filter((c) => c.parentId === id).sort((a, b) => a.sort - b.sort);
  const hint = GROUPS.find((g) => g.value === group)!.hint;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <PageTitle description="记账和导入时按这里的分类归类。预置分类可以改名、隐藏，但不能删除。">分类管理</PageTitle>
      <div role="tablist" className="mb-4 flex gap-2">
        {GROUPS.map((g) => (
          <button
            key={g.value}
            type="button"
            role="tab"
            aria-selected={group === g.value}
            onClick={() => setGroup(g.value)}
            className={`rounded-full px-4 py-1 text-sm ${group === g.value ? 'bg-blue-600 text-white' : 'bg-white ring-1 ring-gray-300'}`}
          >
            {g.label}
          </button>
        ))}
      </div>
      {hint && <p className="mb-4 text-sm text-gray-500">{hint}</p>}
      <ErrorBanner message={error} onClose={() => setError(null)} />

      <ul className="divide-y divide-gray-100 rounded-lg bg-white ring-1 ring-gray-200">
        {tops.map((top) => (
          <li key={top.id} className="py-1">
            <CategoryRow
              category={top}
              hasChildren={childrenOf(top.id).length > 0}
              onRename={(name) => run(() => m.update.mutateAsync({ id: top.id, patch: { name } }))}
              onToggleHidden={() => run(() => m.update.mutateAsync({ id: top.id, patch: { hidden: !top.hidden } }))}
              onDelete={() => run(() => m.remove.mutateAsync(top.id))}
            />
            <ul className="ml-6">
              {childrenOf(top.id).map((child) => (
                <li key={child.id}>
                  <CategoryRow
                    category={child}
                    parentHidden={top.hidden}
                    hasChildren={false}
                    onRename={(name) => run(() => m.update.mutateAsync({ id: child.id, patch: { name } }))}
                    onToggleHidden={() =>
                      run(() => m.update.mutateAsync({ id: child.id, patch: { hidden: !child.hidden } }))
                    }
                    onDelete={() => run(() => m.remove.mutateAsync(child.id))}
                  />
                </li>
              ))}
              <li className="py-1">
                <AddCategory
                  placeholder={`在"${top.name}"下添加子分类`}
                  onAdd={(name) => run(() => m.create.mutateAsync({ group, parentId: top.id, name }))}
                />
              </li>
            </ul>
          </li>
        ))}
      </ul>
      <div className="mt-4">
        <AddCategory
          placeholder="添加一级分类"
          onAdd={(name) => run(() => m.create.mutateAsync({ group, parentId: null, name }))}
        />
      </div>
    </main>
  );
}

interface RowProps {
  category: Category;
  hasChildren: boolean;
  /** 父分类已隐藏：子分类在记账时同样不可选 */
  parentHidden?: boolean;
  /** 返回是否成功：失败时保持编辑状态，方便用户修改后重试 */
  onRename: (name: string) => Promise<boolean>;
  onToggleHidden: () => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}

function CategoryRow({ category: c, hasChildren, parentHidden, onRename, onToggleHidden, onDelete }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(c.name);
  const blockReason = deleteBlockReason(c, hasChildren);

  return (
    <div className="flex items-center justify-between gap-2 px-3 py-1.5" data-testid={`category-${c.name}`}>
      {editing ? (
        <form
          className="flex flex-1 gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await onRename(name.trim())) setEditing(false);
          }}
        >
          <input
            aria-label="分类名称"
            className={`${inputClass} flex-1`}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" variant="primary">
            保存
          </Button>
          <Button
            onClick={() => {
              setName(c.name);
              setEditing(false);
            }}
          >
            取消
          </Button>
        </form>
      ) : (
        <>
          <span className={`flex items-center gap-2 ${c.hidden || parentHidden ? 'text-gray-400' : ''}`}>
            {c.name}
            {c.presetKey && <Badge>预置</Badge>}
            {c.hidden && <Badge tone="amber">已隐藏</Badge>}
            {c.transactionCount > 0 && <Badge tone="blue">{c.transactionCount} 笔</Badge>}
          </span>
          <span className="flex gap-1">
            <Button variant="ghost" onClick={() => setEditing(true)}>
              改名
            </Button>
            <Button variant="ghost" onClick={onToggleHidden}>
              {c.hidden ? '恢复' : '隐藏'}
            </Button>
            <Button
              variant="danger"
              disabled={blockReason !== null}
              title={blockReason ?? '删除该分类'}
              onClick={() => {
                if (window.confirm(`确定删除分类"${c.name}"吗？`)) void onDelete();
              }}
            >
              删除
            </Button>
          </span>
        </>
      )}
    </div>
  );
}

function AddCategory({ placeholder, onAdd }: { placeholder: string; onAdd: (name: string) => Promise<boolean> }) {
  const [name, setName] = useState('');
  return (
    <form
      className="flex gap-2 px-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        // 失败时保留输入内容，方便用户修改后重试
        if (await onAdd(name.trim())) setName('');
      }}
    >
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        className={`${inputClass} flex-1`}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Button type="submit" disabled={!name.trim()}>
        添加
      </Button>
    </form>
  );
}
