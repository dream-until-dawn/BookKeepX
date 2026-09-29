/**
 * 我的自定义模板：改名、用新样本修改配置、删除（删除需二次确认；已导入的流水不受影响）
 */
import { TEMPLATE_SOURCE_KIND_LABELS, type UserTemplate } from '@bookkeepx/contracts';
import { toZonedDisplay } from '@bookkeepx/core';
import { useState } from 'react';
import { ApiError } from '../../shared/api/client.ts';
import { Badge, Button, ErrorBanner, inputClass } from '../../shared/ui/index.tsx';
import { useTemplateMutations, useUserTemplates } from './api.ts';

export interface TemplateListProps {
  timezone: string;
  /** 选好样本文件后打开向导修改该模板 */
  onEdit: (template: UserTemplate, sample: File) => void;
}

export function TemplateList({ timezone, onEdit }: TemplateListProps) {
  const list = useUserTemplates();
  const m = useTemplateMutations();
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  if (list.error) return <ErrorBanner message={`加载模板失败：${list.error.message}`} />;
  if (!list.data) return null;
  if (list.data.length === 0) {
    return (
      <p className="rounded-lg bg-white p-4 text-center text-sm text-gray-500 ring-1 ring-gray-200">
        还没有自定义模板。上传内置模板不认识的账单时，可以为它创建一个。
      </p>
    );
  }
  return (
    <>
      <ErrorBanner message={error} onClose={() => setError(null)} />
      <ul className="divide-y divide-gray-100 rounded-lg bg-white ring-1 ring-gray-200">
        {list.data.map((t) => (
          <li
            key={t.id}
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
            data-testid="user-template"
          >
            {renaming?.id === t.id ? (
              <form
                className="flex gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await run(() => m.update.mutateAsync({ id: t.id, patch: { name: renaming.name } })))
                    setRenaming(null);
                }}
              >
                <input
                  aria-label="新名称"
                  className={inputClass}
                  value={renaming.name}
                  maxLength={50}
                  onChange={(e) => setRenaming({ id: t.id, name: e.target.value })}
                />
                <Button type="submit" variant="primary" disabled={!renaming.name.trim()}>
                  保存
                </Button>
                <Button variant="ghost" onClick={() => setRenaming(null)}>
                  取消
                </Button>
              </form>
            ) : (
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t.name}</span>
                  <Badge>{t.fileType}</Badge>
                  <Badge tone="blue">{TEMPLATE_SOURCE_KIND_LABELS[t.spec.sourceKind]}</Badge>
                  <span className="text-xs text-gray-400">第 {t.version} 版</span>
                </div>
                <div className="text-xs text-gray-500">
                  {t.lastUsedAt ? `最近使用：${toZonedDisplay(t.lastUsedAt, timezone).date}` : '还没有用过'}
                </div>
              </div>
            )}
            {renaming?.id !== t.id && (
              <div className="flex items-center gap-2">
                {confirming === t.id ? (
                  <>
                    <span className="text-red-600">删除后不能恢复（已导入的流水不受影响）</span>
                    <Button
                      variant="danger"
                      onClick={async () => {
                        if (await run(() => m.remove.mutateAsync(t.id))) setConfirming(null);
                      }}
                    >
                      确认删除
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirming(null)}>
                      取消
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="ghost" onClick={() => setRenaming({ id: t.id, name: t.name })}>
                      改名
                    </Button>
                    {/* 修改配置需要一份样本文件：用 label 包住隐藏的文件选择框 */}
                    <label className="cursor-pointer rounded-md px-2.5 py-1 text-gray-600 hover:bg-gray-100">
                      用样本修改
                      <input
                        type="file"
                        aria-label={`选择样本文件修改「${t.name}」`}
                        accept=".csv,.xlsx"
                        className="sr-only"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) onEdit(t, f);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    <Button variant="danger" onClick={() => setConfirming(t.id)}>
                      删除
                    </Button>
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
