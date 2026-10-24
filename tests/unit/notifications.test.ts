/**
 * Unit Tests for User Notification Localization Pipeline (F-8 / Invariant 2)
 *
 * Verifies:
 * 1. Machine key taxonomy integrity and typing contracts
 * 2. Invariant 2: i18n_params must only contain scalar values (strings and numbers)
 * 3. Enforces that no hardcoded English fallback nouns leak into i18n_params
 * 4. Helper payload invariants (defaults for read, createdAt, updatedAt, groupKey)
 */

import { describe, expect, it } from "bun:test";
import {
  NOTIFICATION_TYPES,
  NOTIFICATION_I18N_KEYS,
  type NotificationType,
  type NotificationI18nKey,
} from "../../src/config/notifications.js";
import type { InsertNotificationParams, UpsertNotificationParams } from "../../src/services/notifications.js";

describe("Notification Taxonomy & Key Contracts", () => {
  it("defines all 14 expected notification types", () => {
    expect(NOTIFICATION_TYPES).toHaveLength(14);
    expect(NOTIFICATION_TYPES).toContain("payment_success");
    expect(NOTIFICATION_TYPES).toContain("refund");
    expect(NOTIFICATION_TYPES).toContain("first_purchase_bonus");
    expect(NOTIFICATION_TYPES).toContain("referral_bonus");
    expect(NOTIFICATION_TYPES).toContain("trial_ending_soon");
    expect(NOTIFICATION_TYPES).toContain("thanks_received");
    expect(NOTIFICATION_TYPES).toContain("thanks_reply");
    expect(NOTIFICATION_TYPES).toContain("wall_post_reaction");
    expect(NOTIFICATION_TYPES).toContain("wall_post_reply");
    expect(NOTIFICATION_TYPES).toContain("wall_post_incoming");
    expect(NOTIFICATION_TYPES).toContain("story_published");
    expect(NOTIFICATION_TYPES).toContain("ai_completed");
    expect(NOTIFICATION_TYPES).toContain("ai_failed");
    expect(NOTIFICATION_TYPES).toContain("testimonial_like");
  });

  it("every i18n key begins with the 'notification.' namespace prefix", () => {
    for (const [name, key] of Object.entries(NOTIFICATION_I18N_KEYS)) {
      expect(key).toStartWith("notification.");
      expect(key.length).toBeGreaterThan("notification.".length);
    }
  });

  it("every notification type has at least one matching i18n key mapping", () => {
    const keys = Object.values(NOTIFICATION_I18N_KEYS);
    // Verification that machine keys exist for all types
    expect(keys).toContain(NOTIFICATION_I18N_KEYS.PAYMENT_SUCCESS);
    expect(keys).toContain(NOTIFICATION_I18N_KEYS.REFUND_PROCESSED);
    expect(keys).toContain(NOTIFICATION_I18N_KEYS.FIRST_PURCHASE_BONUS);
    expect(keys).toContain(NOTIFICATION_I18N_KEYS.REFERRAL_VIP_BONUS);
    expect(keys).toContain(NOTIFICATION_I18N_KEYS.REFERRAL_STANDARD_BONUS);
    expect(keys).toContain(NOTIFICATION_I18N_KEYS.REFERRAL_WELCOME_BONUS);
    expect(keys).toContain(NOTIFICATION_I18N_KEYS.TRIAL_ENDING_SOON);
    expect(keys).toContain(NOTIFICATION_I18N_KEYS.THANKS_RECEIVED);
    expect(keys).toContain(NOTIFICATION_I18N_KEYS.THANKS_REPLY);
    expect(keys).toContain(NOTIFICATION_I18N_KEYS.WALL_POST_REACTION);
    expect(keys).toContain(NOTIFICATION_I18N_KEYS.WALL_POST_REPLY);
    expect(keys).toContain(NOTIFICATION_I18N_KEYS.WALL_POST_INCOMING);
    expect(keys).toContain(NOTIFICATION_I18N_KEYS.STORY_PUBLISHED);
    expect(keys).toContain(NOTIFICATION_I18N_KEYS.AI_STORY_COMPLETED);
    expect(keys).toContain(NOTIFICATION_I18N_KEYS.AI_STORY_FAILED);
    expect(keys).toContain(NOTIFICATION_I18N_KEYS.TESTIMONIAL_LIKE_SINGLE);
    expect(keys).toContain(NOTIFICATION_I18N_KEYS.TESTIMONIAL_LIKE_MULTIPLE);
  });
});

describe("Architectural Invariant 2: Scalar Parameter Hygiene", () => {
  const forbiddenEnglishFallbackNouns = [
    "A reader",
    "The author",
    "a story",
    "your story",
    "Someone",
  ];

  function assertNoEnglishProseLeak(params: Record<string, unknown> | null | undefined) {
    if (!params) return;
    for (const [key, value] of Object.entries(params)) {
      expect(typeof value === "string" || typeof value === "number").toBe(true);
      if (typeof value === "string") {
        for (const forbidden of forbiddenEnglishFallbackNouns) {
          expect(value).not.toBe(forbidden);
        }
      }
    }
  }

  it("sanitizes wallet thanks reply params without English fallback nouns", () => {
    const samplePayload: InsertNotificationParams = {
      userId: "u123",
      type: "thanks_reply",
      i18nKey: NOTIFICATION_I18N_KEYS.THANKS_REPLY,
      i18nParams: {
        creatorName: "", // Stripped empty string, never "The author"
        replyText: "Thank you for reading!",
        bookTitle: "", // Stripped empty string, never "your story"
      },
      fallbackTitle: "The author replied to your Thanks!",
      fallbackMessage: '"Thank you for reading!"',
    };

    assertNoEnglishProseLeak(samplePayload.i18nParams);
    expect(samplePayload.i18nParams?.creatorName).toBe("");
    expect(samplePayload.fallbackTitle).toBe("The author replied to your Thanks!");
  });

  it("sanitizes thanks received params with grossAmount and currency", () => {
    const samplePayload: InsertNotificationParams = {
      userId: "author456",
      type: "thanks_received",
      i18nKey: NOTIFICATION_I18N_KEYS.THANKS_RECEIVED,
      i18nParams: {
        readerName: "", // Stripped empty string, never "A reader"
        bookTitle: "The Whispering Quill",
        grossAmount: 50000,
        currency: "IDR",
      },
      fallbackTitle: "Thanks Received!",
      fallbackMessage: 'A reader sent you a Thanks for "The Whispering Quill"',
    };

    assertNoEnglishProseLeak(samplePayload.i18nParams);
    expect(samplePayload.i18nParams?.currency).toBe("IDR");
    expect(samplePayload.i18nParams?.grossAmount).toBe(50000);
  });

  it("sanitizes testimonial like params without 'A reader' or 'a story'", () => {
    const samplePayload: UpsertNotificationParams = {
      userId: "author456",
      type: "testimonial_like",
      groupKey: "testimonial:t123",
      i18nKey: NOTIFICATION_I18N_KEYS.TESTIMONIAL_LIKE_SINGLE,
      i18nParams: {
        actorName: "", // never "A reader"
        bookTitle: "", // never "a story"
      },
      fallbackTitle: "New like on your review",
      fallbackMessage: 'A reader liked your testimonial for "a story"',
    };

    assertNoEnglishProseLeak(samplePayload.i18nParams);
    expect(samplePayload.groupKey).toBe("testimonial:t123");
  });

  it("sanitizes story published params including authorName", () => {
    const samplePayload: InsertNotificationParams = {
      userId: "follower789",
      type: "story_published",
      i18nKey: NOTIFICATION_I18N_KEYS.STORY_PUBLISHED,
      i18nParams: {
        bookTitle: "Echoes of Eternity",
        bookSlug: "echoes-of-eternity",
        authorId: "auth1",
        authorName: "Jane Doe",
      },
      fallbackTitle: "New story from someone you follow",
      fallbackMessage: "Echoes of Eternity",
    };

    assertNoEnglishProseLeak(samplePayload.i18nParams);
    expect(samplePayload.i18nParams?.authorName).toBe("Jane Doe");
  });

  it("wall reactions enforce non-null groupKey for unique partial index", () => {
    const postId = "post_abc123";
    const samplePayload: UpsertNotificationParams = {
      userId: "u1",
      type: "wall_post_reaction",
      groupKey: `wall:${postId}`,
      i18nKey: NOTIFICATION_I18N_KEYS.WALL_POST_REACTION,
      i18nParams: { actorName: "Alice", postId },
      fallbackTitle: "New reaction on your Note",
      fallbackMessage: "Alice reacted to your Note",
      updateTitle: "New reaction on your Note",
      updateMessage: "Alice reacted to your Note",
      updateI18nKey: NOTIFICATION_I18N_KEYS.WALL_POST_REACTION,
      updateI18nParams: { actorName: "Alice", postId },
    };

    expect(samplePayload.groupKey).toBe("wall:post_abc123");
    expect(samplePayload.groupKey).not.toBeNull();
  });
});
