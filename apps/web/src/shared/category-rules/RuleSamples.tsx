/** 草稿冲突与历史变更共用的预览表。 */
import type { Category, RuleSample } from '@bookkeepx/contracts';
import { DIRECTION_LABELS } from '@bookkeepx/contracts';
import { formatCents } from '@bookkeepx/core';
export function RuleSamples({ samples, categories }: { samples: RuleSample[]; categories: Category[] }) {
  const label = (id: string | null) => categories.find((c) => c.id === id)?.name ?? '未分类';
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            <th>对方 / 金额</th>
            <th>原分类 → 结果</th>
            <th>规则与保护</th>
          </tr>
        </thead>
        <tbody>
          {samples.map((s) => (
            <tr key={s.id} className="border-t border-gray-200">
              <td className="py-2">
                {s.counterparty || '无对方'}
                <br />
                {formatCents(s.amountCents)}
              </td>
              <td>
                {label(s.before.categoryId)} → {label(s.after.categoryId)}
                <br />
                {DIRECTION_LABELS[s.before.direction]} → {DIRECTION_LABELS[s.after.direction]}
              </td>
              <td>
                {s.protected
                  ? '手动分类或退款关联：保持不变'
                  : (s.matchingRules.find((r) => r.id === s.after.ruleId)?.name ?? '系统分类')}
                {s.conflict && <p className="text-amber-700">冲突：{s.matchingRules.map((r) => r.name).join('、')}</p>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
