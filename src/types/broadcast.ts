/**
 * Broadcast / 📣 Megaphone system types.
 *
 * A broadcast is a short, globally-visible banner message a user can send after
 * spending a 📣 Megaphone consumable (purchased with credits). Messages pass a
 * deterministic security gate plus an AI moderation pass before being scheduled
 * into a FIFO queue with a single live slot.
 */

/**
 * Kinds of consumable items a user can own in `user_inventory`.
 * Mirrors the `type` field of {@link ConsumableItemDefinition} in the
 * consumables registry (`src/config/consumables.ts`). Adding a new purchasable
 * item means adding it here AND in the registry.
 */
export type InventoryItemType = "megaphone";

/** Origin of a broadcast — users pay; the system can emit events for free. */
export type BroadcastSource = "user" | "system";

/** Broadcast content kind. V1 ships `message` only; richer kinds are future. */
export type BroadcastType = "message";

/**
 * Lifecycle status of a broadcast row.
 * - `queued`   — approved and scheduled (live when `startsAt <= now < expiresAt`)
 * - `rejected`  — blocked by moderation (never displayed)
 * - `cancelled` — taken down by a moderator / reporter action
 * - `expired`   — display window elapsed (lazy-set, never re-displayed)
 */
export type BroadcastStatus = "queued" | "rejected" | "cancelled" | "expired";

/** Why a broadcast was rejected by AI moderation. */
export type BroadcastRejectReason =
  | "harassment"
  | "sexual"
  | "hate"
  | "scam"
  | "spam"
  | "self_harm"
  | "illegal"
  | "injection"
  | "policy"
  | "other";

/**
 * Structured AI moderation verdict for a broadcast message.
 * Produced by a single JSON-mode classification call; `outcome` drives whether
 * the Megaphone is consumed.
 */
export type BroadcastModerationResult = {
  /** `approve` → schedule & consume item; `reject` → drop & refund item. */
  outcome: "approve" | "reject";
  /** Present only when `outcome === 'reject'`. */
  rejectionReason?: BroadcastRejectReason;
  /** Short internal reasons (never shown verbatim to the user). */
  reasons: string[];
  /** ISO 639-1 language code of the message, for analytics. */
  language?: string;
};

/** Public-facing broadcast payload returned to clients (no internal metadata). */
export interface PublicBroadcast {
  id: string;
  userId: string;
  username: string;
  message: string;
  source: BroadcastSource;
  containsSpoiler: boolean;
  startsAt: string;
  expiresAt: string;
}

/** Result of a preview/submit moderation pass, shaped for the client. */
export interface BroadcastModerationResponse {
  outcome: "approve" | "reject";
  rejectionReason?: BroadcastRejectReason;
  /** User-safe message shown when rejected. */
  message?: string;
  /** Disposable preview of the sanitized text (preview only). */
  preview?: {
    message: string;
  };
}

/** State summary for the authenticated owner (composer gating). */
export interface BroadcastOwnerState {
  megaphones: number;
  /** Seconds remaining before this user may broadcast again (0 = ready). */
  cooldownRemainingSeconds: number;
  /** True when the global broadcast queue is at capacity. */
  queueFull: boolean;
}

/** Admin/owner response after a successful submit. */
export interface BroadcastSubmitResponse {
  id: string;
  message: string;
  containsSpoiler: boolean;
  /** 1-based position in the broadcast queue (1 = next to go live). */
  queuePosition: number;
  startsAt: string;
  expiresAt: string;
  megaphonesRemaining: number;
}
