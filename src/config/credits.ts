/**
 * Credit Packs Configuration
 * @overview Configuration for Stripe credit pack products and pricing
 * 
 * Defines the available credit pack options for purchase in the Twistloom application.
 * Each credit pack represents a different tier of story interaction capabilities.
 * 
 * Products & Prices Setup:
 * 1. Go to: https://dashboard.stripe.com/acct_1TSpFoFmDKrMqBDf/test/products
 * 2. Create products with the following structure:
 *    - Name: Use the `title` field from each pack
 *    - Description: Use the `description` field
 *    - Price: Use the `priceUSD` field (in USD)
 * 3. Copy the generated `priceId` and `productId` to the configuration below
 * 
 * Adding New Credit Packs:
 * 1. Create corresponding Stripe product and price
 * 2. Add new pack to the `CREDIT_PACKS` array
 * 3. Update environment variables if needed
 * 4. Test checkout flow end-to-end
 * 
 * Modifying Existing Packs:
 * - Update Stripe product first, then update configuration
 * - Price changes require new Stripe price creation
 * - Credit amounts can be adjusted without Stripe changes
 * 
 * API Integration:
 * - Frontend fetches packs via `GET /api/payments/credit-packs`
 * - Backend validates pack existence in checkout session
 * - Webhook maps priceId to credits for allocation
 */

import type { CreditPack } from "../types/credits.js";
import type { BookMode } from "../types/book.js";

/**
 * Free demo phase flag.
 *
 * When `true` (default), the platform is still in demo phase and all credit
 * costs resolve to zero so every action is free of charge. Set
 * `FEATURE_FREE_DEMO=false` to enable normal paid credit pricing.
 *
 * Unset or any value other than the string `"false"` keeps demo mode on.
 */
export const FEATURE_FREE_DEMO = process.env.FEATURE_FREE_DEMO !== "false";

/**
 * User ID of the dedicated demo account.
 *
 * The demo user is always treated as if {@link FEATURE_FREE_DEMO} is enabled —
 * every credit cost resolves to zero for this user regardless of the global
 * flag (used to demo the platform without spending credits).
 */
export const DEMO_USER_ID = process.env.DEMO_USER_ID;

/**
 * Applies free-demo pricing: zero every cost when {@link FEATURE_FREE_DEMO} is on.
 *
 * @param costs - Reduced (paid) credit cost map
 * @param forceZero - When true, always zero the costs (ignores the feature flag)
 * @returns Zeroed map when free demo is on (or `forceZero`), otherwise the original costs
 */
export function applyFreeDemoPricing<T extends Record<string, number>>(
  costs: T,
  forceZero = false
): { [K in keyof T]: number } {
  if (!forceZero && !FEATURE_FREE_DEMO) return costs;
  return Object.fromEntries(Object.keys(costs).map((key) => [key, 0])) as { [K in keyof T]: number };
}

/**
 * Returns whether the given user is the configured demo account.
 *
 * `false` when `DEMO_USER_ID` is not configured or the id does not match.
 *
 * @param userId - User id to test
 * @returns True when the user is the demo account
 */
export function isDemoUser(userId: string | null | undefined): boolean {
  return Boolean(userId && DEMO_USER_ID && userId === DEMO_USER_ID);
}

/**
 * Base credit costs for various actions (paid pricing).
 * @overview Defines credit costs for different features and operations
 *
 * These costs are configurable and can be adjusted based on business requirements.
 * All base costs should be positive integers. When {@link FEATURE_FREE_DEMO} is
 * true, the exported {@link CREDIT_COSTS} map zeros every entry.
 */
const CREDIT_COSTS_BASE = {
  /** Cost to generate a new story/book */
  STORY_GENERATION: 5,
  /** Cost to generate additional pages in an existing story */
  CHOOSE_OTHER_ACTION: 2,
  /** Cost to show action hint */
  SHOW_ACTION_HINT: 1,
  /** Cost to generate custom actions */
  CUSTOM_ACTION: 5,
  /** Cost to generate custom actions (after choice has been made) */
  CUSTOM_ACTION_AFTER_CHOICE: 7,
  /** Cost to select community actions (future feature) */
  CHOOSE_CUSTOM_ACTION: 2, // TODO: use
  /** Cost to add new custom characters (future feature) */
  SUMMON_NEW_CHARACTER: 50, // TODO: use
  /** Cost per page when using time travel (reset chosen actions) */
  TIME_TRAVEL_PER_PAGE: 5, // TODO: use
  /** Cost to unlock alternate endings (future feature) */
  UNLOCK_ALTERNATE_ENDING: 10, // TODO: use
} as const;

/**
 * Credit costs for various actions.
 *
 * Equals {@link CREDIT_COSTS_BASE} normally; all values are `0` when
 * {@link FEATURE_FREE_DEMO} is enabled.
 */
export const CREDIT_COSTS = applyFreeDemoPricing(CREDIT_COSTS_BASE);

/**
 * Base credit cost per book creation mode (story format).
 *
 * Each mode represents a different storytelling philosophy with a different AI
 * generation cost. Multiverse is the most expensive because the engine simulates
 * many parallel timelines; interactive adds branching; novel is a single linear
 * story.
 *
 * @see `BookMode` in `src/types/book.ts`
 */
const BOOK_MODE_CREDIT_COSTS_BASE = {
  /** Traditional linear story with a single path and ending */
  novel: 2,
  /** Reader choices lead to different branches and endings */
  interactive: 5,
  /** Every choice spawns unseen parallel timelines that keep evolving */
  multiverse: 10,
} as const;

/**
 * Credit cost per book creation mode.
 *
 * Equals {@link BOOK_MODE_CREDIT_COSTS_BASE} normally; all values are `0` when
 * {@link FEATURE_FREE_DEMO} is enabled.
 */
export const BOOK_MODE_CREDIT_COSTS = applyFreeDemoPricing(BOOK_MODE_CREDIT_COSTS_BASE);

export type CreditCostKey = keyof typeof CREDIT_COSTS_BASE;

/**
 * Returns the credit cost for creating a book in the given mode.
 *
 * Falls back to `interactive` (the default mode) if an unknown/undefined mode
 * is supplied, so legacy and malformed requests still consume a sensible cost.
 * Returns `0` for every mode when {@link FEATURE_FREE_DEMO} is enabled.
 *
 * @param mode - Book creation mode, or undefined to use the default
 * @returns Credit cost for that mode
 */
export function getBookModeCreditCost(mode: BookMode | null | undefined): number {
  if (mode && mode in BOOK_MODE_CREDIT_COSTS) {
    return BOOK_MODE_CREDIT_COSTS[mode as BookMode];
  }
  return BOOK_MODE_CREDIT_COSTS.interactive;
}

/**
 * Returns the credit cost for a book creation mode for a specific user.
 *
 * Always `0` for the demo user (see {@link isDemoUser}), otherwise delegates
 * to {@link getBookModeCreditCost}.
 *
 * @param userId - User (demo users always pay 0)
 * @param mode - Book creation mode, or undefined to use the default
 * @returns Credit cost for that mode for the given user
 */
export function getBookModeCreditCostForUser(
  userId: string | null | undefined,
  mode: BookMode | null | undefined
): number {
  if (isDemoUser(userId)) return 0;
  return getBookModeCreditCost(mode);
}

/**
 * Returns the numeric credit cost for an action key for a specific user.
 *
 * Always `0` for the demo user (see {@link isDemoUser}), otherwise the
 * configured {@link CREDIT_COSTS} value.
 *
 * @param userId - User (or (always pay 0) for the demo account)
 * @param costKey - Key into `CREDIT_COSTS` configuration
 * @returns Credit cost for that key for the given user
 */
export function getCreditCostForUser(userId: string | null | undefined, costKey: CreditCostKey): number {
  if (isDemoUser(userId)) return 0;
  return CREDIT_COSTS[costKey];
}

/** Credits bonus for first-time users */
export const FIRST_TIME_CREDITS = 50;

/**
 * Monthly credit bonus granted to VIP subscribers.
 *
 * Awarded automatically on every subscription activation (trial or paid) and on
 * every subsequent monthly renewal via the Stripe webhook flow. This is the
 * single source of truth for the VIP monthly credit amount; `VIP_BENEFITS`
 * in `config/subscription.ts` falls back to this value unless overridden by the
 * `VIP_MONTHLY_CREDITS` environment variable.
 */
export const VIP_MONTHLY_CREDITS = 200;

/**
 * Daily check-in rewards
 * @overview Defines free credits awarded for daily user check-ins
 */
export const DAILY_CHECKIN_DAYS = 7; // Big 20 credits bonus on 7th consecutive day
export const DAILY_CHECKIN_BONUS = 5; // Flat 5 credits bonus on day 1-6
export const DAILY_CHECKIN_BIG_BONUS = 20; // Bonus applied on the 7th consecutive day

export const REFERRAL_BONUS = 10; // Bonus for both users
export const FIRST_PURCHASE_BONUS = 50; // Bonus for first purchase

export const CREDIT_PACKS: CreditPack[] = [
  {
    id: "observer",
    title: "Observer",
    tagline: "You watch… but rarely interfere.",
    description: "Step into the dark without committing. Enough to trace a few threads and sense what waits beneath the surface.",
    credits: 50,
    priceUSD: 2.99,
    priceId: "price_1TSq8CFmDKrMqBDfv8hHK8hi", // Stripe Price ID
    productId: "prod_URjbG0HYUqTKjj",
    badge: null,
    color: "gray",
  },
  {
    id: "investigator",
    title: "Investigator",
    tagline: "You follow the clues. Carefully.",
    description: "Follow the evidence deeper. Shape pivotal moments, reveal what others miss, and craft your own story moves.",
    credits: 150,
    priceUSD: 7.99,
    priceId: "price_1TSqEFFmDKrMqBDfJNv4Rhvi",
    productId: "prod_URjhcMuRg9MAl7",
    badge: "🔥 Most Popular",
    color: "blue",
  },
  {
    id: "mastermind",
    title: "Mastermind",
    tagline: "You don't follow the story. You control it.",
    description: "The story bends to you. Forge custom choices, pursue alternate endings, and leave your mark on every chapter.",
    credits: 500,
    priceUSD: 19.99,
    priceId: "price_1TSqEpFmDKrMqBDfhrwd9wOn",
    productId: "prod_URjiSAzuitp1le",
    badge: "💎 Best Value",
    color: "purple",
  },
];