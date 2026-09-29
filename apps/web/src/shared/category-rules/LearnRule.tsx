/** 学习只生成待确认草稿，不因用户改分类就自动保存。 */
import type { Category, Direction } from '@bookkeepx/contracts';
import { useState } from 'react';
import { Button } from '../ui/index.tsx';
import { newRule, RuleEditor } from './RuleEditor.tsx';
export interface LearningChoice {
  counterparty: string;
  direction: Direction;
  categoryId: string;
}
export function LearnRule({
  ledgerId,
  categories,
  choice,
  onClose,
}: {
  ledgerId: string;
  categories: Category[];
  choice: LearningChoice;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const initial = newRule(choice.categoryId, choice.counterparty, choice.direction);
  if (choice.direction !== 'neutral' && categories.find((c) => c.id === choice.categoryId)?.group === 'neutral') {
    initial.action.setDirection = 'neutral';
  }
  return (
    <aside className="my-3 rounded-lg bg-blue-50 p-3" aria-label="学习分类规则">
      <p>
        以后「{choice.counterparty}」都归到「{categories.find((c) => c.id === choice.categoryId)?.name}」？
      </p>
      {editing ? (
        <RuleEditor ledgerId={ledgerId} categories={categories} initial={initial} onDone={onClose} onCancel={onClose} />
      ) : (
        <div className="mt-2 flex gap-2">
          <Button onClick={() => setEditing(true)}>查看规则建议</Button>
          <Button onClick={onClose}>暂不学习</Button>
        </div>
      )}
    </aside>
  );
}
