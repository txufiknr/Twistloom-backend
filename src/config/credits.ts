/**
 * Credit Packs Configuration
 * @overview Configuration for Stripe credit pack products and pricing
 * 
 * Defines the available credit pack options for purchase in the Twistloom application.
 * Each credit pack represents a different tier of story interaction capabilities.
 * 
 * ## Stripe Integration
 * 
 * ### Products & Prices Setup
 * 1. Go to: https://dashboard.stripe.com/acct_1TSpFoFmDKrMqBDf/test/products
 * 2. Create products with the following structure:
 *    - Name: Use the `title` field from each pack
 *    - Description: Use the `description` field
 *    - Price: Use the `priceUSD` field (in USD)
 * 3. Copy the generated `priceId` and `productId` to the configuration below
 * 
 * ## Credit Pack Tiers
 * 
 * ### Observer (50 credits - $2.99)
 * Perfect for first-time readers who want to explore branching paths
 * - ~10-12 story choices
 * - Basic story interaction
 * - Introduction to the Twistloom experience
 * 
 * ### Investigator (150 credits - $7.99) 🔥 Most Popular
 * For readers who want to dig deeper into the mystery
 * - ~30-40 story choices
 * - Influence key decisions
 * - Unlock hidden paths
 * - Recommended for most users
 * 
 * ### Mastermind (500 credits - $19.99) 💎 Best Value
 * For power users who want complete control
 * - ~120+ story choices
 * - Craft custom actions
 * - Explore alternate endings
 * - Full narrative control
 * 
 * ## Usage Guidelines
 * 
 * ### Adding New Credit Packs
 * 1. Create corresponding Stripe product and price
 * 2. Add new pack to the `CREDIT_PACKS` array
 * 3. Update environment variables if needed
 * 4. Test checkout flow end-to-end
 * 
 * ### Modifying Existing Packs
 * - Update Stripe product first, then update configuration
 * - Price changes require new Stripe price creation
 * - Credit amounts can be adjusted without Stripe changes
 * 
 * ### API Integration
 * - Frontend fetches packs via `GET /api/payments/credit-packs`
 * - Backend validates pack existence in checkout session
 * - Webhook maps priceId to credits for allocation
 */

import type { CreditPack } from "../types/credits.js";

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
  CHOOSE_OTHER_ACTION: 2, // TODO: use
  
  /** Cost to generate custom actions (future feature) */
  CUSTOM_ACTION: 5, // TODO: use

  /** Cost per page when using time travel (reset chosen actions) */
  TIME_TRAVEL_PER_PAGE: 5, // TODO: use
  
  /** Cost to unlock alternate endings (future feature) */
  UNLOCK_ALTERNATE_ENDING: 10, // TODO: use
} as const;

/**
 * Daily check-in rewards
 * @overview Defines free credits awarded for daily user check-ins
 */
export const DAILY_CHECKIN_CREDITS = 30;

export type CreditCostKey = keyof typeof CREDIT_COSTS;

export const CREDIT_PACKS: CreditPack[] = [
  {
    id: "observer",
    title: "Observer Package (50 credits)",
    tagline: "You watch… but rarely interfere.",
    description:
      "Perfect for first-time readers. Explore branching paths and test how your decisions shape the story.",
    credits: 50,
    priceUSD: 2.99,
    priceId: "price_1TSq8CFmDKrMqBDfv8hHK8hi", // Stripe Price ID
    productId: "prod_URjbG0HYUqTKjj",
    highlight: false,
    badge: null,
    valueTag: "~10-12 choices",
    color: "gray",
  },
  {
    id: "investigator",
    title: "Investigator Package (150 credits)",
    tagline: "You follow the clues. Carefully.",
    description:
      "Dig deeper into the mystery. Enough credits to influence key decisions and unlock hidden paths.",
    credits: 150,
    priceUSD: 7.99,
    priceId: "price_1TSqEFFmDKrMqBDfJNv4Rhvi",
    productId: "prod_URjhcMuRg9MAl7",
    highlight: true,
    badge: "🔥 Most Popular",
    valueTag: "~30-40 choices",
    color: "blue",
  },
  {
    id: "mastermind",
    title: "Mastermind Package (500 credits)",
    tagline: "You don't follow the story. You control it.",
    description:
      "Take full control of the narrative. Craft custom actions, explore alternate endings, and bend the story to your will.",
    credits: 500,
    priceUSD: 19.99,
    priceId: "price_1TSqEpFmDKrMqBDfhrwd9wOn",
    productId: "prod_URjiSAzuitp1le",
    highlight: false,
    badge: "💎 Best Value",
    valueTag: "~120+ choices",
    color: "purple",
  },
];