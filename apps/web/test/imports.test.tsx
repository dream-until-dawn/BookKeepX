/**
 * 账单导入：预览逻辑的纯函数 + 导入页交互（上传、选模板、校验失败、预览修改后提交、撤销、只读成员）
 */
import type { Category, ImportBatch, ImportRow } from '@bookkeepx/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app/routes.tsx';
import { buildUploadForm, verifyIssuesOf } from '../src/features/imports/api.ts';
import { buildOverrides, type Edits, includedSummary, type RowEdit } from '../src/features/imports/preview.ts';
import { ApiError } from '../src/shared/api/client.ts';

const LEDGER = '11111111-1111-4111-8111-111111111111';
const TZ = 'Asia/Shanghai';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BATCH = id(500);

const cat = (n: number, over: Partial<Category>): Category => ({
  id: id(n),
  parentId: null,
  group: 'expense',
  name: `分类${n}`,
  presetKey: null,
  icon: null,
  sort: n,
  hidden: false,
  transactionCount: 0,
  ...over,
});
const CATS: Category[] = [
  cat(1, { name: '餐饮' }),
  cat(2, { name: '交通' }),
  cat(3, { name: '工资', group: 'income' }),
];

const row = (index: number, over: Partial<ImportRow> = {}): ImportRow => ({
  index,
  rowLabel: `第 ${index + 1} 行`,
  status: 'new',
  reason: null,
  occurredAt: '2026-09-10T04:00:00.000Z',
  timePrecision: 'second',
  direction: 'expense',
  originalDirection: 'expense',
  amountCents: 1000,
  counterparty: `商户${index}`,
  description: '',
  paymentMethod: null,
  sourceHint: null,
  categoryId: id(1),
  categorySource: 'system_rule',
  categoryReason: '餐饮',
  refund: null,
  crossSource: null,
  ...over,
});

const batch = (over: Partial<ImportBatch> = {}): ImportBatch => ({
  id: BATCH,
  status: 'previewing',
  fileName: '支付宝交易明细.csv',
  templateId: 'alipay-csv',
  templateName: '支付宝账单（csv）',
  templateVersion: 1,
  detectScore: 1,
  accountId: null,
  holderName: '张三',
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  totalRows: 3,
  importedRows: 0,
  skippedRows: 0,
  duplicateRows: 0,
  sameFileImportedBefore: false,
  createdAt: '2026-09-24T02:00:00.000Z',
  committedAt: null,
  revertedAt: null,
  ...over,
});

const edits = (entries: [number, RowEdit][]): Edits => new Map(entries);

// ───────────────────────── 纯函数 ─────────────────────────
describe('buildOverrides（只提交真正的修改）', () => {
  const rows = [row(0), row(1), row(2, { status: 'duplicate', reason: '已导入过' })];

  it('正向：没有修改 → 空数组', () => {
    expect(buildOverrides(rows, edits([]))).toEqual([]);
  });

  it('正向：取消勾选、改分类 → 分别只带对应字段', () => {
    expect(
      buildOverrides(
        rows,
        edits([
          [0, { include: false }],
          [1, { categoryId: id(2) }],
        ]),
      ),
    ).toEqual([
      { index: 0, include: false },
      { index: 1, categoryId: id(2) },
    ]);
  });

  it('正向：改为未分类 → categoryId: null（不能被当成"没改"丢掉）', () => {
    expect(buildOverrides(rows, edits([[0, { categoryId: null }]]))).toEqual([{ index: 0, categoryId: null }]);
  });

  it('反向：改了又改回原值（重新勾选、分类改回原分类）→ 不提交', () => {
    expect(buildOverrides(rows, edits([[0, { include: true, categoryId: id(1) }]]))).toEqual([]);
  });

  it('反向：不可导入的行（已导入过）上的修改不提交，否则服务端会拒绝整次提交', () => {
    expect(buildOverrides(rows, edits([[2, { include: true, categoryId: id(2) }]]))).toEqual([]);
  });
});

describe('includedSummary（与流水统计同口径）', () => {
  it('正向：退款冲减支出、中性不计、跨来源重复的银行记录不计金额但计笔数', () => {
    const rows = [
      row(0, { amountCents: 10000 }),
      row(1, { amountCents: 3000, refund: { linked: true }, direction: 'neutral', categoryId: null }),
      row(2, { amountCents: 50000, direction: 'income', categoryId: id(3) }),
      row(3, { amountCents: 7000, direction: 'neutral', originalDirection: 'expense', categoryId: null }),
      row(4, { amountCents: 2000, crossSource: 'bank_side' }),
    ];
    expect(includedSummary(rows, edits([]))).toEqual({
      count: 5,
      incomeCents: 50000,
      expenseCents: 7000,
      // 退款不算未分类；中性那条未分类
      uncategorized: 1,
    });
  });

  it('反向：取消勾选的、已导入过的、跳过的都不计入', () => {
    const rows = [
      row(0, { amountCents: 100 }),
      row(1, { amountCents: 200 }),
      row(2, { amountCents: 400, status: 'duplicate' }),
      row(3, { amountCents: 800, status: 'skipped', reason: '交易关闭' }),
    ];
    expect(includedSummary(rows, edits([[1, { include: false }]]))).toMatchObject({ count: 1, expenseCents: 100 });
  });

  it('正向：预览中改为未分类后计入"未分类"', () => {
    expect(includedSummary([row(0)], edits([[0, { categoryId: null }]])).uncategorized).toBe(1);
  });
});

describe('上传表单与错误解析', () => {
  it('正向：普通字段排在文件之前（服务端按流读取，文件之后的字段读不到）', () => {
    const form = buildUploadForm({ file: new File(['x'], 'a.csv'), templateId: 'alipay-csv', accountId: id(7) });
    expect([...form.keys()]).toEqual(['templateId', 'accountId', 'file']);
  });

  it('反向：没有指定的字段不发送空值', () => {
    expect([...buildUploadForm({ file: new File(['x'], 'a.csv') }).keys()]).toEqual(['file']);
  });

  it('verifyIssuesOf：只识别自校验失败的错误', () => {
    const issues = [{ check: 'summary', detail: '支出合计不一致' }];
    expect(verifyIssuesOf(new ApiError('x', 422, 'IMPORT_VERIFY_FAILED', issues))).toEqual(issues);
    expect(verifyIssuesOf(new ApiError('x', 422, 'IMPORT_VERIFY_FAILED', 'bad'))).toEqual([]);
    expect(verifyIssuesOf(new ApiError('x', 400, 'IMPORT_UNSUPPORTED'))).toBeNull();
    expect(verifyIssuesOf(new Error('x'))).toBeNull();
  });
});

// ───────────────────────── 页面 ─────────────────────────
interface Call {
  method: string;
  url: string;
  body: unknown;
}
type Reply = { status: number; body?: unknown };

function mockServer(opts: { role?: string; history?: ImportBatch[]; onWrite?: (c: Call) => Reply }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const raw = init.body;
      const body = raw instanceof FormData ? raw : raw ? JSON.parse(String(raw)) : undefined;
      const call = { method, url, body };
      calls.push(call);
      let r: Reply = { status: 404 };
      if (method !== 'GET') r = opts.onWrite?.(call) ?? { status: 200 };
      else if (url === '/api/auth/me')
        r = { status: 200, body: { id: id(900), email: 'a@b.com', displayName: '小明', defaultLedgerId: LEDGER } };
      else if (url === `/api/ledgers/${LEDGER}`)
        r = {
          status: 200,
          body: { id: LEDGER, name: '我的账本', currency: 'CNY', timezone: TZ, role: opts.role ?? 'owner' },
        };
      else if (url.endsWith('/categories')) r = { status: 200, body: CATS };
      else if (url.endsWith('/accounts')) r = { status: 200, body: [] };
      else if (url.endsWith('/imports')) r = { status: 200, body: opts.history ?? [] };
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
    }),
  );
  return calls;
}

function renderAt(path: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
    </QueryClientProvider>,
  );
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');

async function chooseFileAndUpload() {
  const input = await screen.findByLabelText('账单文件');
  fireEvent.change(input, { target: { files: [new File(['data'], '支付宝交易明细.csv')] } });
  fireEvent.click(screen.getByRole('button', { name: '上传并识别' }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('导入页', () => {
  const previewRows = [
    row(0, { counterparty: '麦当劳' }),
    row(1, { counterparty: '滴滴出行', categoryId: null, categorySource: 'none', categoryReason: null }),
    row(2, { counterparty: '老订单', status: 'duplicate', reason: '已导入过' }),
    row(3, { counterparty: '退款商户', refund: { linked: true }, direction: 'neutral', categoryId: null }),
  ];

  it('正向：上传 → 预览；取消一行、给未分类的行选分类 → 提交请求只带这两处修改', async () => {
    const calls = mockServer({
      onWrite: (c) =>
        c.url.endsWith('/commit')
          ? { status: 200, body: batch({ status: 'committed', importedRows: 2 }) }
          : { status: 200, body: { status: 'preview', batch: batch({ rows: previewRows }) } },
    });
    renderAt('/imports');
    await chooseFileAndUpload();

    const preview = await screen.findByRole('region', { name: '导入预览' });
    expect(within(preview).getAllByTestId('preview-row')).toHaveLength(4);
    // 已导入过的行不能勾选；退款行显示关联状态而不是分类下拉框
    expect((within(preview).getByLabelText('导入 第 3 行') as HTMLInputElement).disabled).toBe(true);
    expect(within(preview).getByText('退款·已关联原消费')).toBeTruthy();
    expect(within(preview).queryByLabelText('分类 第 4 行')).toBeNull();
    expect(within(preview).getByRole('button', { name: '确认导入 3 笔' })).toBeTruthy();

    fireEvent.click(within(preview).getByLabelText('导入 第 1 行'));
    fireEvent.change(within(preview).getByLabelText('分类 第 2 行'), { target: { value: id(2) } });
    // 合计随修改更新：3 → 2 笔；退款 -10 冲减 滴滴 10 → 支出 0
    expect(within(screen.getByTestId('import-summary')).getByText('2 笔')).toBeTruthy();
    fireEvent.click(within(preview).getByRole('button', { name: '确认导入 2 笔' }));

    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    const commit = writes(calls)[1]!;
    expect(commit.url).toBe(`/api/ledgers/${LEDGER}/imports/${BATCH}/commit`);
    expect(commit.body).toEqual({
      overrides: [
        { index: 0, include: false },
        { index: 1, categoryId: id(2) },
      ],
    });
    expect((await screen.findByRole('status')).textContent).toContain('已导入 2 笔流水');
    expect(screen.queryByRole('region', { name: '导入预览' })).toBeNull();
  });

  it('正向：无法确定格式 → 列出候选；选定后重新上传并带上 templateId', async () => {
    let n = 0;
    const calls = mockServer({
      onWrite: () =>
        ++n === 1
          ? {
              status: 200,
              body: {
                status: 'choose_template',
                candidates: [{ templateId: 'alipay-csv', templateName: '支付宝账单（csv）', score: 0.62 }],
              },
            }
          : { status: 200, body: { status: 'preview', batch: batch({ rows: [row(0)] }) } },
    });
    renderAt('/imports');
    await chooseFileAndUpload();
    fireEvent.click(await screen.findByRole('button', { name: '支付宝账单（csv）（匹配度 62%）' }));
    await screen.findByRole('region', { name: '导入预览' });
    const second = writes(calls)[1]!.body as FormData;
    expect(second.get('templateId')).toBe('alipay-csv');
    expect(second.get('file')).toBeInstanceOf(File);
  });

  it('反向：自校验未通过 → 显示错误和问题列表，不出现预览', async () => {
    mockServer({
      onWrite: () => ({
        status: 422,
        body: {
          error: '账单自校验未通过，为避免导入错误数据已停止导入',
          code: 'IMPORT_VERIFY_FAILED',
          details: [{ check: 'summary', detail: '支出合计：账单写 100.00，解析得到 90.00' }],
        },
      }),
    });
    renderAt('/imports');
    await chooseFileAndUpload();
    expect((await screen.findByRole('alert')).textContent).toContain('自校验未通过');
    expect(within(screen.getByRole('list', { name: '校验问题' })).getByText(/解析得到 90\.00/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: '导入预览' })).toBeNull();
  });

  it('反向：没选文件时"上传并识别"不可点', async () => {
    const calls = mockServer({});
    renderAt('/imports');
    expect(((await screen.findByRole('button', { name: '上传并识别' })) as HTMLButtonElement).disabled).toBe(true);
    expect(writes(calls)).toHaveLength(0);
  });

  it('正向：撤销导入需要二次确认；取消则不发请求，确认后才发送', async () => {
    const committed = batch({ status: 'committed', importedRows: 12 });
    const calls = mockServer({
      history: [committed],
      onWrite: () => ({ status: 200, body: { ...committed, status: 'reverted' } }),
    });
    renderAt('/imports');
    fireEvent.click(await screen.findByRole('button', { name: '撤销导入' }));
    expect(screen.getByText('将删除这批导入的 12 笔流水')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(writes(calls)).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: '撤销导入' }));
    fireEvent.click(screen.getByRole('button', { name: '确认撤销' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: 'POST', url: `/api/ledgers/${LEDGER}/imports/${BATCH}/revert` });
  });

  it('正向：历史中待确认的预览可以继续（读取带预览行的批次）', async () => {
    const calls = mockServer({ history: [batch()] });
    // 打开批次详情走 GET：覆盖默认的 404
    const fetchMock = vi.mocked(fetch);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) =>
      String(url).endsWith(`/imports/${BATCH}`)
        ? new Response(JSON.stringify(batch({ rows: [row(0, { counterparty: '继续的那行' })] })), { status: 200 })
        : base(url, init),
    );
    renderAt('/imports');
    fireEvent.click(await screen.findByRole('button', { name: '继续' }));
    expect(await screen.findByText('继续的那行')).toBeTruthy();
    expect(writes(calls)).toHaveLength(0);
  });

  it('反向：只读成员看不到上传区，也不能撤销', async () => {
    mockServer({ role: 'viewer', history: [batch({ status: 'committed', importedRows: 3 })] });
    renderAt('/imports');
    expect(await screen.findByTestId('import-batch')).toBeTruthy();
    expect(screen.queryByLabelText('账单文件')).toBeNull();
    expect(screen.queryByRole('button', { name: '撤销导入' })).toBeNull();
  });
});
