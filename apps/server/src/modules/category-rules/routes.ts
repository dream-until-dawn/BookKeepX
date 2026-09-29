/** 规则接口：权限和结构校验统一在入口完成。 */
import { ruleApplyRequestSchema, ruleDraftSchema, rulePreviewRequestSchema } from '@bookkeepx/contracts';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/client.ts';
import { AppError } from '../../errors.ts';
import { isUuid } from '../../plugins/ledger-scope.ts';
import { parseOrThrow } from '../../plugins/validation.ts';
import { applyHistory, deleteRule, listRules, previewHistory, previewRule, saveRule } from './service.ts';

const BASE = '/api/ledgers/:ledgerId/category-rules';
function idOf(params: unknown) {
  const { id } = params as { id?: unknown };
  if (!isUuid(id)) throw new AppError(404, 'RULE_NOT_FOUND', '规则不存在');
  return id;
}
/** 注册账本规则管理及预览接口。 */
export function categoryRuleRoutes(app: FastifyInstance, db: Db) {
  const edit = { preHandler: app.requireLedger('editor') };
  app.get(BASE, { preHandler: app.requireLedger('viewer') }, (req) => listRules(db, req.ledgerScope!));
  app.post(BASE, edit, async (req, reply) =>
    reply.code(201).send(await saveRule(db, req.ledgerScope!, parseOrThrow(ruleDraftSchema, req.body))),
  );
  app.patch(`${BASE}/:id`, edit, (req) =>
    saveRule(db, req.ledgerScope!, parseOrThrow(ruleDraftSchema, req.body), idOf(req.params)),
  );
  app.delete(`${BASE}/:id`, edit, async (req, reply) => {
    await deleteRule(db, req.ledgerScope!, idOf(req.params));
    return reply.code(204).send();
  });
  app.post(`${BASE}/preview`, edit, (req) => {
    const body = parseOrThrow(rulePreviewRequestSchema, req.body);
    return previewRule(db, req.ledgerScope!, body.rule, body.ruleId);
  });
  app.post(`${BASE}/history-preview`, edit, (req) => previewHistory(db, req.ledgerScope!));
  app.post(`${BASE}/apply`, edit, (req) =>
    applyHistory(db, req.ledgerScope!, parseOrThrow(ruleApplyRequestSchema, req.body).digest),
  );
}
