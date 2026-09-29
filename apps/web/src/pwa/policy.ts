/** 同源接口必须走网络；同时覆盖 /api、子路径及带查询参数的请求。 */
export function isApiRequest(url: URL, origin: string): boolean {
  return url.origin === origin && (url.pathname === '/api' || url.pathname.startsWith('/api/'));
}
/** 仅页面导航允许离线页；接口失败必须保持失败，不能用 HTML 冒充响应。 */
export function canShowOfflinePage(request: Pick<Request, 'mode' | 'url'>): boolean {
  const url = new URL(request.url);
  return request.mode === 'navigate' && !isApiRequest(url, url.origin);
}
