/**
 * 账单导入页（docs/import.md）
 *
 * 流程：选文件（可选指定账户）→ 上传识别
 *   → 识别不确定时从候选模板中选一个再识别
 *   → 自校验未通过时列出问题，不生成预览
 *   → 预览：改分类、取消勾选 → 确认导入 / 放弃
 *   → 内置模板不认识 / 候选都不对 → 自定义模板向导，保存后用新模板继续导入（import.md §9）
 * 下方是导入历史（继续未完成的预览、放弃、整批撤销）与我的自定义模板。
 */
import type { Account, Category, ImportBatch, UserTemplate, VerifyIssueDto } from '@bookkeepx/contracts';
import { useState } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../../shared/api/client.ts';
import { Button, ErrorBanner, inputClass, PageTitle } from '../../shared/ui/index.tsx';
import { useAccounts } from '../accounts/api.ts';
import { useCategories } from '../categories/api.ts';
import { TemplateList } from '../import-templates/TemplateList.tsx';
import { TemplateWizard } from '../import-templates/TemplateWizard.tsx';
import { useLedger } from '../ledger/api.ts';
import { useLedgerId } from '../ledger/useLedgerId.ts';
import { type UploadInput, useImportBatches, useImportMutations, verifyIssuesOf } from './api.ts';
import { ImportHistory } from './ImportHistory.tsx';
import { PreviewPanel } from './PreviewPanel.tsx';
import { buildOverrides, type RowEdit } from './preview.ts';

export function ImportPage() {
  const ledgerId = useLedgerId();
  if (!ledgerId) return null;
  return <ImportView ledgerId={ledgerId} />;
}

function ImportView({ ledgerId }: { ledgerId: string }) {
  const ledger = useLedger(ledgerId);
  const categories = useCategories(ledgerId);
  const accounts = useAccounts(ledgerId);
  const loadError = ledger.error ?? categories.error ?? accounts.error;
  if (loadError) return <ErrorBanner message={`加载失败：${loadError.message}`} />;
  if (!ledger.data || !categories.data || !accounts.data) return <p className="p-6 text-gray-500">正在加载…</p>;
  return (
    <ImportBody
      ledgerId={ledgerId}
      timezone={ledger.data.timezone}
      canEdit={ledger.data.role !== 'viewer'}
      categories={categories.data}
      accounts={accounts.data}
    />
  );
}

type Stage =
  | { kind: 'idle' }
  | { kind: 'choose'; candidates: { templateId: string; templateName: string; score: number }[] }
  | { kind: 'preview'; batch: ImportBatch }
  /** 内置模板和已有的自定义模板都不认识这个文件 */
  | { kind: 'unsupported' }
  /** 自定义模板向导；initial 为要修改的模板 */
  | { kind: 'wizard'; initial?: UserTemplate };

interface BodyProps {
  ledgerId: string;
  timezone: string;
  canEdit: boolean;
  categories: Category[];
  accounts: Account[];
}

function ImportBody({ ledgerId, timezone, canEdit, categories, accounts }: BodyProps) {
  const history = useImportBatches(ledgerId);
  const m = useImportMutations(ledgerId);
  const [file, setFile] = useState<File | null>(null);
  /** 改变 key 让文件选择框清空 */
  const [fileKey, setFileKey] = useState(0);
  const [accountId, setAccountId] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [edits, setEdits] = useState<Map<number, RowEdit>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<VerifyIssueDto[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pending =
    m.upload.isPending || m.commit.isPending || m.discard.isPending || m.revert.isPending || m.open.isPending;

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    setIssues(null);
    setNotice(null);
    try {
      await action();
      return true;
    } catch (e) {
      const verify = verifyIssuesOf(e);
      if (verify) setIssues(verify);
      setError(e instanceof ApiError ? e.message : '操作失败，请重试');
      return false;
    }
  };

  const showPreview = (batch: ImportBatch) => {
    setStage({ kind: 'preview', batch });
    setEdits(new Map());
  };

  const upload = (extra: Omit<UploadInput, 'file'> = {}) =>
    run(async () => {
      if (!file) throw new ApiError('请先选择账单文件', 0);
      try {
        const res = await m.upload.mutateAsync({ file, accountId: accountId || undefined, ...extra });
        if (res.status === 'preview') showPreview(res.batch);
        else setStage({ kind: 'choose', candidates: res.candidates });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'IMPORT_UNSUPPORTED') setStage({ kind: 'unsupported' });
        throw e;
      }
    });

  /** 模板保存后：用它继续导入同一个文件 */
  const onTemplateSaved = async (t: UserTemplate) => {
    setStage({ kind: 'idle' });
    await upload({ templateId: t.id });
  };

  /** 预览中补选账户：用同一个文件带上账户重新识别，成功后放弃旧预览 */
  const chooseAccount = (batch: ImportBatch) => async (id: string) => {
    setAccountId(id);
    const ok = await run(async () => {
      if (!file) throw new ApiError('请重新选择账单文件', 0);
      const res = await m.upload.mutateAsync({ file, accountId: id, templateId: batch.templateId });
      if (res.status !== 'preview') throw new ApiError('重新识别失败，请重新上传', 0);
      showPreview(res.batch);
    });
    if (ok) await m.discard.mutateAsync(batch.id).catch(() => undefined);
  };

  const reset = () => {
    setStage({ kind: 'idle' });
    setEdits(new Map());
    setFile(null);
    setFileKey((k) => k + 1);
  };

  const commit = async (batch: ImportBatch) => {
    let done: ImportBatch | undefined;
    const ok = await run(async () => {
      done = await m.commit.mutateAsync({
        batchId: batch.id,
        body: { overrides: buildOverrides(batch.rows ?? [], edits) },
      });
    });
    if (ok && done) {
      reset();
      setNotice(`已导入 ${done.importedRows} 笔流水`);
    }
  };

  const discard = async (id: string) => {
    if (await run(() => m.discard.mutateAsync(id))) {
      if (stage.kind === 'preview' && stage.batch.id === id) reset();
    }
  };

  const open = (id: string) =>
    run(async () => {
      const batch = await m.open.mutateAsync(id);
      // 从历史中继续的预览，浏览器里没有原文件，不能补选账户重新识别
      setFile(null);
      setFileKey((k) => k + 1);
      showPreview(batch);
    });

  const revert = async (id: string) => {
    let done: ImportBatch | undefined;
    const ok = await run(async () => {
      done = await m.revert.mutateAsync(id);
    });
    if (ok && done) setNotice(`已撤销导入，删除了 ${done.importedRows} 笔流水`);
  };

  const activeBatch = stage.kind === 'preview' ? stage.batch : null;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <PageTitle description="支持微信（xlsx）、支付宝（csv）、招商银行（pdf）导出的账单，文件不超过 10 MB">
        导入账单
      </PageTitle>

      <ErrorBanner message={error} onClose={() => setError(null)} />
      {issues && issues.length > 0 && (
        <ul
          className="-mt-2 mb-4 list-disc rounded-lg bg-red-50 py-2 pr-3 pl-8 text-sm text-red-700"
          aria-label="校验问题"
        >
          {issues.map((i) => (
            <li key={`${i.check}:${i.detail}`}>{i.detail}</li>
          ))}
        </ul>
      )}
      {notice && (
        <div
          role="status"
          className="mb-4 flex items-center justify-between rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800"
        >
          {notice}
          <Link to="/transactions" className="font-medium text-blue-600">
            查看流水
          </Link>
        </div>
      )}

      {stage.kind === 'wizard' && file && (
        <div className="mb-6">
          <TemplateWizard
            file={file}
            initial={stage.initial}
            onSaved={onTemplateSaved}
            onCancel={() => setStage({ kind: 'idle' })}
          />
        </div>
      )}

      {canEdit && stage.kind !== 'preview' && stage.kind !== 'wizard' && (
        <section aria-label="上传账单" className="mb-6 space-y-3 rounded-lg bg-white p-4 ring-1 ring-gray-200">
          <div className="flex flex-wrap items-center gap-2">
            <input
              key={fileKey}
              type="file"
              aria-label="账单文件"
              accept=".csv,.xlsx,.pdf"
              className="text-sm"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setStage({ kind: 'idle' });
              }}
            />
            <select
              aria-label="资金账户"
              className={inputClass}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">自动对应账户</option>
              {accounts
                .filter((a) => !a.archived)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
            <Button variant="primary" disabled={!file || pending} onClick={() => upload()}>
              {m.upload.isPending ? '正在识别…' : '上传并识别'}
            </Button>
          </div>

          {stage.kind === 'choose' && (
            <fieldset aria-label="选择账单格式" className="rounded bg-amber-50 p-3 text-sm">
              <legend className="sr-only">选择账单格式</legend>
              <p className="mb-2 text-amber-800">无法确定这份账单的格式，请选择：</p>
              <div className="flex flex-wrap gap-2">
                {stage.candidates.map((c) => (
                  <Button key={c.templateId} disabled={pending} onClick={() => upload({ templateId: c.templateId })}>
                    {c.templateName}（匹配度 {Math.round(c.score * 100)}%）
                  </Button>
                ))}
                <Button variant="ghost" disabled={pending} onClick={() => setStage({ kind: 'wizard' })}>
                  都不是，创建新模板
                </Button>
              </div>
            </fieldset>
          )}

          {stage.kind === 'unsupported' && file && (
            <div className="flex flex-wrap items-center gap-2 rounded bg-amber-50 p-3 text-sm text-amber-800">
              可以为这种账单创建自定义模板：指明每一列的含义，以后上传同类文件会自动识别。
              <Button variant="primary" onClick={() => setStage({ kind: 'wizard' })}>
                创建自定义模板
              </Button>
            </div>
          )}
        </section>
      )}

      {activeBatch && (
        <div className="mb-8">
          <PreviewPanel
            batch={activeBatch}
            timezone={timezone}
            categories={categories}
            accounts={accounts}
            edits={edits}
            onEdit={(index, patch) => setEdits((prev) => new Map(prev).set(index, { ...prev.get(index), ...patch }))}
            onCommit={() => commit(activeBatch)}
            onDiscard={() => discard(activeBatch.id)}
            onChooseAccount={file ? chooseAccount(activeBatch) : undefined}
            pending={pending}
          />
        </div>
      )}

      <h2 className="mb-2 font-medium">导入历史</h2>
      {history.error && <ErrorBanner message={`加载导入历史失败：${history.error.message}`} />}
      {history.data && (
        <ImportHistory
          batches={history.data}
          timezone={timezone}
          canEdit={canEdit}
          activeId={activeBatch?.id ?? null}
          pending={pending}
          onOpen={open}
          onDiscard={discard}
          onRevert={revert}
        />
      )}

      <h2 className="mt-8 mb-2 font-medium">我的自定义模板</h2>
      <TemplateList
        timezone={timezone}
        onEdit={(t, sample) => {
          setFile(sample);
          setError(null);
          setStage({ kind: 'wizard', initial: t });
        }}
      />
    </main>
  );
}
