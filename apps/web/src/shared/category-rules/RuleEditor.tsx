/** 可复用的规则编辑器：修改任何字段会使已试跑结果失效。 */
import { type Category, type RuleDraft, type RulePreview, ruleDraftSchema } from '@bookkeepx/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, ErrorBanner, inputClass } from '../ui/index.tsx';
import { saveRule, testRule } from './api.ts';
import { RuleSamples } from './RuleSamples.tsx';

type Condition = RuleDraft['conditions'][number];
const FIELDS = {
  counterparty: '对方',
  description: '说明',
  note: '备注',
  anyText: '对方、说明或备注',
  paymentMethod: '支付方式',
  sourceHint: '来源分类',
  source: '来源标识',
  direction: '收支类型',
  amount: '金额（分）',
  isSelf: '是否本人',
};
const OPS = {
  containsAny: '包含任一关键词',
  notContains: '不含这些关键词',
  equals: '等于',
  startsWith: '开头是',
  endsWith: '结尾是',
};
/** 新规则默认严格匹配商户，避免学习建议意外扩大范围。 */
export function newRule(
  categoryId = '',
  counterparty = '',
  direction: 'expense' | 'income' | 'neutral' = 'expense',
): RuleDraft {
  return {
    name: counterparty ? `${counterparty}归类`.slice(0, 80) : '',
    enabled: true,
    priority: 100,
    match: 'all',
    conditions: [
      { field: 'counterparty', op: 'equals', values: [counterparty] },
      { field: 'direction', op: 'equals', values: [direction] },
    ],
    action: { categoryId },
    origin: counterparty ? 'learned' : 'manual',
  };
}
/** 普通编辑与学习确认使用同一个试跑流程。 */
export function RuleEditor({
  ledgerId,
  categories,
  initial,
  ruleId,
  onDone,
  onCancel,
}: {
  ledgerId: string;
  categories: Category[];
  initial: RuleDraft;
  ruleId?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const cache = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const [conditionIds, setConditionIds] = useState(() => initial.conditions.map(() => crypto.randomUUID()));
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [tested, setTested] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const change = (patch: Partial<RuleDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setPreview(null);
    setTested('');
  };
  const condition = (index: number, value: Condition) =>
    change({ conditions: draft.conditions.map((c, i) => (i === index ? value : c)) });
  const run = async (save: boolean) => {
    setError(null);
    const valid = ruleDraftSchema.safeParse(draft);
    if (!valid.success) {
      setError('请检查规则名称、分类、条件值和优先级（0～10000）；关键词不能为空。');
      return;
    }
    setPending(true);
    try {
      if (save) {
        if (tested !== JSON.stringify(draft)) return;
        await saveRule(ledgerId, valid.data, ruleId);
        await cache.invalidateQueries({ queryKey: ['ledger', ledgerId] });
        onDone();
      } else {
        setTested('');
        setPreview(null);
        setPreview(await testRule(ledgerId, valid.data, ruleId));
        setTested(JSON.stringify(draft));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setPending(false);
    }
  };
  return (
    <section aria-label="规则编辑器" className="my-4 space-y-3 rounded-lg bg-white p-4 ring-1 ring-gray-200">
      <ErrorBanner message={error} />
      <fieldset disabled={pending} className="space-y-3">
        <label className="block">
          规则名称
          <input
            aria-label="规则名称"
            className={inputClass}
            value={draft.name}
            onChange={(e) => change({ name: e.target.value })}
          />
        </label>
        <div className="flex flex-wrap gap-3">
          <label>
            优先级
            <input
              aria-label="优先级"
              type="number"
              min="0"
              max="10000"
              className={inputClass}
              value={draft.priority}
              onChange={(e) => change({ priority: Number(e.target.value) })}
            />
          </label>
          <label>
            <input type="checkbox" checked={draft.enabled} onChange={(e) => change({ enabled: e.target.checked })} />
            启用
          </label>
          <label>
            条件组合
            <select
              aria-label="条件组合"
              className={inputClass}
              value={draft.match}
              onChange={(e) => change({ match: e.target.value as 'all' | 'any' })}
            >
              <option value="all">全部满足</option>
              <option value="any">任一满足</option>
            </select>
          </label>
        </div>
        <p className="text-sm text-gray-500">数字越小越优先；关键词每行一个，匹配忽略大小写、全半角与空白。</p>
        {draft.conditions.map((c, index) => (
          <div key={conditionIds[index]} className="flex flex-wrap items-start gap-2">
            <select
              aria-label={`条件字段 ${index + 1}`}
              className={inputClass}
              value={c.field}
              onChange={(e) => {
                const field = e.target.value as Condition['field'];
                condition(
                  index,
                  field === 'amount'
                    ? { field, op: 'gte', value: 0 }
                    : field === 'isSelf'
                      ? { field, op: 'equals', value: true }
                      : field === 'direction'
                        ? { field, op: 'equals', values: ['expense'] }
                        : { field, op: 'containsAny', values: [''] },
                );
              }}
            >
              {Object.entries(FIELDS).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
            {c.field === 'amount' ? (
              <>
                <select
                  aria-label={`条件操作 ${index + 1}`}
                  className={inputClass}
                  value={c.op}
                  onChange={(e) => condition(index, { ...c, op: e.target.value as 'gte' | 'lte' })}
                >
                  <option value="gte">大于等于</option>
                  <option value="lte">小于等于</option>
                </select>
                <input
                  aria-label={`条件值 ${index + 1}`}
                  className={inputClass}
                  type="number"
                  value={c.value}
                  onChange={(e) => condition(index, { ...c, value: Number(e.target.value) })}
                />
              </>
            ) : c.field === 'isSelf' ? (
              <select
                aria-label={`条件值 ${index + 1}`}
                className={inputClass}
                value={String(c.value)}
                onChange={(e) => condition(index, { ...c, value: e.target.value === 'true' })}
              >
                <option value="true">是本人</option>
                <option value="false">不是本人</option>
              </select>
            ) : c.field === 'direction' ? (
              <select
                aria-label={`条件值 ${index + 1}`}
                className={inputClass}
                value={c.values[0]}
                onChange={(e) =>
                  condition(index, { ...c, values: [e.target.value as 'expense' | 'income' | 'neutral'] })
                }
              >
                <option value="expense">支出</option>
                <option value="income">收入</option>
                <option value="neutral">中性</option>
              </select>
            ) : (
              <>
                <select
                  aria-label={`条件操作 ${index + 1}`}
                  className={inputClass}
                  value={c.op}
                  onChange={(e) => condition(index, { ...c, op: e.target.value as typeof c.op })}
                >
                  {Object.entries(OPS).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
                <textarea
                  aria-label={`条件值 ${index + 1}`}
                  className={inputClass}
                  value={c.values.join('\n')}
                  onChange={(e) => condition(index, { ...c, values: e.target.value.split('\n') })}
                />
              </>
            )}
            <Button
              disabled={draft.conditions.length === 1}
              onClick={() => {
                setConditionIds((ids) => ids.filter((_, i) => i !== index));
                change({ conditions: draft.conditions.filter((_, i) => i !== index) });
              }}
            >
              删除条件 {index + 1}
            </Button>
          </div>
        ))}
        <Button
          disabled={draft.conditions.length >= 20}
          onClick={() => {
            setConditionIds((ids) => [...ids, crypto.randomUUID()]);
            change({ conditions: [...draft.conditions, { field: 'anyText', op: 'containsAny', values: [''] }] });
          }}
        >
          添加条件
        </Button>
        <label className="block">
          目标分类
          <select
            aria-label="目标分类"
            className={inputClass}
            value={draft.action.categoryId}
            onChange={(e) => change({ action: { ...draft.action, categoryId: e.target.value } })}
          >
            <option value="">请选择</option>
            {categories
              .filter((c) => !c.hidden && (!draft.action.setDirection || c.group === 'neutral'))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.group === 'expense' ? '支出' : c.group === 'income' ? '收入' : '中性'} · {c.name}
                </option>
              ))}
          </select>
        </label>
        <label className="block">
          <input
            type="checkbox"
            checked={draft.action.setDirection === 'neutral'}
            onChange={(e) =>
              change({
                action: e.target.checked
                  ? { categoryId: '', setDirection: 'neutral' }
                  : { categoryId: draft.action.categoryId },
              })
            }
          />
          将命中的资金流动改为中性
        </label>
      </fieldset>
      {preview && (
        <div role="status">
          <p>
            扫描 {preview.scanned} 笔，命中 {preview.matched} 笔，冲突 {preview.conflicts} 笔；最多展示最近 100 笔。
          </p>
          <RuleSamples samples={preview.samples} categories={categories} />
        </div>
      )}
      <div className="flex gap-2">
        <Button disabled={pending} onClick={() => run(false)}>
          试跑规则
        </Button>
        <Button
          variant="primary"
          disabled={pending || !tested || tested !== JSON.stringify(draft)}
          onClick={() => run(true)}
        >
          确认保存规则
        </Button>
        <Button disabled={pending} onClick={onCancel}>
          取消
        </Button>
      </div>
      <p className="text-sm text-gray-500">保存后用于后续导入；已有流水需另行预览并确认应用。</p>
    </section>
  );
}
