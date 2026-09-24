/**
 * 金额在接口中的表示（ADR-0002 补充）
 *
 * - 接口传输一律用整数"分"：centsSchema
 * - 仅用户在表单里输入时传"元"字符串：yuanInputSchema，由服务端用 core 的 parseYuanToCents 转换
 */
import { MoneyParseError, parseYuanToCents } from '@bookkeepx/core';
import { z } from 'zod';

/** 整数"分"：必须是安全整数（拒绝 12.5 这种误传的"元"） */
export const centsSchema = z.number().int('金额必须是以"分"为单位的整数').safe('金额超出范围');

/** 大于 0 的整数"分"（流水金额恒为正，方向由 direction 表达） */
export const positiveCentsSchema = centsSchema.positive('金额必须大于 0');

/**
 * 表单输入的"元"字符串，校验通过后直接转换为分。
 * 校验与转换使用同一个函数，前后端对"什么是合法金额"的判断不会不一致。
 */
export const yuanInputSchema = z.string().transform((value, ctx) => {
  try {
    return parseYuanToCents(value);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: e instanceof MoneyParseError ? e.message : '金额不合法' });
    return z.NEVER;
  }
});
