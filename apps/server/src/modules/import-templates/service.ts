/**
 * 自定义解析模板服务（docs/import.md §9）
 *
 * 模板属于用户（不属于账本），所有函数都以 userId 过滤。
 * 库中保存向导配置（spec），使用时编译为标准模板；编译失败的模板（例如引擎升级后不再兼容）不参与识别。
 */

import { isDeepStrictEqual } from 'node:util';
import type {
  CreateUserTemplateRequest,
  InspectResponse,
  TemplateTestResponse,
  UpdateUserTemplateRequest,
  UserTemplate,
} from '@bookkeepx/contracts';
import { userTemplateSpecSchema } from '@bookkeepx/contracts';
import {
  BUILTIN_TEMPLATES,
  compileUserTemplate,
  type ImportTemplate,
  inspectFile,
  sniffFileType,
  trialParse,
} from '@bookkeepx/importers';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { isUniqueViolation } from '../../db/pg-error.ts';
import { importTemplates } from '../../db/schema/index.ts';
import { AppError } from '../../errors.ts';
import { parseOrThrow } from '../../plugins/validation.ts';

/** 每个用户最多保存的模板数（防止无限增长拖慢识别） */
export const MAX_TEMPLATES_PER_USER = 50;

type Row = typeof importTemplates.$inferSelect;

const notFound = () => new AppError(404, 'TEMPLATE_NOT_FOUND', '模板不存在');
const nameTaken = () => new AppError(409, 'TEMPLATE_NAME_TAKEN', '已有同名模板');

function toDto(r: Row): UserTemplate {
  return {
    id: r.id,
    name: r.name,
    fileType: r.fileType as UserTemplate['fileType'],
    version: r.version,
    spec: userTemplateSpecSchema.parse(r.definition),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** 编译检查：spec 已通过 schema 校验，这里兜底捕获编译成标准模板时的问题 */
function compileOrThrow(spec: unknown, meta: { id: string; name: string; version: number }): ImportTemplate {
  try {
    return compileUserTemplate(spec, meta);
  } catch (e) {
    throw new AppError(400, 'TEMPLATE_INVALID', (e as Error).message);
  }
}

export async function listTemplates(db: Db, userId: string): Promise<UserTemplate[]> {
  const rows = await db
    .select()
    .from(importTemplates)
    .where(eq(importTemplates.userId, userId))
    .orderBy(desc(importTemplates.updatedAt));
  return rows.map(toDto);
}

/**
 * 该用户的全部模板，编译为标准模板（供识别与解析）
 * 编译失败的模板跳过：不能因为一份旧模板坏了就让所有上传都失败
 */
export async function loadUserTemplates(db: Db, userId: string): Promise<ImportTemplate[]> {
  const rows = await db.select().from(importTemplates).where(eq(importTemplates.userId, userId));
  return rows.flatMap((r) => {
    try {
      return [compileUserTemplate(r.definition, { id: r.id, name: r.name, version: r.version })];
    } catch {
      return [];
    }
  });
}

/** 模板名称（导入历史展示用）：内置模板直接取；自定义模板查库，已删除时给出提示 */
export async function templateNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  const names = new Map(BUILTIN_TEMPLATES.map((t) => [t.id, t.name]));
  const custom = [...new Set(ids.filter((id) => !names.has(id)))];
  // 非 uuid 的 id 不可能是自定义模板，不查库（否则 uuid 列比较会报错）
  const uuids = custom.filter((id) => /^[0-9a-f-]{36}$/.test(id));
  if (uuids.length > 0) {
    const rows = await db
      .select({ id: importTemplates.id, name: importTemplates.name })
      .from(importTemplates)
      .where(inArray(importTemplates.id, uuids));
    for (const r of rows) names.set(r.id, r.name);
  }
  for (const id of custom) if (!names.has(id)) names.set(id, '已删除的自定义模板');
  return names;
}

export async function markUsed(db: Db, userId: string, templateId: string, now: Date): Promise<void> {
  await db
    .update(importTemplates)
    .set({ lastUsedAt: now })
    .where(and(eq(importTemplates.id, templateId), eq(importTemplates.userId, userId)));
}

async function getOwn(db: Db, userId: string, id: string): Promise<Row> {
  const [r] = await db
    .select()
    .from(importTemplates)
    .where(and(eq(importTemplates.id, id), eq(importTemplates.userId, userId)));
  if (!r) throw notFound();
  return r;
}

export async function createTemplate(db: Db, userId: string, input: CreateUserTemplateRequest): Promise<UserTemplate> {
  const existing = await db.$count(importTemplates, eq(importTemplates.userId, userId));
  if (existing >= MAX_TEMPLATES_PER_USER) {
    throw new AppError(400, 'TEMPLATE_LIMIT', `最多保存 ${MAX_TEMPLATES_PER_USER} 个模板，请先删除不用的模板`);
  }
  const spec = userTemplateSpecSchema.parse(input.spec);
  // 用占位 id 做一次编译检查；真正的 id 由数据库生成
  compileOrThrow(spec, { id: '00000000-0000-4000-8000-000000000000', name: input.name, version: 1 });
  try {
    const [r] = await db
      .insert(importTemplates)
      .values({ userId, name: input.name.trim(), fileType: spec.fileType, definition: spec })
      .returning();
    return toDto(r!);
  } catch (e) {
    if (isUniqueViolation(e, 'import_templates_user_name_uq')) throw nameTaken();
    throw e;
  }
}

/** 修改名称 / 配置；配置有变化时版本号 + 1（导入批次记录所用版本） */
export async function updateTemplate(
  db: Db,
  userId: string,
  id: string,
  patch: UpdateUserTemplateRequest,
  now: Date,
): Promise<UserTemplate> {
  const row = await getOwn(db, userId, id);
  const set: Partial<typeof importTemplates.$inferInsert> = { updatedAt: now };
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.spec !== undefined) {
    const spec = userTemplateSpecSchema.parse(patch.spec);
    // 与字段顺序无关地比较（jsonb 存储时会重排字段，不能用 JSON 文本比较）
    if (!isDeepStrictEqual(spec, userTemplateSpecSchema.parse(row.definition))) {
      compileOrThrow(spec, { id, name: set.name ?? row.name, version: row.version + 1 });
      set.definition = spec;
      set.fileType = spec.fileType;
      set.version = row.version + 1;
    }
  }
  try {
    const [r] = await db.update(importTemplates).set(set).where(eq(importTemplates.id, id)).returning();
    return toDto(r!);
  } catch (e) {
    if (isUniqueViolation(e, 'import_templates_user_name_uq')) throw nameTaken();
    throw e;
  }
}

/** 删除模板；已导入的流水、导入历史不受影响（批次只记录模板 id 与版本） */
export async function deleteTemplate(db: Db, userId: string, id: string): Promise<void> {
  await getOwn(db, userId, id);
  await db.delete(importTemplates).where(eq(importTemplates.id, id));
}

/** 读取文件样本（不保存文件） */
export async function inspect(bytes: Uint8Array): Promise<InspectResponse> {
  if (bytes.length === 0) throw new AppError(400, 'IMPORT_EMPTY_FILE', '文件是空的');
  // 按文件头判断，PDF 不必读取内容
  if (sniffFileType(bytes) === 'pdf') {
    throw new AppError(400, 'TEMPLATE_PDF_UNSUPPORTED', 'PDF 账单暂不支持自定义模板，请导出 csv 或 xlsx 格式');
  }
  try {
    return await inspectFile(bytes);
  } catch (e) {
    throw new AppError(400, 'IMPORT_UNREADABLE', (e as Error).message);
  }
}

export interface TestInput {
  bytes: Uint8Array;
  fileName: string;
  /** 向导当前的配置（JSON 文本） */
  specJson: string | undefined;
  /** 修改已有模板时传入：识别判断时排除它自己 */
  templateId: string | undefined;
}

/** 试解析（不保存任何东西） */
export async function testTemplate(db: Db, userId: string, input: TestInput): Promise<TemplateTestResponse> {
  if (input.bytes.length === 0) throw new AppError(400, 'IMPORT_EMPTY_FILE', '文件是空的');
  let raw: unknown;
  try {
    raw = JSON.parse(input.specJson ?? '');
  } catch {
    throw new AppError(400, 'VALIDATION_FAILED', '模板配置不是合法的 JSON');
  }
  const spec = parseOrThrow(userTemplateSpecSchema, raw);
  const id = input.templateId ?? '00000000-0000-4000-8000-000000000000';
  const draft = compileOrThrow(spec, { id, name: '当前模板', version: 1 });
  const others = [...BUILTIN_TEMPLATES, ...(await loadUserTemplates(db, userId))].filter((t) => t.id !== id);
  try {
    return await trialParse(input.bytes, input.fileName, draft, others);
  } catch (e) {
    throw new AppError(400, 'IMPORT_UNREADABLE', (e as Error).message);
  }
}
