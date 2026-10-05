import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { users, userAuth, authSessions } from '../src/db/schema.js';

const userId = '019a0000-0000-7000-8000-000000000001';
const otherId = '019a0000-0000-7000-8000-000000000002';
const originalSecret = process.env.AUTH_SECRET;
process.env.AUTH_SECRET = 'recovery-security-local-only-secret-32chars';
const dialect = new PgDialect();
type Proof = { userId: string; emailVerificationToken?: string | null; emailVerificationExpires?: Date | null;
  passwordResetToken?: string | null; passwordResetExpires?: Date | null };
const proofs = new Map<string, Proof>();
const accounts = new Map([[userId, 'one@example.test'], [otherId, 'two@example.test']]);
let passwordWrites: unknown[] = [];
let sessionsDeleted = 0;
let familiesRevoked = 0;
let tail = Promise.resolve();
let expireDuringHash = false;
let familyFailure = false;

function select() {
  let table: unknown;
  let params: unknown[] = [];
  const query = {
    from: (value: unknown) => { table = value; return query; },
    innerJoin: () => query,
    where: (where: SQL) => { params = dialect.sqlToQuery(where).params; return query; },
    limit: () => ({
      then: (resolve: (value: unknown[]) => void) => resolve(rows()),
      for: async () => rows(),
    }),
  };
  const rows = () => {
    if (table === users) {
      const account = [...accounts].find(([id, email]) => params.includes(id) || params.includes(email));
      return account ? [{ userId: account[0], id: account[0] }] : [];
    }
    const byEmail = [...accounts].find(([, email]) => params.includes(email));
    if (byEmail) return proofs.has(byEmail[0]) ? [proofs.get(byEmail[0])!] : [];
    return [...proofs.values()].filter(row => Boolean(row.passwordResetToken && params.includes(row.passwordResetToken)
      && row.passwordResetExpires && row.passwordResetExpires > new Date()));
  };
  return query;
}

const primary = {
  select,
  insert: () => ({ values: (row: Proof) => ({ onConflictDoUpdate: async () => {
    proofs.set(row.userId, { ...proofs.get(row.userId), ...row });
  } }) }),
  update: (table: unknown) => ({ set: (data: Record<string, unknown>) => ({ where: (condition: SQL) => {
    const compiled = dialect.sqlToQuery(condition);
    const apply = () => {
      if (table === users) { passwordWrites.push(data); return []; }
      const row = proofs.get(String(compiled.params[0]));
      if (!row) return [];
      const reset = compiled.sql.includes('password_reset_token');
      const token = reset ? row.passwordResetToken : row.emailVerificationToken;
      const expiry = reset ? row.passwordResetExpires : row.emailVerificationExpires;
      if (!token || !compiled.params.includes(token) || !expiry || expiry <= new Date()) return [];
      Object.assign(row, data);
      return [{ userId: row.userId }];
    };
    return { returning: async () => apply(), then: (resolve: (value: { rowCount: number }) => void) => {
      const result = apply(); resolve({ rowCount: table === users ? 1 : result.length });
    } };
  } }) }),
  delete: (table: unknown) => ({ where: async () => { if (table === authSessions) sessionsDeleted++; } }),
  transaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => {
    // Model the primary user-row lock. This is not a real PostgreSQL race test.
    const previous = tail;
    let release: () => void = () => {};
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const snapshot = new Map([...proofs].map(([key, row]) => [key, { ...row }]));
    const writes = passwordWrites.length;
    try { return await run(primary); }
    catch (error) { proofs.clear(); for (const [key, row] of snapshot) proofs.set(key, row); passwordWrites.length = writes; throw error; }
    finally { release(); }
  },
};
const actualDb = await import('../src/db/client.js');
const actualPassword = await import('../src/utils/password.js');
const actualFamilies = await import('../src/services/token-family.js');
mock.module('../src/db/client.js', () => ({ ...actualDb, dbWrite: primary,
  dbRead: { select: () => { throw new Error('Recovery proof used replica'); } } }));
mock.module('../src/utils/password.js', () => ({ ...actualPassword, hashPassword: async (password: string) => {
  if (expireDuringHash) proofs.get(userId)!.passwordResetExpires = new Date(0);
  return 'hash:' + password;
} }));
mock.module('../src/services/token-family.js', () => ({ ...actualFamilies, revokeAllFamiliesForUser: async () => {
  if (familyFailure) throw new Error('Test revocation outage');
  familiesRevoked++;
} }));
const resetModule = '../src/utils/password-reset.js?recovery-proof-security';
const { createPasswordResetToken, resetPassword, verifyPasswordResetToken }: typeof import('../src/utils/password-reset.js') = await import(resetModule);
const verificationModule = '../src/utils/email-verification.js?recovery-proof-security';
const { createEmailVerificationToken, verifyEmailToken }: typeof import('../src/utils/email-verification.js') = await import(verificationModule);

beforeEach(() => { proofs.clear(); passwordWrites = []; sessionsDeleted = 0; familiesRevoked = 0;
  expireDuringHash = false; familyFailure = false; });
afterAll(() => {
  mock.module('../src/db/client.js', () => actualDb);
  mock.module('../src/utils/password.js', () => actualPassword);
  mock.module('../src/services/token-family.js', () => actualFamilies);
  if (originalSecret === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = originalSecret;
});

describe('recovery proof boundaries', () => {
  it('stores only a digest and never accepts that digest as a reset secret', async () => {
    const token = await createPasswordResetToken('one@example.test');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const stored = proofs.get(userId)!.passwordResetToken!;
    expect(stored).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(stored).not.toContain(token!);
    expect(await verifyPasswordResetToken(stored)).toBeNull();
    expect(await resetPassword(stored, 'attacker')).toBe(false);
    expect(passwordWrites).toHaveLength(0);
  });
  it('consumes one proof before mutation; a concurrent losing reset has no effects', async () => {
    const token = (await createPasswordResetToken('one@example.test'))!;
    const results = await Promise.all([resetPassword(token, 'first'), resetPassword(token, 'second')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(passwordWrites).toHaveLength(1);
    expect(familiesRevoked).toBe(1);
    expect(sessionsDeleted).toBe(1);
    expect(await resetPassword(token, 'third')).toBe(false);
    expect(passwordWrites).toHaveLength(1);
  });
  it('rechecks expiry after password hashing, before any credential mutation', async () => {
    const token = (await createPasswordResetToken('one@example.test'))!;
    expireDuringHash = true;
    expect(await resetPassword(token, 'too-late')).toBe(false);
    expect(passwordWrites).toHaveLength(0);
    expect(sessionsDeleted).toBe(0);
  });
  it('rolls back proof/password changes if credential revocation fails', async () => {
    const token = (await createPasswordResetToken('one@example.test'))!;
    familyFailure = true;
    await expect(resetPassword(token, 'new-password')).rejects.toThrow('Test revocation outage');
    expect(passwordWrites).toHaveLength(0);
    expect(await verifyPasswordResetToken(token)).toBe(userId);
  });
  it('a resend replaces the reset proof while legacy UUID proofs remain redeemable once', async () => {
    const old = (await createPasswordResetToken('one@example.test'))!;
    const current = (await createPasswordResetToken('one@example.test'))!;
    expect(await resetPassword(old, 'old')).toBe(false);
    expect(await resetPassword(current, 'new')).toBe(true);
    const legacy = crypto.randomUUID();
    proofs.set(userId, { userId, passwordResetToken: legacy, passwordResetExpires: new Date(Date.now() + 60000) });
    expect(await resetPassword(legacy, 'legacy')).toBe(true);
    expect(await resetPassword(legacy, 'again')).toBe(false);
  });
  it('binds a cryptographic six-digit OTP to an email/account and consumes it once', async () => {
    const token = await createEmailVerificationToken(userId);
    await createEmailVerificationToken(otherId);
    expect(token).toMatch(/^\d{6}$/);
    expect(proofs.get(userId)!.emailVerificationToken).toMatch(/^hmac:[0-9a-f]{64}$/);
    expect(proofs.get(userId)!.emailVerificationExpires!.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60000);
    // Test wrong account independently of the rare randomly-equal-code case.
    proofs.get(otherId)!.emailVerificationToken = 'different-account-proof';
    expect(await verifyEmailToken(token, 'two@example.test')).toBeNull();
    expect(await verifyEmailToken(token, 'one@example.test')).toBe(userId);
    expect(await verifyEmailToken(token, 'one@example.test')).toBeNull();
  });
  it('retires unscoped legacy OTPs and rejects expired scoped proof', async () => {
    proofs.set(userId, { userId, emailVerificationToken: '123456', emailVerificationExpires: new Date(Date.now() + 60000) });
    expect(await verifyEmailToken('123456', 'one@example.test')).toBeNull();
    const token = await createEmailVerificationToken(userId);
    proofs.get(userId)!.emailVerificationExpires = new Date(0);
    expect(await verifyEmailToken(token, 'one@example.test')).toBeNull();
  });
});
