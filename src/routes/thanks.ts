/**
 * Thanks (Creator Tipping) Routes (Hono)
 *
 * Checkout sessions for tipping, webhook handling, and book-level stats.
 * Wallet management (balance, earnings, payouts, conversions) lives in wallet.ts.
 * Stripe-only for v0.5.
 *
 * @see docs/architecture/THANKS_SYSTEM_ARCHITECTURE.md
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middleware/nextauth.js";
import { dbRead } from "../db/client.js";
import { books, users } from "../db/schema.js";
import { THANKS_CONFIG, calculatePlatformFee, calculateCreatorAmount } from "../config/thanks.js";
import {
  recordThanks,
  getBookThanksStats,
  getMyThanksForBook,
} from "../services/thanks.js";
import {
  cApiError,
  cValidationError,
  cNotFoundError,
  cRateLimitError,
} from "../utils/error.js";
import { checkRateLimit } from "../utils/redis.js";
import { getStripe } from "../utils/stripe.js";
import type { AppEnv } from "../hono/env.js";
import { PAYMENT_GATEWAY } from "../types/payment.js";

const router = new Hono<AppEnv>();

// POST /thanks/create-checkout-session
router.post("/create-checkout-session", requireAuth, async (c) => {
  try {
    const { bookId, pageId, amount, currency: rawCurrency, message } = c.get("body");
    const readerId = c.get("userId")!;

    if (!bookId || !amount) {
      return cValidationError(c, "bookId and amount are required");
    }

    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return cValidationError(c, "Amount must be a positive number");
    }

    const currency = rawCurrency === "USD" ? "USD" : "IDR";
    const maxTip = currency === "USD" ? THANKS_CONFIG.maxTipAmountUSD : THANKS_CONFIG.maxTipAmountIDR;
    if (numAmount > maxTip) {
      return cValidationError(c, `Amount exceeds maximum of ${maxTip} ${currency}`);
    }

    const rl = await checkRateLimit(`thanks-checkout-${readerId}`, {
      maxRequests: THANKS_CONFIG.maxTipsPerMinute,
      windowSeconds: 60,
    });
    if (!rl.allowed) {
      return cRateLimitError(c, "Too many Thanks attempts. Please wait before trying again.");
    }

    const [book] = await dbRead
      .select({ userId: books.userId, title: books.title, slug: books.slug })
      .from(books)
      .where(eq(books.id, bookId))
      .limit(1);

    if (!book) return cNotFoundError(c, "Book not found");
    if (!book.userId) return cValidationError(c, "Book has no creator");

    if (book.userId === readerId) {
      return cValidationError(c, "You cannot send Thanks to yourself");
    }

    const [creator] = await dbRead
      .select({ name: users.name })
      .from(users)
      .where(eq(users.userId, book.userId))
      .limit(1);

    const platformFee = calculatePlatformFee(numAmount);
    const creatorAmount = calculateCreatorAmount(numAmount);

    const baseUrl = process.env.FRONTEND_URL;
    if (!baseUrl) return cApiError(c, "Frontend URL not configured");

    const bookSlug = book.slug || bookId;
    const pageSegment = pageId ? `/${pageId}` : "";
    const successUrl = `${baseUrl}/books/${bookSlug}${pageSegment}?thanks=success`;
    const cancelUrl = `${baseUrl}/books/${bookSlug}${pageSegment}?thanks=cancel`;

    const session = await getStripe().checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: currency.toLowerCase(),
            product_data: {
              name: `Thanks for "${book.title}"`,
              description: `Support ${creator?.name || "the creator"}`,
            },
            unit_amount: numAmount,
          },
          quantity: 1,
        },
      ],
      metadata: {
        type: "thanks",
        readerId,
        creatorId: book.userId,
        bookId,
        pageId: pageId || "",
        grossAmount: numAmount.toString(),
        platformFee: platformFee.toString(),
        creatorAmount: creatorAmount.toString(),
        currency,
        message: message || "",
      },
      client_reference_id: readerId,
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return c.json({
      url: session.url,
      sessionId: session.id,
      gateway: PAYMENT_GATEWAY.stripe,
    });
  } catch (error) {
    return cApiError(c, "Failed to create Thanks checkout session", error);
  }
});

// POST /thanks/stripe/webhook
router.post("/stripe/webhook", async (c) => {
  try {
    const sig = c.req.header("stripe-signature");
    if (!sig) return cValidationError(c, "Missing Stripe signature");

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) return cApiError(c, "Webhook secret not configured");

    const rawBody = await c.req.text();
    const event = getStripe().webhooks.constructEvent(rawBody, sig, webhookSecret);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as any;

      if (session.metadata?.type !== "thanks") {
        return c.json({ received: true });
      }

      const { readerId, creatorId, bookId, pageId, currency, message } = session.metadata;

      if (!readerId || !creatorId || !bookId) {
        return cValidationError(c, "Invalid Thanks metadata");
      }

      // Use Stripe's authoritative amount, not metadata ( defense-in-depth )
      const grossAmount = session.amount_total;
      if (!grossAmount || grossAmount <= 0) {
        return cValidationError(c, "Invalid Stripe amount");
      }

      const result = await recordThanks({
        readerId,
        creatorId,
        bookId,
        pageId: pageId || undefined,
        grossAmount,
        currency: currency || "IDR",
        stripeSessionId: session.id,
        stripePaymentIntentId: session.payment_intent as string,
        stripeEventId: event.id,
        message: message || undefined,
      });

      if (result.duplicate) {
        return c.json({ received: true, duplicate: true });
      }
    }

    return c.json({ received: true });
  } catch (error) {
    return cApiError(c, "Failed to process webhook", error);
  }
});

// GET /thanks/book/:bookId/stats
router.get("/book/:bookId/stats", async (c) => {
  try {
    const bookId = c.req.param("bookId");
    if (!bookId) return cValidationError(c, "bookId is required");

    const stats = await getBookThanksStats(bookId);
    return c.json(stats);
  } catch (error) {
    return cApiError(c, "Failed to fetch Thanks stats", error);
  }
});

// GET /thanks/book/:bookId/my-thank
router.get("/book/:bookId/my-thank", requireAuth, async (c) => {
  try {
    const bookId = c.req.param("bookId");
    const readerId = c.get("userId")!;

    const result = await getMyThanksForBook(readerId, bookId);
    return c.json(result);
  } catch (error) {
    return cApiError(c, "Failed to fetch Thanks status", error);
  }
});

export default router;
