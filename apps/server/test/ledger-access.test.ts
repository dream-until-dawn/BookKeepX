/**
 * 账本访问控制：成员 / 角色 / 非成员 / 不存在的账本
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ledgerMembers } from '../src/db/schema/index.ts';
import { LedgerForbiddenError, LedgerNotFoundError } from '../src/errors.ts';
import { type LedgerRole, requireLedgerAccess, roleSatisfies } from '../src/modules/ledgers/access.ts';
import { makeUser, truncateAll, useMigratedDatabase } from './db-helpers.ts';

const database = useMigratedDatabase();
beforeEach(() => truncateAll(database));

describe('roleSatisfies', () => {
  const cases: [LedgerRole, LedgerRole, boolean][] = [
    ['owner', 'owner', true],
    ['owner', 'viewer', true],
    ['editor', 'editor', true],
    ['editor', 'owner', false],
    ['viewer', 'viewer', true],
    ['viewer', 'editor', false],
  ];
  it.each(cases)('%s 满足 %s 要求 → %s', (actual, required, ok) => {
    expect(roleSatisfies(actual, required)).toBe(ok);
  });
});

describe('requireLedgerAccess', () => {
  it('正向：所有者访问自己的账本，得到带角色的 scope', async () => {
    const a = await makeUser(database);
    const scope = await requireLedgerAccess(database.db, a.id, a.defaultLedgerId, 'owner');
    expect(scope).toMatchObject({ ledgerId: a.defaultLedgerId, userId: a.id, role: 'owner' });
  });

  it('反向：非成员访问他人账本 → 404（不透露账本存在）', async () => {
    const a = await makeUser(database);
    const b = await makeUser(database);
    await expect(requireLedgerAccess(database.db, b.id, a.defaultLedgerId, 'viewer')).rejects.toBeInstanceOf(
      LedgerNotFoundError,
    );
  });

  it('反向：不存在的账本 → 与非成员相同的 404', async () => {
    const a = await makeUser(database);
    const err = await requireLedgerAccess(database.db, a.id, '00000000-0000-0000-0000-000000000000', 'viewer').catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(LedgerNotFoundError);
    expect(err.statusCode).toBe(404);
  });

  it('反向：只读成员尝试需要编辑权限的操作 → 403', async () => {
    const a = await makeUser(database);
    const b = await makeUser(database);
    await database.db.insert(ledgerMembers).values({ ledgerId: a.defaultLedgerId, userId: b.id, role: 'viewer' });
    await expect(requireLedgerAccess(database.db, b.id, a.defaultLedgerId, 'viewer')).resolves.toMatchObject({
      role: 'viewer',
    });
    const err = await requireLedgerAccess(database.db, b.id, a.defaultLedgerId, 'editor').catch((e) => e);
    expect(err).toBeInstanceOf(LedgerForbiddenError);
    expect(err.statusCode).toBe(403);
  });

  it('正向：编辑成员可以做编辑操作，但不能做所有者操作', async () => {
    const a = await makeUser(database);
    const b = await makeUser(database);
    await database.db.insert(ledgerMembers).values({ ledgerId: a.defaultLedgerId, userId: b.id, role: 'editor' });
    await expect(requireLedgerAccess(database.db, b.id, a.defaultLedgerId, 'editor')).resolves.toBeTruthy();
    await expect(requireLedgerAccess(database.db, b.id, a.defaultLedgerId, 'owner')).rejects.toBeInstanceOf(
      LedgerForbiddenError,
    );
  });
});
