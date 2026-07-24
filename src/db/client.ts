/**
 * Database Client Configuration (Serverless-Safe)
 *
 * This file sets up database connection using Drizzle ORM with Neon's WebSocket driver.
 * Optimized for serverless environments with transaction support and connection pooling.
 * 
 * Architecture:
 * - Uses Neon WebSocket driver (neon-serverless) for transaction support
 * - Works on Vercel, GitHub Actions, Cloudflare Workers
 * - Maintains persistent connections within single requests for transactions
 * - Test environment uses DATABASE_TEST_URL for real database operations
 * - Environment-aware configuration with production safeguards
 * - Type-safe schema integration with Drizzle ORM
 * 
 * Important notes:
 * - Supports `db.transaction` for payment processing and critical operations
 * - Design routes to be idempotent (webhooks, retries)
 * - In test environment, uses DATABASE_TEST_URL (defaults to localhost test DB)
 * 
 * Environment Variables:
 * - DATABASE_URL: Neon database connection string (required in non-test environments)
 * - DATABASE_READ_URL: Neon database connection string for read operations
 * - DATABASE_TEST_URL: Test database connection string (defaults to postgresql://test:test@localhost:5432/test)
 * - NODE_ENV: Environment detection for production/development/test modes
 * - DATABASE_LOGGING: Enable query logging (default: false)
 */

import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool, neonConfig } from "@neondatabase/serverless";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import * as schema from "./schema.js";
import { IS_DEVELOPMENT, IS_PRODUCTION, IS_TEST } from "../config/env.js";
import { getEnv } from "../utils/env.js";
import type { PgTransaction } from "drizzle-orm/pg-core";

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

// Configure Neon to use global WebSocket (required on Edge Runtime)
neonConfig.webSocketConstructor = globalThis.WebSocket;

// Create connection pools
const writePool = new Pool({ connectionString: DATABASE_URL });
const readPool = IS_TEST ? writePool : new Pool({ connectionString: DATABASE_READ_URL });

/**
 * Primary write connection
 * Uses {@link DATABASE_TEST_URL} in test environment, {@link DATABASE_URL} otherwise
 */
export const dbWrite: NeonDatabase<typeof schema> = drizzle(writePool, {
  schema,
  logger: IS_DEVELOPMENT && DATABASE_LOGGING,
});

/**
 * Read replica connection
 * In test environment, uses same {@link DATABASE_TEST_URL} connection as write
 */
export const dbRead: NeonDatabase<typeof schema> = drizzle(readPool, {
  schema,
  logger: false,
});

/**
 * Default database client (uses {@link dbWrite} connection)
 */
export const db = dbWrite;

export type DBTransaction = PgTransaction<any, any, any>;

export type DBClient = typeof dbRead | typeof dbWrite | DBTransaction;

/**
 * Detects if the provided client is a transaction instance
 * 
 * Drizzle transaction objects have methods that regular database clients don't.
 * However, this relies on Drizzle implementation details and could theoretically break in a future version.
 * 
 * @param client 
 * @returns 
 */
export function isTransaction(client: DBClient): client is DBTransaction {
  // return "rollback" in client;
  return (
    typeof client === "object" &&
    client !== null &&
    "rollback" in client &&
    typeof (client as any).rollback === "function"
  );
}