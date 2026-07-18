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
 * Credit costs for various actions
 * @overview Defines credit costs for different features and operations
 * 
 * These costs are configurable and can be adjusted based on business requirements.
 * All costs should be positive integers.
 */
export const CREDIT_COSTS = {
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
 * Credit cost per book creation mode (story format).
 *
 * Each mode represents a different storytelling philosophy with a different AI
 * generation cost. Multiverse is the most expensive because the engine simulates
 * many parallel timelines; interactive adds branching; novel is a single linear
 * story.
 *
 * @see `BookMode` in `src/types/book.ts`
 */
export const BOOK_MODE_CREDIT_COSTS = {
  /** Traditional linear story with a single path and ending */
  novel: 2,
  /** Reader choices lead to different branches and endings */
  interactive: 5,
  /** Every choice spawns unseen parallel timelines that keep evolving */
  multiverse: 10,
} as const;

export type CreditCostKey = keyof typeof CREDIT_COSTS;

/**
 * Returns the credit cost for creating a book in the given mode.
 *
 * Falls back to `interactive` (the default mode) if an unknown/undefined mode
 * is supplied, so legacy and malformed requests still consume a sensible cost.
 *
 * @param mode - Book creation mode, or undefined to use the default
 * @returns Credit cost for that mode
 */
export function getBookModeCreditCost(mode: BookMode | null | undefined): number {
  if (mode && mode in BOOK_MODE_CREDIT_COSTS) {
    return BOOK_MODE_CREDIT_COSTS[mode];
  }
  return BOOK_MODE_CREDIT_COSTS.interactive;
}

/** Credits bonus for first-time users */
export const FIRST_TIME_CREDITS = 50;

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