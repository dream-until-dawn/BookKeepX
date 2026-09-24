/**
 * 统一错误处理
 *
 * - 4xx（客户端错误，如参数校验失败）：原样返回错误信息，方便前端提示；
 * - 5xx（服务端错误）：只返回通用提示，详细信息写入日志，不把内部细节暴露给客户端。
 */
import type { FastifyError, FastifyInstance } from 'fastify';
import { AppError } from '../errors.ts';

export interface ErrorBody {
  error: string;
  /** 业务错误码（AppError 才有），前端据此区分处理 */
  code?: string;
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: err.message, code: err.code } satisfies ErrorBody);
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, '未处理的服务端错误');
      return reply.code(status).send({ error: '服务器内部错误' } satisfies ErrorBody);
    }
    return reply.code(status).send({ error: err.message } satisfies ErrorBody);
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: `接口不存在：${req.method} ${req.url}` } satisfies ErrorBody);
  });
}
