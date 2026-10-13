import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Redis } from "@upstash/redis";
const store = new Map<string, string>();
const actualRedis = await import("../src/utils/redis.js");
const sdk = new Redis({ url: "https://redis.test", token: "test-only", enableAutoPipelining: false, retry: false });
mock.module("../src/utils/redis.js", () => ({ ...actualRedis, getRedisClient: () => sdk }));
const { readWindowCache, invalidateWindowCache } = await import("../src/utils/window-cache.js");
const fetch = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
  const command: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "null");
  if (!Array.isArray(command)) throw new Error("Invalid Redis command");
  const [operation, key] = command;
  if (operation === "get" && typeof key === "string") return Response.json({ result: store.get(key) ?? null });
  if (operation === "eval") {
    const [, script, , cacheKey, revisionKey, revision, value] = command;
    if (typeof script !== "string" || typeof cacheKey !== "string" || typeof revisionKey !== "string") throw new Error("Invalid script");
    if (script.includes("INCR")) { store.set(revisionKey, String(Number(store.get(revisionKey) ?? 0) + 1)); store.delete(cacheKey); }
    else if (Number(store.get(revisionKey) ?? 0) === Number(revision) && typeof value === "string") store.set(cacheKey, value);
    return Response.json({ result: "OK" });
  }
  throw new Error(`Unexpected Redis operation: ${String(operation)}`);
});
afterAll(() => { fetch.mockRestore(); mock.module("../src/utils/redis.js", () => actualRedis); });
beforeEach(() => store.clear());
const decode = (value: unknown) => typeof value === "string" ? value : undefined;
describe("SDK-compatible window cache", () => {
  it("caches explicit null without treating a Redis miss as a cached null", async () => {
    let loads = 0;
    const load = async () => { loads++; return null; };
    await readWindowCache("negative", 30, decode, load, () => []);
    await readWindowCache("negative", 30, decode, load, () => []);
    expect(loads).toBe(1);
  });
  it("accepts the SDK's decoded envelope and reloads at a lifecycle boundary", async () => {
    let loads = 0;
    const load = async () => { loads++; return "candidate"; };
    await readWindowCache("live", 30, decode, load, () => [Date.now() + 1000]);
    await readWindowCache("live", 30, decode, load, () => []);
    expect(loads).toBe(1);
    store.set("live", JSON.stringify({ version: 2, validUntil: Date.now() - 1, value: "expired" }));
    expect(await readWindowCache("live", 30, decode, load, () => [])).toBe("candidate");
    expect(loads).toBe(2);
  });
  it("cannot refill an older read across a committed invalidation", async () => {
    await readWindowCache("race", 30, decode, async () => { await invalidateWindowCache("race"); return "old"; }, () => []);
    expect(store.has("race")).toBe(false);
    expect(await readWindowCache("race", 30, decode, async () => "new", () => [])).toBe("new");
  });
  it("ignores malformed envelopes", async () => {
    store.set("bad", JSON.stringify({ version: 2, validUntil: Date.now() + 10000, value: { invalid: true } }));
    expect(await readWindowCache("bad", 30, decode, async () => "valid", () => [])).toBe("valid");
  });
});
