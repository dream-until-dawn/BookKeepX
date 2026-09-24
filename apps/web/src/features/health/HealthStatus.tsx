/**
 * 服务状态指示：显示服务端与数据库是否可用
 */
import { type HealthResponse, healthResponseSchema } from '@bookkeepx/contracts';
import { useQuery } from '@tanstack/react-query';
import { ApiError, apiGet } from '../../shared/api/client.ts';

/** 健康检查请求；503 时服务端仍返回合法 body（database: down），按正常数据处理 */
export const fetchHealth = () => apiGet('/api/health', healthResponseSchema, { acceptStatus: [503] });

/** 三种展示状态对应的文案与颜色 */
function describe(data: HealthResponse | undefined, error: unknown) {
  if (error) {
    const msg = error instanceof ApiError ? error.message : '未知错误';
    return { tone: 'bg-red-100 text-red-800', text: `服务不可用：${msg}` };
  }
  if (!data) return { tone: 'bg-gray-100 text-gray-600', text: '正在检查服务状态…' };
  if (data.status === 'ok') return { tone: 'bg-green-100 text-green-800', text: `服务正常 · v${data.version}` };
  return { tone: 'bg-amber-100 text-amber-800', text: `数据库暂不可用 · v${data.version}` };
}

export function HealthStatus() {
  const { data, error } = useQuery({ queryKey: ['health'], queryFn: fetchHealth, retry: false });
  const { tone, text } = describe(data, error);
  return (
    <output className={`inline-block rounded-full px-3 py-1 text-sm ${tone}`} data-testid="health-status">
      {text}
    </output>
  );
}
