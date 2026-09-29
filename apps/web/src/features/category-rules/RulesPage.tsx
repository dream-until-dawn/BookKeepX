/** 分类规则管理：编辑、启停、冲突试跑，以及有快照校验的历史应用。 */
import type { CategoryRule, HistoryPreview } from '@bookkeepx/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiSend } from '../../shared/api/client.ts';
import { applyHistory, previewHistory, ruleBase, useRules } from '../../shared/category-rules/api.ts';
import { newRule, RuleEditor } from '../../shared/category-rules/RuleEditor.tsx';
import { RuleSamples } from '../../shared/category-rules/RuleSamples.tsx';
import { Button, ErrorBanner, PageTitle } from '../../shared/ui/index.tsx';
import { useCategories } from '../categories/api.ts';
import { useLedger } from '../ledger/api.ts';
import { useLedgerId } from '../ledger/useLedgerId.ts';
/** 当前账本的规则管理入口。 */
export function RulesPage() {
  const ledgerId = useLedgerId();
  return ledgerId ? <RulesBody ledgerId={ledgerId} /> : null;
}
function RulesBody({ ledgerId }: { ledgerId: string }) {
  const rules = useRules(ledgerId);
  const cats = useCategories(ledgerId);
  const ledger = useLedger(ledgerId);
  const cache = useQueryClient();
  const [editing, setEditing] = useState<CategoryRule | 'new' | null>(null);
  const [history, setHistory] = useState<HistoryPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setPending(true);
    setError(null);
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
      setHistory(null);
    } finally {
      setPending(false);
    }
  };
  const done = () => {
    setEditing(null);
    setHistory(null);
    setNotice('规则已保存，将用于后续导入。');
  };
  const canEdit = ledger.data?.role !== 'viewer';
  const loadError = rules.error ?? cats.error ?? ledger.error;
  if (loadError) return <ErrorBanner message={loadError.message} />;
  if (!rules.data || !cats.data || !ledger.data) return <p>正在加载…</p>;
  return (
    <main className="mx-auto max-w-4xl space-y-4 px-4 py-8">
      <PageTitle description="按优先级自动归类；手动分类始终受保护。">分类规则</PageTitle>
      <ErrorBanner message={error} />
      {notice && <p role="status">{notice}</p>}
      {canEdit && (
        <div className="flex gap-2">
          <Button
            disabled={pending}
            onClick={() => {
              setEditing('new');
              setHistory(null);
            }}
          >
            新建规则
          </Button>
          <Button
            disabled={pending || editing !== null}
            onClick={() => run(async () => setHistory(await previewHistory(ledgerId)))}
          >
            预览应用到历史
          </Button>
        </div>
      )}
      {editing && (
        <RuleEditor
          key={editing === 'new' ? 'new' : editing.id}
          ledgerId={ledgerId}
          categories={cats.data}
          initial={
            editing === 'new'
              ? newRule()
              : {
                  name: editing.name,
                  enabled: editing.enabled,
                  priority: editing.priority,
                  match: editing.match,
                  conditions: editing.conditions,
                  action: editing.action,
                  origin: editing.origin,
                }
          }
          {...(editing === 'new' ? {} : { ruleId: editing.id })}
          onDone={done}
          onCancel={() => setEditing(null)}
        />
      )}
      {rules.data.length === 0 && <p>还没有用户规则，系统分类仍会正常运行。</p>}
      <ul className="space-y-2">
        {rules.data.map((r) => (
          <li key={r.id} className="rounded-lg bg-white p-3 ring-1 ring-gray-200">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <strong>{r.name}</strong> · {r.enabled ? '启用' : '停用'} · 优先级 {r.priority}
                <p className="text-sm text-gray-500">
                  目标：{cats.data.find((c) => c.id === r.action.categoryId)?.name ?? '分类已删除'} · 命中 {r.hitCount}{' '}
                  次 · {r.origin === 'learned' ? '学习生成' : '手动创建'}
                </p>
              </div>
              {canEdit && (
                <div className="flex gap-2">
                  <Button
                    disabled={pending}
                    onClick={() => {
                      setEditing(r);
                      setHistory(null);
                    }}
                  >
                    编辑 {r.name}
                  </Button>
                  <Button disabled={pending} onClick={() => setDeleting(r.id)}>
                    删除 {r.name}
                  </Button>
                </div>
              )}
            </div>
            {deleting === r.id && (
              <div className="mt-2">
                <p>删除后保留已有分类，后续导入不再使用此规则。</p>
                <Button
                  variant="danger"
                  disabled={pending}
                  onClick={() =>
                    run(async () => {
                      await apiSend('DELETE', `${ruleBase(ledgerId)}/${r.id}`, undefined, null);
                      setDeleting(null);
                      setHistory(null);
                      await cache.invalidateQueries({ queryKey: ['ledger', ledgerId] });
                    })
                  }
                >
                  确认删除规则
                </Button>
                <Button onClick={() => setDeleting(null)}>取消删除</Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {history && (
        <section aria-label="历史应用预览" className="space-y-3 rounded-lg bg-white p-4 ring-1 ring-gray-200">
          <p>
            扫描 {history.scanned} 笔，将修改 {history.changed} 笔，保护 {history.protectedCount}{' '}
            笔手动分类或退款关联流水。最多展示 100 笔变化。
          </p>
          <RuleSamples samples={history.samples} categories={cats.data} />
          <Button
            variant="primary"
            disabled={pending || history.changed === 0}
            onClick={() =>
              run(async () => {
                const result = await applyHistory(ledgerId, history.digest);
                setHistory(null);
                setNotice(`已更新 ${result.changed} 笔流水`);
                await cache.invalidateQueries({ queryKey: ['ledger', ledgerId] });
              })
            }
          >
            确认应用 {history.changed} 笔
          </Button>
          <Button disabled={pending} onClick={() => setHistory(null)}>
            取消应用
          </Button>
        </section>
      )}
    </main>
  );
}
