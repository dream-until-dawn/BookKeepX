/**
 * 自定义模板向导：推荐映射 / 关键词 / 配置转换的纯函数 + 导入页中的向导流程与"我的模板"管理
 */
import type { TemplateTestResponse, UserTemplate } from '@bookkeepx/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app/routes.tsx';
import {
  fromSpec,
  guessDirection,
  guessMapping,
  guessSkipStatuses,
  initialState,
  suggestTitleKeyword,
  toSpec,
} from '../src/features/import-templates/wizard.ts';

const LEDGER = '11111111-1111-4111-8111-111111111111';
const TPL = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** 银行文件样本（与服务端 inspect 返回的形态一致） */
const BANK_ROWS = [
  ['某某银行活期账户交易明细'],
  ['户名：张三'],
  ['------------'],
  ['交易日期', '摘要', '对方户名', '收入金额', '支出金额', '账户余额'],
  ['2026-09-05', '转账', '李四', '', '1000.00', '7943.70'],
  ['2026-09-02', '消费', '某超市', '', '56.30', '8943.70'],
];
const WECHAT_HEADER = [
  '交易时间',
  '交易类型',
  '交易对方',
  '商品',
  '收/支',
  '金额(元)',
  '支付方式',
  '当前状态',
  '交易单号',
  '商户单号',
  '备注',
];

describe('推荐列映射', () => {
  it('正向：旧版微信表头 → 时间、类型、对方、商品、收支、金额、支付方式、状态、单号；商户单号与备注不分配', () => {
    expect(guessMapping(WECHAT_HEADER)).toEqual({
      交易时间: 'occurredAt',
      交易类型: 'categoryHint',
      交易对方: 'counterparty',
      商品: 'description',
      '收/支': 'direction',
      '金额(元)': 'amount',
      支付方式: 'paymentMethod',
      当前状态: 'status',
      交易单号: 'externalId',
      商户单号: '',
      备注: '',
    });
  });

  it('正向：银行表头 → 收入、支出分两列，"收入金额"不会被当成"金额"', () => {
    expect(guessMapping(BANK_ROWS[3]!)).toEqual({
      交易日期: 'occurredAt',
      摘要: 'description',
      对方户名: 'counterparty',
      收入金额: 'income',
      支出金额: 'expense',
      账户余额: 'balance',
    });
  });

  it('反向：认不出的列名都不分配', () => {
    expect(Object.values(guessMapping(['A', 'B', 'C']))).toEqual(['', '', '']);
  });
});

describe('推荐其他配置', () => {
  it('suggestTitleKeyword：跳过"户名：张三"这类个人信息与分隔线，取第一行说明文字', () => {
    expect(suggestTitleKeyword(BANK_ROWS, 3)).toBe('某某银行活期账户交易明细');
    expect(suggestTitleKeyword([['户名：张三'], ['-----'], ['2026-09-01'], ['标题']], 4)).toBe('标题');
  });

  it('反向：表头就是第一行、或还没选表头 → 不推荐关键词', () => {
    expect(suggestTitleKeyword(BANK_ROWS.slice(3), 0)).toBe('');
    expect(suggestTitleKeyword(BANK_ROWS, null)).toBe('');
  });

  it('guessDirection / guessSkipStatuses：常见写法；认不出的留空', () => {
    expect(['收入', '支出', '/', '其他'].map(guessDirection)).toEqual(['income', 'expense', 'neutral', '']);
    expect(guessSkipStatuses(['支付成功', '交易关闭', '退款失败', '已全额退款'])).toEqual(['交易关闭', '退款失败']);
  });

  it('initialState：银行样本 → 分两列、时间格式 yyyy-MM-dd、来源按文件名推断', () => {
    const s = initialState(BANK_ROWS, 3, '某银行.csv');
    expect(s).toMatchObject({
      amountMode: 'split',
      timeFormat: 'yyyy-MM-dd',
      sourceKind: 'bank_debit',
      balanceCheck: false,
    });
    expect(initialState(BANK_ROWS, 3, '微信支付账单.csv').sourceKind).toBe('wechat');
  });
});

describe('toSpec / fromSpec', () => {
  it('正向：只带入与金额方式相关的列；关键词按中英文逗号拆分；余额校验需要余额列', () => {
    const s = { ...initialState(BANK_ROWS, 3, 'a.csv'), titleKeywords: '某某银行，活期, 明细', balanceCheck: true };
    s.mapping = { ...s.mapping, 摘要: 'amount' };
    const spec = toSpec(s, BANK_ROWS, 'csv');
    expect(spec.columns).toEqual({
      occurredAt: '交易日期',
      counterparty: '对方户名',
      income: '收入金额',
      expense: '支出金额',
      balance: '账户余额',
    });
    expect(spec.titleKeywords).toEqual(['某某银行', '活期', '明细']);
    expect(spec.balanceCheck).toBe(true);
    const noBalance = toSpec({ ...s, mapping: { ...s.mapping, 账户余额: '' } }, BANK_ROWS, 'csv');
    expect(noBalance.balanceCheck).toBe(false);
  });

  it('正向：收支列方式只带入已选方向的取值', () => {
    const s = initialState(
      [WECHAT_HEADER, ['2026-09-01 12:00:00', '', '', '', '收入', '1', '', '', '', '', '']],
      0,
      'x.csv',
    );
    const spec = toSpec({ ...s, directionMap: { 收入: 'income', 其他: '' } }, [WECHAT_HEADER], 'csv');
    expect(spec.directionMap).toEqual({ 收入: 'income' });
    expect(spec.columns).toMatchObject({ amount: '金额(元)', direction: '收/支' });
  });

  it('往返：fromSpec(toSpec(state)) 再转回得到同样的配置；表头在新样本中的位置变了也能找到', () => {
    const spec = toSpec(initialState(BANK_ROWS, 3, 'a.csv'), BANK_ROWS, 'csv');
    const parsed = {
      ...spec,
      directionMap: {},
      skipStatuses: [],
      fileNameKeywords: [],
      titleKeywords: spec.titleKeywords ?? [],
    } as Parameters<typeof fromSpec>[0];
    const moved = [['新的说明'], ...BANK_ROWS];
    const back = fromSpec(parsed, moved);
    expect(back.headerRow).toBe(4);
    expect(toSpec(back, moved, 'csv')).toEqual(spec);
  });

  it('反向：新样本里没有这一行表头 → headerRow 为 null', () => {
    const spec = toSpec(initialState(BANK_ROWS, 3, 'a.csv'), BANK_ROWS, 'csv') as Parameters<typeof fromSpec>[0];
    expect(
      fromSpec({ ...spec, directionMap: {}, skipStatuses: [], titleKeywords: [], fileNameKeywords: [] }, [
        ['别的表头', 'x'],
      ]).headerRow,
    ).toBeNull();
  });
});

// ───────────────────────── 页面 ─────────────────────────
interface Call {
  method: string;
  url: string;
  body: unknown;
}
type Reply = { status: number; body?: unknown };

const okTest: TemplateTestResponse = {
  headerFound: true,
  total: 2,
  records: [
    {
      rowLabel: '第 5 行',
      occurredAt: '2026-09-05T00:00:00+08:00',
      direction: 'expense',
      amountCents: 100000,
      counterparty: '李四',
      description: '转账',
      skipReason: null,
    },
  ],
  errors: [],
  errorCount: 0,
  issues: [],
  detect: { score: 1, autoSelected: true, reason: null },
};

const template = (over: Partial<UserTemplate> = {}): UserTemplate => ({
  id: TPL,
  name: '某银行活期',
  fileType: 'csv',
  version: 1,
  spec: {
    fileType: 'csv',
    sourceKind: 'bank_debit',
    header: BANK_ROWS[3]!,
    columns: { occurredAt: '交易日期', income: '收入金额', expense: '支出金额' },
    amountMode: 'split',
    directionMap: {},
    skipStatuses: [],
    timeFormat: 'yyyy-MM-dd',
    titleKeywords: [],
    fileNameKeywords: [],
    balanceCheck: false,
  },
  lastUsedAt: null,
  createdAt: '2026-09-24T02:00:00.000Z',
  updatedAt: '2026-09-24T02:00:00.000Z',
  ...over,
});

function mockServer(opts: { templates?: UserTemplate[]; onWrite: (c: Call) => Reply }) {
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
      if (method !== 'GET') r = opts.onWrite(call);
      else if (url === '/api/auth/me')
        r = { status: 200, body: { id: id(900), email: 'a@b.com', displayName: '小明', defaultLedgerId: LEDGER } };
      else if (url === `/api/ledgers/${LEDGER}`)
        r = {
          status: 200,
          body: { id: LEDGER, name: '我的账本', currency: 'CNY', timezone: 'Asia/Shanghai', role: 'owner' },
        };
      else if (url.endsWith('/categories') || url.endsWith('/accounts') || url.endsWith('/imports'))
        r = { status: 200, body: [] };
      else if (url === '/api/import-templates') r = { status: 200, body: opts.templates ?? [] };
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
const inspectReply: Reply = {
  status: 200,
  body: { fileType: 'csv', rows: BANK_ROWS, totalRows: 6, suggestedHeaderRow: 3 },
};

/** 默认的服务端：上传 → 不支持；inspect / test / 创建 → 成功；带模板上传 → 预览 */
function wizardServer(testReply: TemplateTestResponse = okTest) {
  return mockServer({
    onWrite: (c) => {
      if (c.url.endsWith('/import-templates/inspect')) return inspectReply;
      if (c.url.endsWith('/import-templates/test')) return { status: 200, body: testReply };
      if (c.url === '/api/import-templates') return { status: 201, body: template() };
      const form = c.body as FormData;
      if (form.get('templateId') === TPL) return { status: 200, body: { status: 'choose_template', candidates: [] } };
      return { status: 400, body: { error: '暂不支持这种账单格式', code: 'IMPORT_UNSUPPORTED' } };
    },
  });
}

async function openWizard() {
  renderAt('/imports');
  fireEvent.change(await screen.findByLabelText('账单文件'), { target: { files: [new File(['x'], '某银行.csv')] } });
  fireEvent.click(screen.getByRole('button', { name: '上传并识别' }));
  fireEvent.click(await screen.findByRole('button', { name: '创建自定义模板' }));
  return screen.findByRole('region', { name: '自定义模板' });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('向导流程', () => {
  it('正向：不支持的文件 → 创建模板 → 推荐表头与映射 → 试解析通过 → 命名保存 → 用新模板继续导入', async () => {
    const calls = wizardServer();
    const wizard = await openWizard();
    const rows = await within(wizard).findAllByTestId('sample-row');
    expect(rows[3]!.getAttribute('aria-selected')).toBe('true');
    expect((within(wizard).getByLabelText('列「收入金额」') as HTMLSelectElement).value).toBe('income');
    expect((within(wizard).getByLabelText('识别关键词') as HTMLInputElement).value).toBe('某某银行活期账户交易明细');

    const save = within(wizard).getByRole('button', { name: '保存并继续导入' }) as HTMLButtonElement;
    fireEvent.change(within(wizard).getByLabelText('模板名称'), { target: { value: '某银行活期' } });
    expect(save.disabled).toBe(true);

    fireEvent.click(within(wizard).getByRole('button', { name: '试解析' }));
    expect(await within(wizard).findByText('保存后，这种文件上传时会被自动识别')).toBeTruthy();
    const testCall = writes(calls).find((c) => c.url.endsWith('/test'))!;
    const form = testCall.body as FormData;
    expect([...form.keys()]).toEqual(['spec', 'file']);
    expect(JSON.parse(String(form.get('spec')))).toMatchObject({ amountMode: 'split', header: BANK_ROWS[3] });

    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(
        writes(calls).some((c) => c.url.endsWith('/imports') && (c.body as FormData).get('templateId') === TPL),
      ).toBe(true),
    );
    const created = writes(calls).find((c) => c.url === '/api/import-templates')!;
    expect(created.body).toMatchObject({ name: '某银行活期', spec: { timeFormat: 'yyyy-MM-dd' } });
  });

  it('反向：试解析有错误行 → 不能保存；改了配置 → 需要重新试解析', async () => {
    wizardServer({ ...okTest, errors: [{ row: '第 5 行', message: '时间 "x" 不符合格式' }], errorCount: 1 });
    const wizard = await openWizard();
    fireEvent.change(await within(wizard).findByLabelText('模板名称'), { target: { value: '坏模板' } });
    fireEvent.click(within(wizard).getByRole('button', { name: '试解析' }));
    expect(await within(wizard).findByText(/不符合格式/)).toBeTruthy();
    const save = within(wizard).getByRole('button', { name: '保存并继续导入' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(within(wizard).getByLabelText('时间格式'), { target: { value: 'yyyy/MM/dd' } });
    expect(within(wizard).getByText('配置已修改，请重新试解析')).toBeTruthy();
    expect(within(wizard).queryByTestId('test-result')).toBeNull();
  });

  it('反向：配置不完整（去掉时间列）→ 显示原因，"试解析"不可点', async () => {
    wizardServer();
    const wizard = await openWizard();
    fireEvent.change(await within(wizard).findByLabelText('列「交易日期」'), { target: { value: '' } });
    expect(within(wizard).getByText('必须指定交易时间列')).toBeTruthy();
    expect((within(wizard).getByRole('button', { name: '试解析' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('正向：一个字段只能对应一列——把另一列设为"交易时间"，原来的时间列自动清空', async () => {
    wizardServer();
    const wizard = await openWizard();
    fireEvent.change(await within(wizard).findByLabelText('列「摘要」'), { target: { value: 'occurredAt' } });
    expect((within(wizard).getByLabelText('列「交易日期」') as HTMLSelectElement).value).toBe('');
  });

  it('正向：候选模板都不对时也能进入向导', async () => {
    mockServer({
      onWrite: (c) =>
        c.url.endsWith('/inspect')
          ? inspectReply
          : {
              status: 200,
              body: {
                status: 'choose_template',
                candidates: [{ templateId: 'alipay-csv', templateName: '支付宝', score: 0.6 }],
              },
            },
    });
    renderAt('/imports');
    fireEvent.change(await screen.findByLabelText('账单文件'), { target: { files: [new File(['x'], 'a.csv')] } });
    fireEvent.click(screen.getByRole('button', { name: '上传并识别' }));
    fireEvent.click(await screen.findByRole('button', { name: '都不是，创建新模板' }));
    expect(await screen.findByRole('region', { name: '自定义模板' })).toBeTruthy();
  });
});

describe('我的模板', () => {
  it('正向：改名 → PATCH 只带名称；删除需二次确认', async () => {
    const calls = mockServer({
      templates: [template()],
      onWrite: (c) => (c.method === 'DELETE' ? { status: 204 } : { status: 200, body: template({ name: '工资卡' }) }),
    });
    renderAt('/imports');
    const item = await screen.findByTestId('user-template');
    fireEvent.click(within(item).getByRole('button', { name: '改名' }));
    fireEvent.change(within(item).getByLabelText('新名称'), { target: { value: '工资卡' } });
    fireEvent.click(within(item).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({
      method: 'PATCH',
      url: `/api/import-templates/${TPL}`,
      body: { name: '工资卡' },
    });

    fireEvent.click(within(screen.getByTestId('user-template')).getByRole('button', { name: '删除' }));
    expect(writes(calls)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls)[1]).toMatchObject({ method: 'DELETE', url: `/api/import-templates/${TPL}` });
  });

  it('正向：用样本修改 → 向导还原原配置，保存时 PATCH 而不是新建', async () => {
    const calls = mockServer({
      templates: [template()],
      onWrite: (c) => {
        if (c.url.endsWith('/inspect')) return inspectReply;
        if (c.url.endsWith('/test')) return { status: 200, body: okTest };
        if (c.method === 'PATCH') return { status: 200, body: template({ version: 2 }) };
        return { status: 200, body: { status: 'choose_template', candidates: [] } };
      },
    });
    renderAt('/imports');
    const item = await screen.findByTestId('user-template');
    fireEvent.change(within(item).getByLabelText('选择样本文件修改「某银行活期」'), {
      target: { files: [new File(['x'], 'b.csv')] },
    });
    const wizard = await screen.findByRole('region', { name: '自定义模板' });
    // 原配置中"对方户名"没有映射，推荐规则本会映射它；还原的是原配置
    expect(((await within(wizard).findByLabelText('列「对方户名」')) as HTMLSelectElement).value).toBe('');
    expect((within(wizard).getByLabelText('模板名称') as HTMLInputElement).value).toBe('某银行活期');
    fireEvent.click(within(wizard).getByRole('button', { name: '试解析' }));
    await within(wizard).findByTestId('test-result');
    expect((writes(calls).find((c) => c.url.endsWith('/test'))!.body as FormData).get('templateId')).toBe(TPL);
    fireEvent.click(within(wizard).getByRole('button', { name: '保存并继续导入' }));
    await waitFor(() => expect(writes(calls).some((c) => c.method === 'PATCH')).toBe(true));
    expect(writes(calls).some((c) => c.url === '/api/import-templates' && c.method === 'POST')).toBe(false);
  });
});
