/**
 * 自定义模板向导（docs/import.md §9.6）
 *
 *   ① 读取文件前 200 行 → ② 点选表头行 → ③ 给各列选字段、金额方式、收支取值
 *   → ④ 来源、时间格式、识别关键词 → ⑤ 试解析 → ⑥ 命名保存
 *
 * 只有"当前配置"试解析通过（找到表头、没有错误行、自校验通过）后才能保存：
 * 解析有错误的模板在正式导入时会被自校验拒绝，保存了也用不上。
 */
import {
  DIRECTION_LABELS,
  type Direction,
  type InspectResponse,
  TEMPLATE_FIELD_LABELS,
  TEMPLATE_FIELDS,
  TEMPLATE_SOURCE_KIND_LABELS,
  type TemplateField,
  type TemplateSourceKind,
  type TemplateTestResponse,
  TIME_FORMATS,
  type TimeFormat,
  type UserTemplate,
  userTemplateSpecSchema,
} from '@bookkeepx/contracts';
import { formatCents } from '@bookkeepx/core';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../shared/api/client.ts';
import { Badge, Button, ErrorBanner, inputClass } from '../../shared/ui/index.tsx';
import { useTemplateMutations } from './api.ts';
import {
  type AmountMode,
  columnsOf,
  columnValues,
  distinctValues,
  fromSpec,
  guessDirection,
  headerOf,
  initialState,
  toSpec,
  type WizardState,
} from './wizard.ts';

/** 样本表格显示的行数（点选表头用） */
const SHOW_ROWS = 40;

const AMOUNT_MODE_LABELS: Record<AmountMode, string> = {
  signed: '一列金额，负数为支出',
  directionColumn: '一列金额 + 一列收/支',
  split: '收入、支出分两列',
};

export interface TemplateWizardProps {
  file: File;
  /** 修改已有模板时传入 */
  initial?: UserTemplate | undefined;
  onSaved: (template: UserTemplate) => void;
  onCancel: () => void;
}

export function TemplateWizard({ file, initial, onSaved, onCancel }: TemplateWizardProps) {
  const m = useTemplateMutations();
  const [sample, setSample] = useState<InspectResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { mutateAsync: inspect } = m.inspect;

  useEffect(() => {
    let cancelled = false;
    inspect(file).then(
      (r) => !cancelled && setSample(r),
      (e: unknown) => !cancelled && setError(e instanceof ApiError ? e.message : '读取文件失败'),
    );
    return () => {
      cancelled = true;
    };
  }, [file, inspect]);

  return (
    <section aria-label="自定义模板" className="space-y-4 rounded-lg bg-white p-4 ring-1 ring-gray-200">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">
          {initial ? `修改模板「${initial.name}」` : '创建自定义模板'}
          <span className="ml-2 text-sm font-normal text-gray-500">{file.name}</span>
        </h2>
        <Button variant="ghost" onClick={onCancel}>
          取消
        </Button>
      </div>
      <ErrorBanner message={error} />
      {!sample && !error && <p className="text-sm text-gray-500">正在读取文件…</p>}
      {sample && sample.fileType !== 'pdf' && (
        <WizardBody file={file} sample={sample} fileType={sample.fileType} initial={initial} onSaved={onSaved} />
      )}
    </section>
  );
}

function WizardBody({
  file,
  sample,
  fileType,
  initial,
  onSaved,
}: {
  file: File;
  sample: InspectResponse;
  fileType: 'csv' | 'xlsx';
  initial: UserTemplate | undefined;
  onSaved: (t: UserTemplate) => void;
}) {
  const m = useTemplateMutations();
  const rows = sample.rows;
  const [state, setState] = useState<WizardState>(() =>
    initial ? fromSpec(initial.spec, rows) : initialState(rows, sample.suggestedHeaderRow, file.name),
  );
  const [name, setName] = useState(initial?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  /** 最近一次试解析的结果，以及当时的配置（配置改动后需要重新试解析） */
  const [tested, setTested] = useState<{ specJson: string; result: TemplateTestResponse } | null>(null);

  const header = headerOf(rows, state.headerRow);
  const cols = columnsOf(state.mapping);
  const spec = useMemo(() => toSpec(state, rows, fileType), [state, rows, fileType]);
  const specJson = JSON.stringify(spec);
  const validation = userTemplateSpecSchema.safeParse(spec);
  const specError =
    state.headerRow === null ? '请先点选表头所在的行' : validation.success ? null : validation.error.issues[0]!.message;
  const testIsCurrent = tested?.specJson === specJson;
  const passed =
    testIsCurrent && tested.result.headerFound && tested.result.errorCount === 0 && tested.result.issues.length === 0;

  const update = (patch: Partial<WizardState>) => setState((s) => ({ ...s, ...patch }));

  /** 改了某列的字段后：收支取值、跳过的状态随之按新列的样本值刷新（保留已经选好的） */
  const setField = (column: string, field: TemplateField | '') => {
    setState((s) => {
      const mapping = { ...s.mapping };
      // 一个字段只能对应一列：把之前对应该字段的列清空
      if (field) for (const k of Object.keys(mapping)) if (mapping[k] === field) mapping[k] = '';
      mapping[column] = field;
      const c = columnsOf(mapping);
      const dirValues = c.direction ? distinctValues(columnValues(rows, s.headerRow, c.direction)) : [];
      return {
        ...s,
        mapping,
        directionMap: Object.fromEntries(dirValues.map((v) => [v, s.directionMap[v] ?? guessDirection(v)])),
      };
    });
  };

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '操作失败，请重试');
    }
  };

  const test = () =>
    run(async () => {
      const result = await m.test.mutateAsync({ file, spec, templateId: initial?.id });
      setTested({ specJson, result });
    });

  const save = () =>
    run(async () => {
      const saved = initial
        ? await m.update.mutateAsync({ id: initial.id, patch: { name, spec } })
        : await m.create.mutateAsync({ name, spec });
      onSaved(saved);
    });

  const statusValues = cols.status ? distinctValues(columnValues(rows, state.headerRow, cols.status)) : [];

  return (
    <div className="space-y-5 text-sm">
      {/* ② 表头行 */}
      <Step n={1} title="点选表头所在的行">
        <div className="max-h-72 overflow-auto rounded ring-1 ring-gray-200">
          <table className="w-full text-xs">
            <tbody>
              {rows.slice(0, SHOW_ROWS).map((r, i) => (
                <tr
                  // biome-ignore lint/suspicious/noArrayIndexKey: 样本行没有 id，行号就是身份
                  key={i}
                  aria-selected={state.headerRow === i}
                  onClick={() => setState(initialState(rows, i, file.name))}
                  className={`cursor-pointer border-b border-gray-100 ${state.headerRow === i ? 'bg-blue-100 font-medium' : state.headerRow !== null && i < state.headerRow ? 'text-gray-400' : 'hover:bg-gray-50'}`}
                  data-testid="sample-row"
                >
                  <td className="w-8 px-1 text-right text-gray-400">{i + 1}</td>
                  {r.map((c, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 同上
                    <td key={j} className="max-w-40 truncate px-1 py-0.5">
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-xs text-gray-500">
          共 {sample.totalRows} 行，显示前 {Math.min(SHOW_ROWS, rows.length)} 行。表头之前的说明文字会被忽略。
        </p>
      </Step>

      {state.headerRow !== null && (
        <>
          {/* ③ 列映射 */}
          <Step n={2} title="每一列是什么">
            <div className="grid gap-2 sm:grid-cols-2">
              {header.map((h) => (
                <label key={h} className="flex items-center gap-2">
                  <span className="w-28 truncate" title={h}>
                    {h}
                  </span>
                  <select
                    aria-label={`列「${h}」`}
                    className={`${inputClass} flex-1`}
                    value={state.mapping[h] ?? ''}
                    onChange={(e) => setField(h, e.target.value as TemplateField | '')}
                  >
                    <option value="">不使用</option>
                    {TEMPLATE_FIELDS.map((f) => (
                      <option key={f} value={f}>
                        {TEMPLATE_FIELD_LABELS[f]}
                      </option>
                    ))}
                  </select>
                  <span
                    className="w-24 truncate text-xs text-gray-400"
                    title={columnValues(rows, state.headerRow, h)[0]}
                  >
                    {columnValues(rows, state.headerRow, h)[0]}
                  </span>
                </label>
              ))}
            </div>
          </Step>

          <Step n={3} title="金额与收支">
            <div className="flex flex-wrap gap-3">
              {(Object.keys(AMOUNT_MODE_LABELS) as AmountMode[]).map((mode) => (
                <label key={mode} className="flex items-center gap-1">
                  <input
                    type="radio"
                    name="amountMode"
                    checked={state.amountMode === mode}
                    onChange={() => update({ amountMode: mode })}
                  />
                  {AMOUNT_MODE_LABELS[mode]}
                </label>
              ))}
            </div>
            {state.amountMode === 'directionColumn' && (
              <div className="mt-2 space-y-1">
                {Object.keys(state.directionMap).length === 0 && (
                  <p className="text-amber-700">请在上面把某一列设为"收/支"</p>
                )}
                {Object.entries(state.directionMap).map(([v, d]) => (
                  <label key={v} className="flex items-center gap-2">
                    <span className="w-28">「{v}」表示</span>
                    <select
                      aria-label={`取值「${v}」`}
                      className={inputClass}
                      value={d}
                      onChange={(e) =>
                        update({ directionMap: { ...state.directionMap, [v]: e.target.value as Direction | '' } })
                      }
                    >
                      <option value="">请选择</option>
                      {(Object.keys(DIRECTION_LABELS) as Direction[]).map((x) => (
                        <option key={x} value={x}>
                          {DIRECTION_LABELS[x]}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}
            {statusValues.length > 0 && (
              <fieldset className="mt-2">
                <legend className="mb-1 text-gray-600">跳过这些状态的记录（如交易关闭、失败）：</legend>
                <div className="flex flex-wrap gap-3">
                  {statusValues.map((v) => (
                    <label key={v} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={state.skipStatuses.includes(v)}
                        onChange={(e) =>
                          update({
                            skipStatuses: e.target.checked
                              ? [...state.skipStatuses, v]
                              : state.skipStatuses.filter((x) => x !== v),
                          })
                        }
                      />
                      {v}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </Step>

          <Step n={4} title="来源与识别">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex items-center gap-2">
                <span className="w-24">账单来源</span>
                <select
                  aria-label="账单来源"
                  className={`${inputClass} flex-1`}
                  value={state.sourceKind}
                  onChange={(e) => update({ sourceKind: e.target.value as TemplateSourceKind })}
                >
                  {(Object.keys(TEMPLATE_SOURCE_KIND_LABELS) as TemplateSourceKind[]).map((k) => (
                    <option key={k} value={k}>
                      {TEMPLATE_SOURCE_KIND_LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2">
                <span className="w-24">时间格式</span>
                <select
                  aria-label="时间格式"
                  className={`${inputClass} flex-1`}
                  value={state.timeFormat}
                  onChange={(e) => update({ timeFormat: e.target.value as TimeFormat | '' })}
                >
                  <option value="">请选择</option>
                  {TIME_FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 sm:col-span-2">
                <span className="w-24">识别关键词</span>
                <input
                  aria-label="识别关键词"
                  className={`${inputClass} flex-1`}
                  placeholder="表头之前说明文字里一定会出现的词，多个用逗号分隔（可不填）"
                  value={state.titleKeywords}
                  onChange={(e) => update({ titleKeywords: e.target.value })}
                />
              </label>
              {cols.balance && (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={state.balanceCheck}
                    onChange={(e) => update({ balanceCheck: e.target.checked })}
                  />
                  用余额核对是否漏记（每笔的余额应等于上一笔余额加减本笔金额）
                </label>
              )}
            </div>
            {(state.sourceKind === 'wechat' || state.sourceKind === 'alipay') && (
              <p className="mt-1 text-xs text-gray-500">
                选择{TEMPLATE_SOURCE_KIND_LABELS[state.sourceKind]}
                后，与内置模板导入的同一笔交易会被识别为重复，退款也按{TEMPLATE_SOURCE_KIND_LABELS[state.sourceKind]}
                的规则关联。
              </p>
            )}
          </Step>

          <Step n={5} title="试解析">
            {specError && <p className="mb-2 text-amber-700">{specError}</p>}
            <Button disabled={!!specError || m.test.isPending} onClick={test}>
              {m.test.isPending ? '正在解析…' : '试解析'}
            </Button>
            {tested && !testIsCurrent && <span className="ml-2 text-amber-700">配置已修改，请重新试解析</span>}
            {tested && testIsCurrent && <TestResult result={tested.result} />}
          </Step>

          <Step n={6} title="保存">
            <ErrorBanner message={error} onClose={() => setError(null)} />
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label="模板名称"
                className={inputClass}
                placeholder="如：某银行活期明细"
                value={name}
                maxLength={50}
                onChange={(e) => setName(e.target.value)}
              />
              <Button
                variant="primary"
                disabled={!passed || !name.trim() || m.create.isPending || m.update.isPending}
                onClick={save}
              >
                保存并继续导入
              </Button>
              {!passed && <span className="text-xs text-gray-500">试解析通过后才能保存</span>}
            </div>
          </Step>
        </>
      )}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 font-medium">
        <span className="mr-1 text-blue-600">{n}.</span>
        {title}
      </h3>
      {children}
    </div>
  );
}

function TestResult({ result }: { result: TemplateTestResponse }) {
  if (!result.headerFound) {
    return <p className="mt-2 text-red-600">在文件中找不到这一行表头，请检查表头行的选择。</p>;
  }
  return (
    <div className="mt-2 space-y-2" data-testid="test-result">
      <div className="flex flex-wrap gap-2">
        <Badge tone="blue">解析 {result.total} 条</Badge>
        {result.errorCount > 0 && <Badge tone="amber">{result.errorCount} 行解析失败</Badge>}
        {result.issues.length > 0 && <Badge tone="amber">自校验未通过</Badge>}
        {result.detect.autoSelected ? (
          <Badge tone="blue">保存后，这种文件上传时会被自动识别</Badge>
        ) : (
          <Badge tone="amber">上传时不会被自动识别：{result.detect.reason}</Badge>
        )}
      </div>
      {result.errors.length > 0 && (
        <ul className="list-disc pl-5 text-red-700" aria-label="解析失败的行">
          {result.errors.map((e) => (
            <li key={`${e.row}:${e.message}`}>
              {e.row}：{e.message}
            </li>
          ))}
        </ul>
      )}
      {result.issues.length > 0 && (
        <ul className="list-disc pl-5 text-red-700" aria-label="自校验问题">
          {result.issues.map((i) => (
            <li key={`${i.check}:${i.detail}`}>{i.detail}</li>
          ))}
        </ul>
      )}
      <table className="w-full text-xs">
        <thead className="text-left text-gray-500">
          <tr>
            <th className="py-1">行</th>
            <th>时间</th>
            <th>对方 / 说明</th>
            <th className="text-right">金额</th>
          </tr>
        </thead>
        <tbody>
          {result.records.map((r) => (
            <tr key={r.rowLabel} className="border-t border-gray-100">
              <td className="py-0.5 text-gray-400">{r.rowLabel}</td>
              <td>{r.occurredAt.slice(0, 16).replace('T', ' ')}</td>
              <td className="max-w-60 truncate">
                {[r.counterparty, r.description].filter(Boolean).join(' · ')}
                {r.skipReason && <span className="ml-1 text-gray-400">（跳过：{r.skipReason}）</span>}
              </td>
              <td className="text-right tabular-nums">
                {r.direction === 'income' ? '+' : r.direction === 'expense' ? '-' : ''}
                {formatCents(r.amountCents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
