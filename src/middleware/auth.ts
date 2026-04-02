import type { Request, Response, NextFunction } from 'express';
import { handleUnauthorizedError } from '../utils/error.js';
import { validate as uuidValidate } from "uuid";
import { dbWrite } from '../db/client.js';
import { userDevices } from '../db/schema.js';
import '../types/express.js';

/**
 * Middleware to validate X-Client-Id header
 * @param req - Express request object
 * @param res - Express response object  
 * @param next - Express next middleware function
 */
export function requireClientId(req: Request, res: Response, next: NextFunction): void {
  const userId = req.header("X-Client-Id");

  // Validate userId is a valid UUID
  if (!userId || !uuidValidate(userId)) {
    handleUnauthorizedError(res, "Invalid client id");
    return;
  }

  // Attach userId to the request object for use in route handlers
  req.userId = userId;
  
  // Track first-seen device metadata
  trackFirstSeenDevice(userId, req);
  
  next();
}

/**
 * Middleware that optionally reads X-Client-Id and attaches `req.userId` when present.
 * Allows public requests to proceed without authentication while preserving user context when provided.
 */
export function optionalClientId(req: Request, _res: Response, next: NextFunction): void {
  const userId = req.header('X-Client-Id');
  if (userId && uuidValidate(userId)) {
    req.userId = userId;
    
    // Track first-seen device metadata
    trackFirstSeenDevice(userId, req);
  }
  next();
}

/**
 * Tracks first-seen device metadata for analytics.
 * Uses upsert to only record the first time a user+platform+version combination is seen.
 * 
 * @param userId - User identifier (validated UUID)
 * @param req - Express request object to extract headers
 * @returns Promise that resolves when tracking is complete (or fails silently)
 * 
 * @note
 * - Non-blocking operation (fire-and-forget)
 * - Uses ON CONFLICT DO NOTHING to ensure idempotency
 * - Only records first-seen timestamp, subsequent requests are ignored
 * - Extracts platform and app_version from X-Platform and X-App-Version headers
 */
function trackFirstSeenDevice(userId: string, req: Request) {
  const platform = req.header('X-Platform')?.toLowerCase() || null;
  const appVersion = req.header('X-App-Version') || null;

  // Skip tracking if required metadata is missing
  if (!platform || !appVersion) return;

  // Normalize platform values
  if (!['android', 'ios'].includes(platform)) return;

  // Upsert with ON CONFLICT DO NOTHING to only record first-seen
  // This ensures first_seen_at is only set on the first insert
  dbWrite
    .insert(userDevices)
    .values({ userId, platform, appVersion, firstSeenAt: new Date() })
    .onConflictDoNothing();
}