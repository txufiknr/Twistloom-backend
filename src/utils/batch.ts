/**
 * Standardized Bounded Batching & Keyset Fan-Out Utilities
 *
 * @overview Reusable primitives for safe bulk inserts, keyset cursor pagination,
 * array chunking, and mass retention deletion. Enforces the 10M concurrent user
 * invariant by mathematically preventing PostgreSQL parameter ceiling overflow
 * ($rows \times columns \le 65,535$), bounding serverless V8 heap allocation to $O(1)$
 * constant overhead, and eliminating $O(N^2)$ table scan degradation from OFFSET pagination.
 *
 * @see docs/architecture/BOUNDED_BATCHING_AND_FANOUT_ARCHITECTURE.md
 * @see docs/roadmap/BOUNDED_BATCHING_AND_FANOUT_ROADMAP.md
 */

import { inArray, type SQL } from "drizzle-orm";
import type { PgTable, PgColumn } from "drizzle-orm/pg-core";
import type { DBClient, DBTransaction } from "../db/client.js";

/** Absolute PostgreSQL protocol limit for prepared statement bind parameters */
export const POSTGRES_PARAMETER_LIMIT = 65_535;

/** Maximum safe parameter threshold leaving a buffer for auxiliary clauses */
export const POSTGRES_SAFE_PARAMETER_CEILING = 60_000;

/** Universal default batch chunk size for multi-row operations */
export const DEFAULT_BATCH_CHUNK_SIZE = 500;

/** Maximum allowed IDs in administrative bulk status mutations */
export const MAX_ADMIN_BULK_IDS = 100;

/**
 * Slices an in-memory array into bounded sub-arrays of maximum size `chunkSize`.
 * Guarantees zero allocation overhead when `items.length <= chunkSize`.
 *
 * @param items - Array of items to chunk
 * @param chunkSize - Maximum number of elements per chunk (defaults to 500)
 * @returns Array of chunk arrays
 */
export function chunkArray<T>(items: T[], chunkSize: number = DEFAULT_BATCH_CHUNK_SIZE): T[][] {
  const size = Math.max(1, Math.floor(chunkSize));
  if (items.length <= size) {
    return items.length ? [items] : [];
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export interface BatchInsertOptions {
  /** Optional override for maximum chunk size (clamped by safe parameter limit) */
  chunkSize?: number;
  /** Whether to append ON CONFLICT DO NOTHING to each chunk insert */
  onConflictDoNothing?: boolean;
}

/**
 * Inserts rows into a table in automatically bounded chunks, mathematically
 * preventing PostgreSQL 65,535 parameter overflows and bounding V8 heap usage.
 *
 * Automatically inspects the row shape to calculate safe chunk sizes:
 * `safeChunkSize = min(options.chunkSize ?? 500, floor(60,000 / columnsCount))`
 *
 * @param conn - Primary database client or active transaction
 * @param table - Drizzle PostgreSQL table definition
 * @param rows - Array of inferred insert records
 * @param options - Chunk size override and conflict options
 */
export async function batchInsert<TTable extends PgTable>(
  conn: DBClient | DBTransaction,
  table: TTable,
  rows: (typeof table.$inferInsert)[],
  options?: BatchInsertOptions,
): Promise<void> {
  if (!rows.length) return;

  const sample = rows[0];
  const columnsCount =
    typeof sample === "object" && sample !== null
      ? Math.max(1, Object.keys(sample).length)
      : 1;

  const safeMaxRows = Math.max(1, Math.floor(POSTGRES_SAFE_PARAMETER_CEILING / columnsCount));
  const effectiveChunkSize = Math.min(options?.chunkSize ?? DEFAULT_BATCH_CHUNK_SIZE, safeMaxRows);

  const chunks = chunkArray(rows, effectiveChunkSize);
  for (const chunk of chunks) {
    if (options?.onConflictDoNothing) {
      await (conn as any).insert(table).values(chunk).onConflictDoNothing();
    } else {
      await (conn as any).insert(table).values(chunk);
    }
  }
}

export interface KeysetCursorPaginationOptions<TRow, TCursor extends string | number | Date> {
  /**
   * Function to fetch a page of rows using cursor and limit.
   * On initial iteration, `cursor` is null.
   */
  fetchPage: (cursor: TCursor | null, limit: number) => Promise<TRow[]>;
  /** Extracts the cursor value from the last row of a batch */
  getCursor: (row: TRow) => TCursor;
  /** Async processor called with each bounded page of rows */
  processBatch: (rows: TRow[]) => Promise<void>;
  /** Page size per chunk (defaults to 500) */
  pageSize?: number;
  /** Maximum number of iteration rounds (defaults to Infinity) */
  maxRounds?: number;
}

export interface KeysetCursorResult {
  totalProcessed: number;
  rounds: number;
  hasMore: boolean;
}

/**
 * Iterates through a database query using Keyset Cursor Pagination instead of OFFSET.
 * Guarantees $O(1)$ B-tree seek per page, immunity to concurrent insert/delete drift,
 * and constant $O(\text{pageSize})$ working memory.
 */
export async function paginateWithKeysetCursor<TRow, TCursor extends string | number | Date>(
  options: KeysetCursorPaginationOptions<TRow, TCursor>,
): Promise<KeysetCursorResult> {
  const pageSize = options.pageSize ?? DEFAULT_BATCH_CHUNK_SIZE;
  const maxRounds = options.maxRounds ?? Infinity;
  let cursor: TCursor | null = null;
  let totalProcessed = 0;
  let rounds = 0;
  let hasMore = false;

  while (rounds < maxRounds) {
    const rows = await options.fetchPage(cursor, pageSize);
    if (!rows.length) {
      hasMore = false;
      break;
    }

    rounds++;
    totalProcessed += rows.length;
    await options.processBatch(rows);

    if (rows.length < pageSize) {
      hasMore = false;
      break;
    }

    cursor = options.getCursor(rows[rows.length - 1]);
    hasMore = true;
  }

  return { totalProcessed, rounds, hasMore };
}

export interface BatchDeleteOptions<TTable extends PgTable> {
  /** SQL WHERE condition predicate */
  where: SQL;
  /** Primary key or unique column to target in the bounded deletion subquery */
  idColumn: PgColumn;
  /** Rows to delete per batch (defaults to 2,500) */
  batchSize?: number;
  /** Maximum deletion rounds to prevent serverless function timeouts (defaults to 100) */
  maxRounds?: number;
}

export interface BatchDeleteResult {
  totalDeleted: number;
  rounds: number;
}

/**
 * Deletes rows matching a predicate in bounded batches using subqueries.
 * Prevents long exclusive table/index write locks and WAL buffer bloat during bulk retention sweeps.
 *
 * @param conn - Database client (must be primary writer dbWrite)
 * @param table - Drizzle table
 * @param options - Predicate, ID column, batch size, and max rounds
 */
export async function batchDelete<TTable extends PgTable>(
  conn: DBClient,
  table: TTable,
  options: BatchDeleteOptions<TTable>,
): Promise<BatchDeleteResult> {
  const batchSize = options.batchSize ?? 2500;
  const maxRounds = options.maxRounds ?? 100;
  let totalDeleted = 0;
  let rounds = 0;

  while (rounds < maxRounds) {
    rounds++;

    const idSubquery = (conn as any)
      .select({ id: options.idColumn })
      .from(table)
      .where(options.where)
      .limit(batchSize);

    const deletedRows: { id: unknown }[] = await (conn as any)
      .delete(table)
      .where(inArray(options.idColumn, idSubquery))
      .returning({ id: options.idColumn });

    totalDeleted += deletedRows.length;
    if (deletedRows.length < batchSize) {
      break;
    }
  }

  return { totalDeleted, rounds };
}
