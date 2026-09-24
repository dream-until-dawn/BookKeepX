/**
 * 接口测试工具：通过真实接口注册用户、拿到会话，再以该用户身份调用其他接口
 */
import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from '@bookkeepx/contracts';
import type { buildApp } from '../src/app.ts';
import { SESSION_COOKIE } from '../src/modules/auth/sessions.ts';

type App = ReturnType<typeof buildApp>;

export interface TestUser {
  id: string;
  ledgerId: string;
  token: string;
}

let seq = 0;

/** 通过注册接口创建用户（同时得到默认账本和会话令牌） */
export async function registerUser(app: App, name = `u${++seq}`): Promise<TestUser> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE },
    // 每个用户用不同的来源 IP，避免触发注册限流
    remoteAddress: `10.1.${Math.floor(seq / 250)}.${seq % 250}`,
    payload: { email: `${name}-${seq}@example.com`, password: 'correct horse', displayName: name },
  });
  if (res.statusCode !== 201) throw new Error(`注册失败：${res.statusCode} ${res.body}`);
  const body = res.json();
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  return { id: body.id, ledgerId: body.defaultLedgerId, token };
}

/** 以某个用户身份调用接口 */
export function as(app: App, user: TestUser | null) {
  const send = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: method === 'GET' ? {} : { [CLIENT_HEADER]: CLIENT_HEADER_VALUE },
      ...(user ? { cookies: { [SESSION_COOKIE]: user.token } } : {}),
      ...(payload ? { payload } : {}),
    });
  return {
    get: (url: string) => send('GET', url),
    post: (url: string, body: object) => send('POST', url, body),
    patch: (url: string, body: object) => send('PATCH', url, body),
    del: (url: string) => send('DELETE', url),
  };
}
