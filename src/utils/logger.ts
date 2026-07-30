/**
 * Structured JSON logger for serverless-friendly observability.
 *
 * Every log line is a JSON object that Vercel Logs and log aggregation
 * tools can parse, filter, and search without fragile regex on free-form
 * console output.
 *
 * Usage:
 *   import { logger } from "../utils/logger.js";
 *   logger.info("Book created", { bookId, userId });
 *   logger.error("AI provider failed", { provider, model, error });
 *
 * Log levels: debug | info | warn | error
 *
 * In production the JSON includes a timestamp and environment tag.
 * In development the output is colourised for readability.
 */

import { IS_PRODUCTION } from "../config/env.js";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  msg: string;
  timestamp: string;
  env: string;
  [key: string]: unknown;
}

function log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  const entry: LogEntry = {
    level,
    msg,
    timestamp: new Date().toISOString(),
    env: IS_PRODUCTION ? "production" : "development",
    ...meta,
  };

  if (IS_PRODUCTION) {
    // JSON line — parseable by Vercel Logs, Datadog, etc.
    const line = JSON.stringify(entry);
    switch (level) {
      case "error":
        console.error(line);
        break;
      case "warn":
        console.warn(line);
        break;
      default:
        console.log(line);
    }
  } else {
    // Colourised for dev readability
    const label = level.toUpperCase().padEnd(5);
    const ts = entry.timestamp.slice(11, 23);
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
    switch (level) {
      case "error":
        console.error(`\x1b[31m${label}\x1b[0m ${ts} ${msg}${metaStr}`);
        break;
      case "warn":
        console.warn(`\x1b[33m${label}\x1b[0m ${ts} ${msg}${metaStr}`);
        break;
      default:
        console.log(`\x1b[36m${label}\x1b[0m ${ts} ${msg}${metaStr}`);
    }
  }
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta),
};
