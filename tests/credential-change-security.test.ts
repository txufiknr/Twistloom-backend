import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { getTableName } from 'drizzle-orm';
import type { AppEnv } from '../src/hono/env.js';
import { parseJsonBody } from '../src/middleware/body.js';

const id = '019a0000-0000-7000-8000-000000000001';
let hash = 'current-hash';
let sessions = 2;
let familiesRevoked = false;
let failRevocation = false;
let race = false;
let failNotification = false;
let failAudit = false;
const primary = {
  select: (fields: Record<string, unknown>) => {
    const result = async () => {
      if (fields.email && failNotification) throw new Error('Optional post-commit lookup failed');
      return [{ passwordHash: hash, email: 'user@example.test', name: 'User' }];
    };
    return { from: () => ({ where: () => ({ limit: () => ({ then: (resolve: (value: unknown) => void, reject: (error: unknown) => void) => result().then(resolve, reject), for: result, catch: (handler: (error: unknown) => unknown) => result().catch(handler) }) }) }) };
  },
  update: (table: Parameters<typeof getTableName>[0]) => ({ set: (data: Record<string, unknown>) => ({ where: async () => {
    if (getTableName(table) === 'refresh_families') {
      if (failRevocation) throw new Error('Required revocation failed');
      familiesRevoked = true;
    }
    if (typeof data.passwordHash === 'string') hash = data.passwordHash;
    return { rowCount: 1 };
  } }) }),
  delete: () => ({ where: async () => { sessions = 0; } }),
  transaction: async <T>(run: (tx: unknown) => Promise<T>) => {
    const old = { hash, sessions, familiesRevoked };
    try { return await run(primary); }
    catch (error) { hash = old.hash; sessions = old.sessions; familiesRevoked = old.familiesRevoked; throw error; }
  },
};
const actualDb = await import('../src/db/client.js');
const actualPassword = await import('../src/utils/password.js');
const actualRate = await import('../src/middleware/rate-limit.js');
const actualEmail = await import('../src/utils/email.js');
const actualAudit = await import('../src/utils/audit-log.js');
mock.module('../src/db/client.js', () => ({ ...actualDb, dbWrite: primary,
  dbRead: { select: () => { throw new Error('Credential change used a replica'); } } }));
mock.module('../src/utils/password.js', () => ({ ...actualPassword,
  verifyPassword: async (password: string, proof: string) => password === 'Current!Pass123' && proof === 'current-hash',
  hashPassword: async () => { if (race) hash = 'concurrent-reset-hash'; return 'next-hash'; },
}));
mock.module('../src/middleware/rate-limit.js', () => ({ ...actualRate, checkRateLimitByIP: async () => true }));
mock.module('../src/utils/email.js', () => ({ ...actualEmail, sendEmailSafe: () => {} }));
mock.module('../src/utils/audit-log.js', () => ({ ...actualAudit,
  logAuditEvent: async () => { if (failAudit) throw new Error('Optional audit failed'); },
}));
const routeUrl = '../src/routes/auth.js?credential-change-security';
const { default: router }: typeof import('../src/routes/auth.js') = await import(routeUrl);
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => { c.set('userId', id); await next(); });
app.use('*', parseJsonBody); app.route('/api/auth', router);
const change = () => app.request('http://localhost/api/auth/password', { method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ currentPassword: 'Current!Pass123', newPassword: 'Sup3r!SecretPass!' }),
});
beforeEach(() => { hash = 'current-hash'; sessions = 2; familiesRevoked = false;
  failRevocation = false; race = false; failNotification = false; failAudit = false; });
afterAll(() => {
  mock.module('../src/db/client.js', () => actualDb);
  mock.module('../src/utils/password.js', () => actualPassword);
  mock.module('../src/middleware/rate-limit.js', () => actualRate);
  mock.module('../src/utils/email.js', () => actualEmail);
  mock.module('../src/utils/audit-log.js', () => actualAudit);
});
describe('credential change transaction and response', () => {
  it('removes all tracked sessions despite optional notification/audit outage after commit', async () => {
    failNotification = true; failAudit = true;
    expect((await change()).status).toBe(200);
    expect(hash).toBe('next-hash'); expect(sessions).toBe(0); expect(familiesRevoked).toBe(true);
  });
  it('rolls back password and sessions if required revocation fails', async () => {
    failRevocation = true;
    expect((await change()).status).toBe(500);
    expect(hash).toBe('current-hash'); expect(sessions).toBe(2); expect(familiesRevoked).toBe(false);
  });
  it('does not overwrite a concurrent reset with a previously verified password', async () => {
    race = true;
    expect((await change()).status).toBe(500);
    expect(hash).toBe('concurrent-reset-hash'); expect(sessions).toBe(2);
  });
});
