import { describe, expect, it } from "bun:test";
import { BETA_DUTY_REGISTRY } from "../src/config/beta-duties.js";
import { summarizeBetaDuties } from "../src/services/beta-duties.js";
import type { UserBetaDutyState } from "../src/types/beta-duties.js";

describe("Beta Duties Registry & Summary Engine", () => {
  it("BETA_DUTY_REGISTRY contains exactly 5 duties summing to 500 credits", () => {
    expect(BETA_DUTY_REGISTRY).toHaveLength(5);

    const totalCredits = BETA_DUTY_REGISTRY.reduce((sum, d) => sum + d.rewardCredits, 0);
    expect(totalCredits).toBe(500);

    // Validate sequential ordering
    const orders = BETA_DUTY_REGISTRY.map((d) => d.order);
    expect(orders).toEqual([1, 2, 3, 4, 5]);

    // Validate expected IDs
    const ids = BETA_DUTY_REGISTRY.map((d) => d.id);
    expect(ids).toEqual([
      "bd_create_pen",
      "bd_publish_page",
      "bd_finish_writing",
      "bd_send_feedback",
      "bd_platform_testimony",
    ]);
  });

  it("summarizeBetaDuties accurately summarizes an empty or in-progress state", () => {
    const duties: UserBetaDutyState[] = BETA_DUTY_REGISTRY.map((rule) => ({
      id: rule.id,
      titleKey: rule.titleKey,
      descriptionKey: rule.descriptionKey,
      rewardCredits: rule.rewardCredits,
      status: "in_progress",
      completedAt: null,
      claimedAt: null,
      order: rule.order,
      iconName: rule.iconName,
    }));

    const summary = summarizeBetaDuties(duties);
    expect(summary.completed).toBe(0);
    expect(summary.claimable).toBe(0);
    expect(summary.unclaimedReward).toBe(0);
    expect(summary.totalReward).toBe(500);
    expect(summary.allDone).toBe(false);
  });

  it("summarizeBetaDuties correctly computes claimable and completed rewards", () => {
    const duties: UserBetaDutyState[] = BETA_DUTY_REGISTRY.map((rule) => {
      let status: "in_progress" | "completed" | "claimed" = "in_progress";
      if (rule.id === "bd_create_pen") status = "claimed"; // 100 claimed
      if (rule.id === "bd_publish_page") status = "completed"; // 100 claimable
      if (rule.id === "bd_send_feedback") status = "completed"; // 50 claimable

      return {
        id: rule.id,
        titleKey: rule.titleKey,
        descriptionKey: rule.descriptionKey,
        rewardCredits: rule.rewardCredits,
        status,
        completedAt: status !== "in_progress" ? new Date().toISOString() : null,
        claimedAt: status === "claimed" ? new Date().toISOString() : null,
        order: rule.order,
        iconName: rule.iconName,
      };
    });

    const summary = summarizeBetaDuties(duties);
    expect(summary.completed).toBe(3); // 1 claimed + 2 completed
    expect(summary.claimable).toBe(2); // 2 completed pending claim
    expect(summary.unclaimedReward).toBe(150); // 100 + 50
    expect(summary.totalReward).toBe(500);
    expect(summary.allDone).toBe(false);
  });

  it("summarizeBetaDuties marks allDone when all missions are completed or claimed", () => {
    const duties: UserBetaDutyState[] = BETA_DUTY_REGISTRY.map((rule) => ({
      id: rule.id,
      titleKey: rule.titleKey,
      descriptionKey: rule.descriptionKey,
      rewardCredits: rule.rewardCredits,
      status: "claimed",
      completedAt: new Date().toISOString(),
      claimedAt: new Date().toISOString(),
      order: rule.order,
      iconName: rule.iconName,
    }));

    const summary = summarizeBetaDuties(duties);
    expect(summary.completed).toBe(5);
    expect(summary.claimable).toBe(0);
    expect(summary.unclaimedReward).toBe(0);
    expect(summary.allDone).toBe(true);
  });

  it("each duty rule has valid metadata, positive reward, and expected actionPath", () => {
    const validIcons = new Set(["PenTool", "FileText", "CheckCircle2", "MessageSquare", "Sparkles"]);
    const seenIds = new Set<string>();

    for (const rule of BETA_DUTY_REGISTRY) {
      expect(seenIds.has(rule.id)).toBe(false);
      seenIds.add(rule.id);

      expect(rule.rewardCredits).toBeGreaterThan(0);
      expect(validIcons.has(rule.iconName)).toBe(true);
      expect(rule.titleKey.length).toBeGreaterThan(0);
      expect(rule.descriptionKey.length).toBeGreaterThan(0);

      if (["bd_create_pen", "bd_publish_page", "bd_finish_writing"].includes(rule.id)) {
        expect(rule.actionPath).toBe("/pen");
      }
    }
  });

  it("atomic reward calculation maps strictly to the provided duty IDs", () => {
    const rewardByDutyId = new Map(BETA_DUTY_REGISTRY.map((r) => [r.id, r.rewardCredits]));

    // Simulating atomic update returning 2 claimed duties
    const returnedDutyIds = ["bd_create_pen", "bd_platform_testimony"];
    const totalAward = returnedDutyIds.reduce((sum, id) => sum + (rewardByDutyId.get(id as any) ?? 0), 0);
    expect(totalAward).toBe(250); // 100 + 150

    // Simulating atomic update returning 0 claimed duties (empty / race condition)
    const emptyDutyIds: string[] = [];
    const emptyAward = emptyDutyIds.reduce((sum, id) => sum + (rewardByDutyId.get(id as any) ?? 0), 0);
    expect(emptyAward).toBe(0);
  });
});
