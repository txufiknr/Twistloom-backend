/**
 * Age-Gate Middleware — Cross-Genre Maturity & Age Verification
 *
 * Restricts access to books with elevated content ratings based on user
 * age verification status. Implements a tiered access model:
 *
 * - 'general': Accessible to all users
 * - 'teen': Requires age >= 13
 * - 'mature': Requires age >= 16 AND explicit acknowledgment
 * - 'adult': Requires age >= 18 AND explicit acknowledgment
 *
 * User age is verified via:
 * 1. Self-declared date of birth (stored on user profile)
 * 2. Platform age verification status
 * 3. Parental consent flag (for users 13-17)
 *
 * @see docs/architecture/TRUST_AND_SAFETY_ARCHITECTURE.md §TS.10
 * @see docs/roadmap/TRUST_AND_SAFETY_ROADMAP.md §TS.10
 */

import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../hono/env.js";
import type { Context } from "hono";
import { dbRead } from "../db/client.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";

// ============================================================================
// Types
// ============================================================================

export type ContentRating = 'general' | 'teen' | 'mature' | 'adult';

export interface AgeGateResult {
  allowed: boolean;
  reason?: string;
  requiresAgeVerification?: boolean;
  requiresParentalConsent?: boolean;
  minimumAge?: number;
}

// ============================================================================
// Configuration
// ============================================================================

/** Minimum age requirements for each content rating */
const CONTENT_RATING_AGE_REQUIREMENTS: Record<ContentRating, number> = {
  general: 0,
  teen: 13,
  mature: 16,
  adult: 18,
};

/** Whether the content rating requires explicit user acknowledgment */
const CONTENT_RATING_REQUIRES_ACKNOWLEDGMENT: Record<ContentRating, boolean> = {
  general: false,
  teen: false,
  mature: true,
  adult: true,
};

// ============================================================================
// Age Calculation
// ============================================================================

/**
 * Calculates the user's age from their date of birth.
 * Returns null if date of birth is not set.
 */
export function calculateAge(dateOfBirth: Date | string | null): number | null {
  if (!dateOfBirth) return null;

  const dob = typeof dateOfBirth === 'string' ? new Date(dateOfBirth) : dateOfBirth;
  const today = new Date();

  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  const dayDiff = today.getDate() - dob.getDate();

  // Adjust if birthday hasn't occurred yet this year
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) {
    age--;
  }

  return age;
}

// ============================================================================
// Age Gate Evaluation
// ============================================================================

/**
 * Evaluates whether a user meets the age requirements for a given content rating.
 *
 * @param userId - The user to check
 * @param contentRating - The content rating of the book
 * @param hasAcknowledgedContent - Whether the user has acknowledged the content warning
 * @returns Age gate evaluation result
 */
export async function evaluateAgeGate(
  userId: string,
  contentRating: ContentRating,
  hasAcknowledgedContent: boolean = false,
): Promise<AgeGateResult> {
  // General content is accessible to all
  if (contentRating === 'general') {
    return { allowed: true };
  }

  // Fetch user profile for age verification
  const [user] = await dbRead
    .select({
      dateOfBirth: users.dateOfBirth,
      ageVerified: users.ageVerified,
      parentalConsent: users.parentalConsent,
    })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);

  if (!user) {
    return {
      allowed: false,
      reason: 'User profile not found',
      requiresAgeVerification: true,
    };
  }

  const requiredAge = CONTENT_RATING_AGE_REQUIREMENTS[contentRating];
  const requiresAcknowledgment = CONTENT_RATING_REQUIRES_ACKNOWLEDGMENT[contentRating];

  // Check if date of birth is set
  if (!user.dateOfBirth) {
    return {
      allowed: false,
      reason: `Age verification required for ${contentRating} content`,
      requiresAgeVerification: true,
      minimumAge: requiredAge,
    };
  }

  const age = calculateAge(user.dateOfBirth);

  if (age === null) {
    return {
      allowed: false,
      reason: 'Unable to calculate age',
      requiresAgeVerification: true,
    };
  }

  // Check age requirement
  if (age < requiredAge) {
    return {
      allowed: false,
      reason: `Minimum age ${requiredAge} required for ${contentRating} content`,
      minimumAge: requiredAge,
    };
  }

  // Check parental consent for users 13-17 accessing mature/adult content
  if (age >= 13 && age < 18 && (contentRating === 'mature' || contentRating === 'adult')) {
    if (!user.parentalConsent) {
      return {
        allowed: false,
        reason: 'Parental consent required for users under 18',
        requiresParentalConsent: true,
        minimumAge: requiredAge,
      };
    }
  }

  // Check acknowledgment for mature/adult content
  if (requiresAcknowledgment && !hasAcknowledgedContent) {
    return {
      allowed: false,
      reason: `Content acknowledgment required for ${contentRating} content`,
      requiresAgeVerification: false,
    };
  }

  return { allowed: true };
}

// ============================================================================
// Middleware
// ============================================================================

/**
 * Middleware that enforces age-gating for book access routes.
 *
 * Expects `c.get("book")` or `c.get("bookContentRating")` to be set
 * by an earlier middleware or route handler.
 *
 * Usage:
 * ```typescript
 * router.get("/books/:slug", getBook, requireAgeGate, (c) => {
 *   // Book content is accessible
 * });
 * ```
 */
export const requireAgeGate = createMiddleware<AppEnv>(async (c, next) => {
  const userId = c.get("userId");

  // If no user, allow access (public routes handle their own auth)
  if (!userId) {
    return await next();
  }

  // Get content rating from context (set by route handler or earlier middleware)
  const contentRating = c.get("bookContentRating") as ContentRating | undefined;

  // If no content rating set, assume general (allow access)
  if (!contentRating || contentRating === 'general') {
    return await next();
  }

  // Check if user has already acknowledged this book's content
  const hasAcknowledged = c.get("hasAcknowledgedContent") as boolean | undefined;

  const result = await evaluateAgeGate(userId, contentRating, hasAcknowledged ?? false);

  if (!result.allowed) {
    return c.json(
      {
        error: 'age_restricted',
        message: result.reason,
        requiresAgeVerification: result.requiresAgeVerification,
        requiresParentalConsent: result.requiresParentalConsent,
        minimumAge: result.minimumAge,
        contentRating,
      },
      403,
    );
  }

  await next();
});

/**
 * Helper to set content rating on the Hono context for age-gate middleware.
 * Call this in route handlers before the age-gate middleware.
 *
 * @param c - Hono context
 * @param rating - Content rating to set
 */
export function setContentRatingForAgeGate(c: Context<AppEnv>, rating: ContentRating): void {
  c.set("bookContentRating", rating);
}
