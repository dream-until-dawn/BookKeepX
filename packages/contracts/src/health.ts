/**
 * 健康检查接口契约：GET /api/health
 *
 * 用于部署探活与前端显示服务状态。数据库不可用时服务端返回 503，body 结构不变。
 */
import { z } from 'zod';

export const healthResponseSchema = z
  .object({
    /** 整体状态：数据库可用为 ok，否则 degraded */
    status: z.enum(['ok', 'degraded']),
    /** 数据库连通性 */
    database: z.enum(['up', 'down']),
    /** 服务端版本号（package.json 中的 version） */
    version: z.string().min(1),
  })
  .strict();

export type HealthResponse = z.infer<typeof healthResponseSchema>;
