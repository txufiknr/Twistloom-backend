import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { AppEnv } from '../src/hono/env.js';
import { parseJsonBody } from '../src/middleware/body.js';

const id = '019a0000-0000-7000-8000-000000000001';
const referrerId = '019a0000-0000-7000-8000-000000000002';
const dialect = new PgDialect();
const state = { userId: id, username: 'new-user', name: 'New User', email: 'new@example.test',
  isNewUser: true, referrerId: null as string | null, passwordHash: 'secret-password-hash',
  tokenVersion: 9, bannedAt: null, tier: 'free', vipExpiresAt: null, imageUrl: 'custom-avatar',
  emailPreferences: { weeklyRecommendations: false, monthlyActivitySummary: false, productAnnouncements: false },
  inAppPreferences: null, privacyPreferences: null };
const trace: string[] = [];
let rewardAttempts = 0;
let failActivity = false;
let referrerVerified = true;
function select() {
  let params: unknown[] = [];
  const result = () => params.includes('eligible-referrer')
    ? [{ userId: referrerId, username: 'eligible-referrer', emailVerified: referrerVerified ? new Date() : null }]
    : [{ ...state }];
  const query = {
    from: () => query, leftJoin: () => query,
    where: (condition: SQL) => { params = dialect.sqlToQuery(condition).params; return query; },
    limit: () => ({ for: async () => { trace.push('lock'); return result(); },
      then: (resolve: (value: unknown[]) => void) => resolve(result()) }),
  };
  return query;
}
const primary = {
  select,
  transaction: async <T>(run: (tx: unknown) => Promise<T>) => run(primary),
  update: () => ({ set: (data: Record<string, unknown>) => ({ where: () => {
    const apply = () => {
      if ('referrerId' in data) {
        if (!state.isNewUser || state.referrerId) return [];
        trace.push('attribute-while-new');
      }
      if ('isNewUser' in data) trace.push('complete');
      Object.assign(state, data);
      return [{ ...state }];
    };
    return { returning: async () => apply(), then: (resolve: (value: unknown) => void) => resolve(apply()) };
  } }) }),
};
const actualDb = await import('../src/db/client.js');
const actualUser = await import('../src/services/user.js');
const actualController = await import('../src/services/user-controller.js');
const actualCache = await import('../src/services/cache.js');
const actualEmail = await import('../src/utils/email.js');
const actualAudit = await import('../src/utils/audit-log.js');
mock.module('../src/db/client.js', () => ({ ...actualDb, dbWrite: primary,
  dbRead: { select: () => { throw new Error('Onboarding used a replica'); } } }));
mock.module('../src/services/user.js', () => ({ ...actualUser,
  sanitizeProfileUpdate: async (_userId: string, body: { name?: string }) => ({ data: body, errorResponse: undefined }),
  updateUserLastActivity: async () => {},
  logUserActivity: async () => { if (failActivity) throw new Error('Test optional activity outage'); },
}));
mock.module('../src/services/user-controller.js', () => ({ ...actualController,
  tryAwardReferralBonus: async () => { rewardAttempts++; },
}));
mock.module('../src/services/cache.js', () => ({ ...actualCache, invalidateUserProfileCache: async () => {} }));
mock.module('../src/utils/email.js', () => ({ ...actualEmail, sendWelcomeEmail: async () => true }));
mock.module('../src/utils/audit-log.js', () => ({ ...actualAudit, logAuditEvent: async () => {} }));
const routerModule = '../src/routes/user.js?profile-onboarding-security';
const { default: router }: typeof import('../src/routes/user.js') = await import(routerModule);
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => { c.set('userId', id); await next(); });
app.use('*', parseJsonBody); app.route('/api/user', router);
const request = (method: string, body: object) => app.request('http://localhost/api/user', {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
beforeEach(() => {
  state.isNewUser = true; state.referrerId = null; state.name = 'New User';
  state.inAppPreferences = null; state.privacyPreferences = null;
  trace.length = 0; rewardAttempts = 0; failActivity = false; referrerVerified = true;
});
afterAll(() => {
  mock.module('../src/db/client.js', () => actualDb);
  mock.module('../src/services/user.js', () => actualUser);
  mock.module('../src/services/user-controller.js', () => actualController);
  mock.module('../src/services/cache.js', () => actualCache);
  mock.module('../src/utils/email.js', () => actualEmail);
  mock.module('../src/utils/audit-log.js', () => actualAudit);
});
describe('profile and canonical onboarding', () => {
  it('records eligible referral before completion under the same primary lock', async () => {
    const response = await request('POST', { referrer: 'eligible-referrer' });
    expect(response.status).toBe(200);
    expect(state.referrerId).toBe(referrerId);
    expect(trace.indexOf('attribute-while-new')).toBeLessThan(trace.indexOf('complete'));
    expect(trace[0]).toBe('lock');
    expect(state.isNewUser).toBe(false);
    expect(state.inAppPreferences).not.toBeNull();
    expect(state.privacyPreferences).not.toBeNull();
    expect(state.emailPreferences.weeklyRecommendations).toBe(false); // Explicit consent preserved.
  });
  it('repeat completion repairs defaults/retries reward without accepting late referral or profile writes', async () => {
    state.isNewUser = false;
    const response = await request('POST', { name: 'Late overwrite', referrer: 'eligible-referrer' });
    expect(response.status).toBe(200);
    expect(state.name).toBe('New User'); expect(state.referrerId).toBeNull();
    expect(state.inAppPreferences).not.toBeNull();
    expect(rewardAttempts).toBe(1);
  });
  it('optional activity failure cannot undo committed onboarding or fail its response', async () => {
    failActivity = true;
    expect((await request('POST', {})).status).toBe(200);
    expect(state.isNewUser).toBe(false);
  });
  it('unverified referrers cannot be attributed', async () => {
    referrerVerified = false;
    expect((await request('POST', { referrer: 'eligible-referrer' })).status).toBe(200);
    expect(state.referrerId).toBeNull();
  });
  it('PUT response has a safe allowlist even when RETURNING contains account secrets', async () => {
    const response = await request('PUT', { name: 'Updated' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user).toMatchObject({ id, name: 'Updated', subscription: { tier: 'free' } });
    for (const key of ['passwordHash', 'tokenVersion', 'bannedAt', 'referrerId']) expect(body.user).not.toHaveProperty(key);
    expect(state.isNewUser).toBe(true);
  });
});
