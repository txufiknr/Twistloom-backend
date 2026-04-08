/**
 * Database Client Configuration (Serverless-Safe)
 *
 * This file sets up the database connection using Drizzle ORM with Neon's HTTP driver.
 * Optimized for serverless environments with connection reuse and hot-reload safety.
 * 
 * Architecture:
 * - Uses Neon HTTP driver for serverless compatibility (no pooling, no WebSocket)
 * - Works on Vercel, GitHub Actions, Cloudflare Workers
 * - Stateless and concurrency-safe
 * - Test environment uses DATABASE_TEST_URL for real database operations
 * - Environment-aware configuration with production safeguards
 * - Type-safe schema integration with Drizzle ORM
 * 
 * Important notes:
 * - Avoid `db.transaction` everywhere (cron + API routes)
 * - Design routes to be idempotent
 * - In test environment, uses DATABASE_TEST_URL (defaults to localhost test DB)
 * 
 * Environment Variables:
 * - DATABASE_URL: Neon database connection string (required in non-test environments)
 * - DATABASE_READ_URL: Neon database connection string for read operations
 * - DATABASE_TEST_URL: Test database connection string (defaults to postgresql://test:test@localhost:5432/test)
 * - NODE_ENV: Environment detection for production/development/test modes
 * - DATABASE_LOGGING: Enable query logging (default: false)
 */

import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";
import { IS_DEVELOPMENT, IS_PRODUCTION, IS_TEST } from "../config/constants.js";
import { getEnv } from "../utils/env.js";

console.log(`👋 Running in ${IS_TEST ? 'test' : process.env['NODE_ENV']} environment`);

// Environment variables and flags
const DATABASE_TEST_URL = getEnv("DATABASE_TEST_URL", "postgresql://test:test@localhost:5432/test");
const DATABASE_URL = getEnv("DATABASE_URL", DATABASE_TEST_URL);
const DATABASE_READ_URL = getEnv('DATABASE_READ_URL', DATABASE_URL);
const DATABASE_LOGGING = getEnv('DATABASE_LOGGING', 'false') === "true";

// Production safeguard: disallow localhost DB in production
if (IS_PRODUCTION && DATABASE_URL.includes("localhost")) {
  throw new Error("💀 Production cannot use localhost database");
}

/**
 * Primary write connection
 * @note Uses DATABASE_TEST_URL in test environment, DATABASE_URL otherwise
 */
export const dbWrite: NeonHttpDatabase<typeof schema> = drizzle(neon(DATABASE_URL, {
  fetchOptions: { cache: "no-store" },
}), {
  schema,
  logger: IS_DEVELOPMENT && DATABASE_LOGGING,
});

/**
 * Read replica connection
 * @note In test environment, uses the same connection as write (DATABASE_TEST_URL)
 */
export const dbRead: NeonHttpDatabase<typeof schema> = IS_TEST ? dbWrite : drizzle(neon(DATABASE_READ_URL, {
  fetchOptions: { cache: "force-cache" },
}), {
  schema,
  logger: false,
});

/**
 * Default database client (uses write connection)
 */
export const db = dbWrite;