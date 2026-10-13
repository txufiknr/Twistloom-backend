import { describe, expect, it } from "bun:test";
import { planBroadcastQueue, type QueueEntry } from "../src/services/broadcast-scheduler.js";

const now = new Date(1_000_000);
const at = (offset: number) => new Date(now.getTime() + offset);
const row = (id: string, start: number, end: number, created: number): QueueEntry => ({ id, startsAt: at(start), expiresAt: at(end), createdAt: at(created) });

describe("single-slot queue planning", () => {
  it("cascades the entire suffix and retains duration, FIFO and both boundary gaps", () => {
    const planned = planBroadcastQueue([row("a", 20_000, 30_000, -3), row("b", 45_000, 55_000, -2), row("c", 70_000, 80_000, -1)], now,
      { startsAt: at(25_000), expiresAt: at(60_000) }, false, 8000);
    expect(planned.map(item => item.startsAt.getTime() - now.getTime())).toEqual([68_000, 86_000, 104_000]);
    expect(planned.every(item => item.expiresAt.getTime() - item.startsAt.getTime() === 10_000)).toBe(true);
  });
  it("preserves a live paid slot and compacts the rest in creation order", () => {
    const planned = planBroadcastQueue([row("b", 200_000, 210_000, -1), row("live", -5000, 5000, -3), row("a", 100_000, 110_000, -2)], now, null, true, 8000);
    expect(planned.map(item => [item.id, item.startsAt.getTime() - now.getTime()])).toEqual([["a", 13_000], ["b", 31_000]]);
  });
  it("requires the pre-banner gap even if a slot does not directly overlap", () => {
    const [planned] = planBroadcastQueue([row("a", 10_000, 20_000, -1)], now, { startsAt: at(25_000), expiresAt: at(30_000) }, false, 8000);
    expect(planned?.startsAt).toEqual(at(38_000));
  });
  it("allows slots before a scheduled banner and releases slots when it is shortened", () => {
    const planned = planBroadcastQueue([row("a", 100_000, 110_000, -2), row("b", 120_000, 130_000, -1)], now,
      { startsAt: at(40_000), expiresAt: at(50_000) }, true, 8000);
    expect(planned.map(item => item.startsAt.getTime() - now.getTime())).toEqual([0, 18_000]);
  });
  it("honors a just-ended banner gap without truncating a still-live ordinary slot", () => {
    const [planned] = planBroadcastQueue([row("live", -5000, 2000, -2), row("a", 100_000, 110_000, -1)], now, null, true, 8000, at(8000));
    expect(planned?.startsAt).toEqual(at(10_000));
  });
});
