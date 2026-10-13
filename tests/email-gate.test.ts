import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
const actualRedis = await import("../src/utils/redis.js");
const actualRate = await import("@upstash/ratelimit");
let available = true;
let failRedis = false;
let cooldown = false;
let timeout = false;
let limited = false;
const buckets: string[] = [];
const redis = { eval: async () => {
  if (failRedis) throw new Error("Redis unavailable");
  return cooldown ? [0, Date.now() + 60_000, ""] : [1, 0, ""];
} };
class FakeRatelimit {
  prefix: string;
  constructor(options: { prefix?: string }) { this.prefix = options.prefix ?? ""; }
  static slidingWindow = actualRate.Ratelimit.slidingWindow;
  async limit() {
    buckets.push(this.prefix);
    return { success: !limited, reason: timeout ? "timeout" : undefined,
      reset: Date.now() + 1000, pending: Promise.resolve() };
  }
}
mock.module("../src/utils/redis.js", () => ({ ...actualRedis, getRedisClient: () => available ? redis : null }));
mock.module("@upstash/ratelimit", () => ({ ...actualRate, Ratelimit: FakeRatelimit }));
// A separate module instance isolates the cached rate objects from other suites.
const modulePath = "../src/services/email-gate.js?email-gate-security";
const { acquireEmailPermit }: typeof import("../src/services/email-gate.js") = await import(modulePath);
beforeEach(() => { available = true; failRedis = false; cooldown = false; timeout = false; limited = false; buckets.length = 0; });
afterAll(() => { mock.module("../src/utils/redis.js", () => actualRedis); mock.module("@upstash/ratelimit", () => actualRate); });
describe("shared provider admission", () => {
  it("defers when Redis is missing or fails", async () => {
    available = false; expect((await acquireEmailPermit(0)).allowed).toBe(false);
    available = true; failRedis = true; expect((await acquireEmailPermit(0)).allowed).toBe(false);
    expect(buckets).toHaveLength(0);
  });
  it("overrides SDK fail-open timeout responses", async () => {
    timeout = true; expect((await acquireEmailPermit(0)).allowed).toBe(false);
  });
  it("stops requests during an account cooldown", async () => {
    cooldown = true; expect((await acquireEmailPermit(0)).allowed).toBe(false); expect(buckets).toHaveLength(0);
  });
  it("gates bulk on both capacity buckets and urgent mail on the account bucket", async () => {
    expect((await acquireEmailPermit(2)).allowed).toBe(true);
    expect(buckets).toEqual(["email:bulk", "email:provider"]); buckets.length = 0;
    expect((await acquireEmailPermit(0)).allowed).toBe(true); expect(buckets).toEqual(["email:provider"]);
  });
  it("does not request account capacity after bulk admission is denied", async () => {
    limited = true; expect((await acquireEmailPermit(2)).allowed).toBe(false); expect(buckets).toEqual(["email:bulk"]);
  });
});
