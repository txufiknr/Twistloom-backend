import { afterAll, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { AppEnv } from '../src/hono/env.js';
import { getClientIp } from '../src/hono/express-shim.js';
import { SignJWT } from 'jose';

const actualRedis = await import('../src/utils/redis.js');
const actualDb = await import('../src/db/client.js');
const calls: { key: string; maxRequests: number }[] = [];
let failLimiter = false;
mock.module('../src/utils/redis.js', () => ({ ...actualRedis, checkRateLimit: async (key: string, config: { maxRequests: number }) => {
  if (failLimiter) throw new Error('Test Redis outage');
  calls.push({ key, maxRequests: config.maxRequests });
  return { allowed: true, requestCount: 1 };
} }));
let updates = 0;
let values: Record<string, unknown> = {};
const locked = { failedLoginAttempts: 9, lockUntil: new Date(0) };
const primary = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [locked] }) }) }),
  update: () => ({ set: (data: Record<string, unknown>) => { values = data;
    return { where: async () => { updates++; } }; } }),
};
mock.module('../src/db/client.js', () => ({ ...actualDb, dbWrite: primary,
  dbRead: { select: () => { throw new Error('Lockout used replica'); } } }));
const controlModule = '../src/services/web-control.js?auth-abuse-control';
const { readWebControl, isWebExchange, allowWebExchange }: typeof import('../src/services/web-control.js') = await import(controlModule);
const lockoutModule = '../src/utils/account-lockout.js?auth-abuse-control';
const { checkAccountLockout, recordFailedLogin }: typeof import('../src/utils/account-lockout.js') = await import(lockoutModule);
const originalSecret = process.env.AUTH_SECRET;
const originalProxy = process.env.TRUST_PROXY_HEADERS;
process.env.AUTH_SECRET = 'abuse-control-test-secret-at-least-32chars';
const key = new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode('twistloom:web-control:v1:' + process.env.AUTH_SECRET)));
afterAll(() => {
  mock.module('../src/utils/redis.js', () => actualRedis); mock.module('../src/db/client.js', () => actualDb);
  if (originalSecret === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = originalSecret;
  if (originalProxy === undefined) delete process.env.TRUST_PROXY_HEADERS; else process.env.TRUST_PROXY_HEADERS = originalProxy;
});
describe('distributed auth admission and primary lockout', () => {
  it('ignores forged forwarding headers when provider context supplies the source address', async () => {
    delete process.env.TRUST_PROXY_HEADERS;
    const app = new Hono<AppEnv>(); app.get('/', c => c.json({ ip: getClientIp(c) }));
    const init = { headers: { 'X-Forwarded-For': 'attacker-chosen-ip' } };
    expect(await (await app.request('/', init, { trustedClientIp: 'provider-owned-ip' })).json()).toEqual({ ip: 'provider-owned-ip' });
    expect(await (await app.request('/', init)).json()).toEqual({ ip: 'unknown' });
  });
  it('an exchange attestation is purpose/body-bound and expires within one minute', async () => {
    const body = { emailOrUsername: 'User', password: 'test-password' };
    const bodyHash = await actualRedisHash(JSON.stringify(body));
    const proof = await new SignJWT({ purpose: 'exchange', bodyHash }).setProtectedHeader({ alg: 'HS256' })
      .setIssuer('twistloom-web').setAudience('twistloom-web-control').setIssuedAt().setExpirationTime('60s').sign(key);
    expect(await isWebExchange(proof, body)).toBe(true);
    expect(await isWebExchange(proof, { ...body, password: 'tampered' })).toBe(false);
    expect(await readWebControl(proof, 'revoke')).toBeNull();
    const expired = await new SignJWT({ purpose: 'exchange', bodyHash }).setProtectedHeader({ alg: 'HS256' })
      .setIssuer('twistloom-web').setAudience('twistloom-web-control').setIssuedAt(Math.floor(Date.now() / 1000) - 70)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10).sign(key);
    expect(await isWebExchange(expired, body)).toBe(false);
    calls.length = 0;
    expect(await allowWebExchange(proof, body, 'User', 'web-egress')).toBe(true);
    expect(calls.map(call => call.maxRequests)).toEqual([300, 5]);
    expect(calls[1].key).not.toContain('User');
    expect(await allowWebExchange('forged', body, 'User', 'web-egress')).toBeNull();
    failLimiter = true;
    expect(await allowWebExchange(proof, body, 'User', 'web-egress')).toBe(true);
    failLimiter = false;
  });
  it('expired lockout retains escalation count without a read-side mutation', async () => {
    updates = 0;
    expect(await checkAccountLockout('user')).toEqual({ isLocked: false, attempts: 9 });
    expect(updates).toBe(0);
  });
  it('writes one atomic primary counter with descending thresholds and a reset window', async () => {
    updates = 0;
    await recordFailedLogin('user');
    expect(updates).toBe(1);
    const dialect = new PgDialect();
    const counter = dialect.sqlToQuery(values.failedLoginAttempts as SQL).sql;
    const escalation = dialect.sqlToQuery(values.lockUntil as SQL).sql;
    expect(counter).toContain('coalesce('); expect(counter).toContain('+ 1');
    expect(counter).toContain("interval '24 hours'");
    expect(escalation.indexOf('>= 15')).toBeLessThan(escalation.indexOf('>= 10'));
    expect(escalation.indexOf('>= 10')).toBeLessThan(escalation.indexOf('>= 5'));
    // PostgreSQL concurrency/real timestamps still require the private DB harness.
  });
});
async function actualRedisHash(value: string) {
  const { hashSHA256 } = await import('../src/utils/hash.js'); return hashSHA256(value);
}
