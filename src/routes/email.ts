/**
 * Public email routes (unsubscribe, etc.)
 *
 * No auth required — tokens are HMAC-signed.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../hono/env.js';
import { cApiError, cValidationError } from '../utils/error.js';

const router = new Hono<AppEnv>();

/**
 * GET /api/email/unsubscribe?token=...
 *
 * Applies engagement opt-out for the token category (or all).
 */
router.get('/unsubscribe', async (c) => {
  try {
    const token = c.req.query('token');
    if (!token || typeof token !== 'string') {
      return cValidationError(c, 'token is required');
    }

    const {
      verifyUnsubscribeToken,
      applyUnsubscribe,
    } = await import('../services/email-preferences.js');

    const payload = verifyUnsubscribeToken(token);
    if (!payload) {
      return cValidationError(c, 'Invalid or expired unsubscribe token');
    }

    const preferences = await applyUnsubscribe(payload.userId, payload.category);
    if (!preferences) {
      return cValidationError(c, 'User not found');
    }

    return c.json({
      success: true,
      category: payload.category,
      message:
        payload.category === 'all'
          ? 'You have been unsubscribed from all product emails.'
          : `You have been unsubscribed from ${payload.category}.`,
      preferences,
    });
  } catch (error) {
    console.error('[GET /email/unsubscribe] ❌', error);
    return cApiError(c, 'Failed to process unsubscribe', error);
  }
});

/**
 * POST /api/email/unsubscribe
 * Same as GET (for clients that prefer POST).
 */
router.post('/unsubscribe', async (c) => {
  try {
    const body = c.get('body') as { token?: string } | undefined;
    const token = body?.token ?? c.req.query('token');
    if (!token || typeof token !== 'string') {
      return cValidationError(c, 'token is required');
    }

    const {
      verifyUnsubscribeToken,
      applyUnsubscribe,
    } = await import('../services/email-preferences.js');

    const payload = verifyUnsubscribeToken(token);
    if (!payload) {
      return cValidationError(c, 'Invalid or expired unsubscribe token');
    }

    const preferences = await applyUnsubscribe(payload.userId, payload.category);
    if (!preferences) {
      return cValidationError(c, 'User not found');
    }

    return c.json({
      success: true,
      category: payload.category,
      message:
        payload.category === 'all'
          ? 'You have been unsubscribed from all product emails.'
          : `You have been unsubscribed from ${payload.category}.`,
      preferences,
    });
  } catch (error) {
    console.error('[POST /email/unsubscribe] ❌', error);
    return cApiError(c, 'Failed to process unsubscribe', error);
  }
});

export default router;
