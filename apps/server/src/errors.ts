/**
 * 业务错误：带 HTTP 状态码和错误码，由统一错误处理（plugins/error-handler.ts）转成响应
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    /** 机器可读的错误码，前端据此做不同处理 */
    readonly code: string,
    message: string,
    /** 附加信息（如导入自校验失败时的问题列表），原样返回给前端 */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * 账本不存在，或当前用户不是成员。
 * 两种情况返回同一个 404：不向非成员透露"这个账本存在"。
 */
export class LedgerNotFoundError extends AppError {
  constructor() {
    super(404, 'LEDGER_NOT_FOUND', '账本不存在或无权访问');
  }
}

/** 是账本成员，但角色权限不够（例如只读成员尝试记账） */
export class LedgerForbiddenError extends AppError {
  constructor(required: string) {
    super(403, 'LEDGER_FORBIDDEN', `需要"${required}"及以上权限`);
  }
}
