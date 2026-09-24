/**
 * 导入历史：每次上传一条记录；待确认的可以继续或放弃，已导入的可以整批撤销
 */
import type { ImportBatch } from '@bookkeepx/contracts';
import { toZonedDisplay } from '@bookkeepx/core';
import { useState } from 'react';
import { Badge, Button } from '../../shared/ui/index.tsx';
import { BATCH_STATUS_LABELS } from './preview.ts';

export interface ImportHistoryProps {
  batches: ImportBatch[];
  timezone: string;
  canEdit: boolean;
  /** 当前正在预览的批次（不再显示"继续"） */
  activeId: string | null;
  pending: boolean;
  onOpen: (id: string) => void;
  onDiscard: (id: string) => void;
  onRevert: (id: string) => void;
}

export function ImportHistory(p: ImportHistoryProps) {
  /** 等待二次确认撤销的批次：撤销会删除这一批导入的全部流水 */
  const [confirming, setConfirming] = useState<string | null>(null);
  if (p.batches.length === 0) {
    return (
      <p className="rounded-lg bg-white p-6 text-center text-sm text-gray-500 ring-1 ring-gray-200">还没有导入过账单</p>
    );
  }
  return (
    <ul className="divide-y divide-gray-100 rounded-lg bg-white ring-1 ring-gray-200">
      {p.batches.map((b) => {
        const at = toZonedDisplay(b.createdAt, p.timezone);
        return (
          <li
            key={b.id}
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
            data-testid="import-batch"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-medium">{b.fileName}</span>
                <Badge tone={b.status === 'committed' ? 'blue' : b.status === 'previewing' ? 'amber' : 'gray'}>
                  {BATCH_STATUS_LABELS[b.status]}
                </Badge>
              </div>
              <div className="text-xs text-gray-500">
                {[
                  `${at.date} ${at.time}`,
                  b.templateName,
                  b.status === 'committed' || b.status === 'reverted'
                    ? `导入 ${b.importedRows} 笔，重复 ${b.duplicateRows}，跳过 ${b.skippedRows}`
                    : `共 ${b.totalRows} 行`,
                ].join(' · ')}
              </div>
            </div>
            {p.canEdit && (
              <div className="flex gap-2">
                {b.status === 'previewing' && b.id !== p.activeId && (
                  <>
                    <Button disabled={p.pending} onClick={() => p.onOpen(b.id)}>
                      继续
                    </Button>
                    <Button variant="ghost" disabled={p.pending} onClick={() => p.onDiscard(b.id)}>
                      放弃
                    </Button>
                  </>
                )}
                {b.status === 'committed' &&
                  (confirming === b.id ? (
                    <>
                      <span className="self-center text-red-600">将删除这批导入的 {b.importedRows} 笔流水</span>
                      <Button
                        variant="danger"
                        disabled={p.pending}
                        onClick={() => {
                          setConfirming(null);
                          p.onRevert(b.id);
                        }}
                      >
                        确认撤销
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirming(null)}>
                        取消
                      </Button>
                    </>
                  ) : (
                    <Button variant="danger" disabled={p.pending} onClick={() => setConfirming(b.id)}>
                      撤销导入
                    </Button>
                  ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
