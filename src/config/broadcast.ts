/**
 * Configuration for the 📣 Megaphone / global broadcast system.
 *
 * Broadcasts are intentionally scarce and heavily rate-limited to keep the
 * global banner usable. Tuning knobs live here (with env overrides where noted)
 * so the limits can be adjusted without code changes.
 *
 * @see src/services/broadcast.ts for the orchestration logic
 * @see src/routes/broadcasts.ts for the HTTP surface
 */

import { CUSTOM_ACTION_SECURITY_PATTERNS } from "./custom-actions.js";
import type { BroadcastRejectReason } from "../types/broadcast.js";

// ── Length bounds (mirrors COMMENT/content max-length pattern) ──────────────

/** Minimum characters for a broadcast message (after sanitization). */
export const BROADCAST_MIN_LENGTH = 3;

/** Maximum characters for a broadcast message (hard cap; design target 140). */
export const BROADCAST_MAX_LENGTH = 140;

// ── Rate limits / scheduling ────────────────────────────────────────────────

/**
 * Per-user cooldown between broadcasts. One megaphone use per user per 5 minutes
 * regardless of queue position. Env-overridable: `BROADCAST_COOLDOWN_SECONDS`.
 */
export const BROADCAST_USER_COOLDOWN_SECONDS = Number.parseInt(
  process.env.BROADCAST_COOLDOWN_SECONDS || "300",
  10,
);

/**
 * Minimum spacing between consecutive live broadcasts globally. Enforces a
 * single live slot and a calm banner even if many users spend Megaphones at
 * once (they queue). Env-overridable: `BROADCAST_GLOBAL_INTERVAL_SECONDS`.
 */
export const BROADCAST_GLOBAL_INTERVAL_SECONDS = Number.parseInt(
  process.env.BROADCAST_GLOBAL_INTERVAL_SECONDS || "10",
  10,
);

/**
 * How long a single broadcast stays visible once live. Env-overridable:
 * `BROADCAST_DISPLAY_SECONDS`.
 */
export const BROADCAST_DISPLAY_SECONDS = Number.parseInt(
  process.env.BROADCAST_DISPLAY_SECONDS || "8",
  10,
);

/**
 * Maximum number of future-queued (not-yet-live) broadcasts allowed. Rejects
 * new submits with 429 when the queue is saturated, capping wait time and
 * preventing a broadcast storm from backing up for hours.
 */
export const BROADCAST_MAX_PENDING = 20;

/**
 * AI moderation call timeout. Broadcast moderation is raced against this so a
 * hung provider cannot block the submit request indefinitely. On timeout the
 * message is rejected safely (fail-closed) rather than silently approved.
 */
export const BROADCAST_MODERATION_TIMEOUT_MS = 15_000;

/**
 * Short Redis TTL for the cached "current broadcast" used by the public poll
 * endpoint. Keeps polling cheap without stale banners lingering.
 */
export const BROADCAST_CURRENT_CACHE_TTL_SECONDS = 3;

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Valid character pattern for a broadcast. Broader than custom actions: allows
 * Unicode letters/marks/numbers, punctuation, currency/math symbols, and emoji
 * (so usernames, hearts, and 📣-adjacent flair survive). Control characters and
 * zero-width code points are stripped by the sanitizer before this check.
 */
export const BROADCAST_VALID_TEXT_PATTERN =
  /^[\p{L}\p{M}\p{N}\p{P}\p{Sc}\p{Sm}\p{Extended_Pictographic}\p{So}\s]+$/u;

/**
 * Deterministic injection / abuse patterns. Extends the prompt-append pattern
 * set (covers prompt-injection attempts) with broadcast-specific link-spam and
 * @everyone-style mass-mention abuses.
 */
export const BROADCAST_SECURITY_PATTERNS: RegExp[] = [
  ...CUSTOM_ACTION_SECURITY_PATTERNS,

  // Bare URL / link spam (http(s)://, www., or t.co-style shorteners)
  /\bhttps?:\/\/\S+/i,
  /\bwww\.[a-z0-9-]+\.[a-z]{2,}\b/i,

  // Mass-mention abuse
  /@everyone\b/i,
  /@all\b/i,
  /(?:mass\s*mention|mention\s*all)/i,
];

/**
 * High-signal heuristic rejection patterns — the cheap "engine" that runs
 * BEFORE the (expensive) AI moderation call. Each entry maps directly to a
 * `BroadcastRejectReason` so the early-fail can surface a specific reason
 * without spending an AI token.
 *
 * These are intentionally narrow and unambiguous (clear self-harm
 * encouragement, obvious scam/phishing framing). Anything nuanced — hate
 * dogwhistles, contextual harassment, sexual implication — is deliberately
 * LEFT to the AI pass, which is the last-resort semantic judge. Keep this list
 * conservative: false positives here block legitimate broadcasts for free.
 */
export const BROADCAST_HEURISTIC_PATTERNS: { pattern: RegExp; reason: BroadcastRejectReason }[] = [
  // Unambiguous self-harm encouragement (high-signal directives)
  { pattern: /\b(kys|kms|kill\s+yourself|kill\s+yrself|end\s+it\s+all\s+now)\b/i, reason: "self_harm" },

  // Obvious scam / phishing framing
  { pattern: /\b(free\s*(?:crypto|btc|eth)\s*(?:giveaway|airdrop))\b/i, reason: "scam" },
  { pattern: /\b(?:dm|message)\s+(?:me|us)\s+(?:to|for)\s+(?:earn|win|get\s+cash|free\s+money)\b/i, reason: "scam" },
  { pattern: /\b(claim\s+your\s+(?:reward|prize|gift)\s+(?:now|today))\b/i, reason: "scam" },
];
