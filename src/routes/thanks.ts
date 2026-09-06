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
  handleXenditThanksInvoicePaid,
  XENDIT_CONFIG,
} from "../services/xendit.js";
import { getGatewayAdapter } from "../services/gateways/registry.js";
import { verifyXenditCallbackToken, type XenditInvoice } from "../utils/xendit.js";
import {
  cApiError,
  cValidationError,
  cNotFoundError,
  cRateLimitError,
  getErrorMessage,
} from "../utils/error.js";
import { checkRateLimit } from "../utils/redis.js";
import { getStripe } from "../utils/stripe.js";
import type { AppEnv } from "../hono/env.js";
import { PAYMENT_GATEWAY } from "../types/payment.js";

const router = new Hono<AppEnv>();

// POST /thanks/create-checkout-session
router.post("/create-checkout-session", requireAuth, async (c) => {
  try {
    const { bookId, pageId, amount, currency: rawCurrency, gateway: rawGateway, message } = c.get("body");
    const readerId = c.get("userId")!;

    if (!bookId || !amount) {
      return cValidationError(c, "bookId and amount are required");
    }

    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return cValidationError(c, "Amount must be a positive number");
    }

    const gateway = rawGateway === PAYMENT_GATEWAY.xendit ? PAYMENT_GATEWAY.xendit : PAYMENT_GATEWAY.stripe;
    const currency = gateway === PAYMENT_GATEWAY.xendit ? "IDR" : (rawCurrency === "IDR" ? "IDR" : "USD");

    const maxTip = currency === "USD" ? THANKS_CONFIG.maxTipAmountUSD : THANKS_CONFIG.maxTipAmountIDR;
    const minTip = currency === "USD" ? 100 : 10_000;
    if (numAmount < minTip || numAmount > maxTip) {
      return cValidationError(c, `Amount must be between ${minTip} and ${maxTip} ${currency}`);
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

    const [readerUser] = await dbRead
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.userId, readerId))
      .limit(1);

    const adapter = getGatewayAdapter(gateway);
    if (!adapter.createThanksCheckout) {
      return cValidationError(c, `Payment gateway ${gateway} does not support Thanks tipping`);
    }

    const result = await adapter.createThanksCheckout({
      userId: readerId,
      email: readerUser?.email || "reader@twistloom.com",
      name: readerUser?.name || undefined,
      bookId,
      bookTitle: book.title,
      creatorId: book.userId,
      creatorName: creator?.name || undefined,
      amount: numAmount,
      currency,
      platformFee,
      creatorAmount,
      pageId: pageId || undefined,
      message: message || undefined,
      successUrl,
      cancelUrl,
    });

    return c.json(result);
  } catch (error) {
    const errorMsg = getErrorMessage(error, "Failed to create Thanks checkout session");
    if (errorMsg.includes("not enabled") || errorMsg.includes("not configured")) {
      return cValidationError(c, errorMsg);
    }
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

      // Authoritative currency from Stripe session, fallback to metadata or "USD"
      const resolvedCurrency = (session.currency ? session.currency.toUpperCase() : (currency || "USD"));

      const result = await recordThanks({
        readerId,
        creatorId,
        bookId,
        pageId: pageId || undefined,
        grossAmount,
        currency: resolvedCurrency,
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

// POST /thanks/xendit/webhook
router.post("/xendit/webhook", async (c) => {
  try {
    if (!XENDIT_CONFIG.enabled) {
      return cValidationError(c, "Xendit gateway is not enabled");
    }

    const callbackToken = c.req.header("x-callback-token");
    if (!verifyXenditCallbackToken(callbackToken)) {
      return c.json({ error: "Invalid callback token" }, 401);
    }

    const body = (await c.req.json()) as Record<string, unknown>;
    const eventId =
      (typeof body.id === "string" && body.id) ||
      (typeof body.external_id === "string" && body.external_id) ||
      `xendit-thanks-${Date.now()}`;

    const rawStatus = typeof body.status === "string" ? body.status : "";
    const status = rawStatus.toUpperCase();
    const isPaid = status === "PAID" || status === "SETTLED";

    if (isPaid) {
      const result = await handleXenditThanksInvoicePaid(body as XenditInvoice, eventId);
      return c.json({ received: true, duplicate: result.duplicate });
    }

    return c.json({ received: true });
  } catch (error) {
    return cApiError(c, "Failed to process Xendit thanks webhook", error);
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
