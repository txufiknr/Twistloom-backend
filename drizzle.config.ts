/**
 * drizzle.config.ts (Drizzle ORM configuration)
 * @overview This file configures Drizzle ORM for PostgreSQL database operations.
 * @summary It is used for database migrations and schema generation.
 * 
 * @note
 * Environment variable DATABASE_URL must be set
 * Example: DATABASE_URL=postgresql://user:password@host:port/database
 * 
 * After changes, run:
 * - `pnpm db:generate` to generate schema files
 * - `pnpm db:migrate` to apply migrations
 * - `pnpm db:studio` to open the database studio
 * - `pnpm db:test` to test the database connection
 */

import type { Config } from "drizzle-kit";
import { loadEnvFile } from 'node:process';

loadEnvFile('.env.local');

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
} satisfies Config;
