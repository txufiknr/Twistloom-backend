export const CREDIT_PACKS = [
  {
    id: "observer",
    title: "🕵️ The Observer",
    tagline: "You watch… but rarely interfere.",
    description:
      "Perfect for first-time readers. Explore branching paths and test how your decisions shape the story.",
    credits: 50,
    priceUSD: 2.99,
    priceId: "price_observer", // Stripe Price ID
    highlight: false,
    badge: null,
    valueTag: "~10-12 choices",
    color: "gray",
  },
  {
    id: "investigator",
    title: "🔍 The Investigator",
    tagline: "You follow the clues. Carefully.",
    description:
      "Dig deeper into the mystery. Enough credits to influence key decisions and unlock hidden paths.",
    credits: 150,
    priceUSD: 7.99,
    priceId: "price_investigator",
    highlight: true,
    badge: "🔥 Most Popular",
    valueTag: "~30-40 choices",
    color: "blue",
  },
  {
    id: "mastermind",
    title: "🧠 The Mastermind",
    tagline: "You don't follow the story. You control it.",
    description:
      "Take full control of the narrative. Craft custom actions, explore alternate endings, and bend the story to your will.",
    credits: 500,
    priceUSD: 19.99,
    priceId: "price_mastermind",
    highlight: false,
    badge: "💎 Best Value",
    valueTag: "~120+ choices",
    color: "purple",
  },
];