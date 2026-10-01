/**
 * In-memory stand-in for `src/db/client.js` used by store-verification tests.
 *
 * The real module needs a live database; these tests only need deterministic
 * rows. Drizzle predicates (`eq`/`and`/`inArray`/comparisons) are evaluated
 * against those rows so a test cannot observe a result a real database would
 * not produce — filtering is the entire point of the ownership and
 * idempotency reads (`type = 'first_purchase_bonus'`, gateway/payment-id
 * lookups), and ignoring `.where()` would make those assertions lie. Unique
 * constraints (including the partial one-bonus-per-user index) and
 * `ON CONFLICT DO NOTHING` are reproduced too — see `UNIQUE_RULES`.
 *
 * SQL fragments used as update values (e.g. `` sql`${users.credits} + ${n}` ``)
 * are interpreted for the `+`/`-` increment forms only; anything else is
 * rejected loudly rather than silently writing an `SQL` object into a row.
 *
 * ## Mock-restore rule for consumer test files
 * Bun's `mock.module()` is process-global and `mock.restore()` does NOT revert
 * module mocks. Every test file that mocks `../src/db/client.js` (or any other
 * `src/` module) must capture the actual namespace BEFORE its `mock.module`
 * call and re-register it in `afterAll`:
 *
 * ```ts
 * const actualDbClient = await import("../src/db/client.js");
 * mock.module("../src/db/client.js", () => ({ ...actualDbClient, /* fakes *\/ }));
 * afterAll(() => { mock.module("../src/db/client.js", () => actualDbClient); });
 * ```
 *
 * Otherwise the mock leaks into every later test file in the process and the
 * suite becomes alphabetically order-dependent.
 */

import { Table } from "drizzle-orm";
import {
  adminSettings,
  adminUsers,
  books,
  subscriptionTransactions,
  subscriptions,
  transactions,
  users,
  userNotifications,
  webhookDeliveries,
} from "../../src/db/schema.js";

const KNOWN_TABLES: Record<string, Table> = {
  users,
  subscriptions,
  transactions,
  subscriptionTransactions,
  webhookDeliveries,
  userNotifications,
  // Book access policy + admin moderation tests (`book-access-gate`,
  // `admin-moderation`): the gate reads `books` by primary key, the admin
  // routers resolve membership from `admin_users`, and ban takedowns read the
  // `admin_settings` key-value store through `getBanPolicy`.
  books,
  adminUsers,
  adminSettings,
};

const TABLE_NAMES = new Map<Table, string>(
  Object.entries(KNOWN_TABLES).map(([name, table]) => [table, name]),
);

function tableNameOf(table: unknown): string {
  const name = TABLE_NAMES.get(table as Table);
  if (!name) throw new Error(`FakeDb: unexpected table ${String(table)}`);
  return name;
}

function jsKeyOfColumn(column: any): string | undefined {
  const columns = column?.table?.[Table.Symbol.Columns];
  if (!columns) return undefined;
  for (const [key, value] of Object.entries(columns)) {
    if (value === column) return key;
  }
  return undefined;
}

function isSql(value: unknown): value is { queryChunks: unknown[] } {
  return !!value && typeof value === "object" && Array.isArray((value as any).queryChunks);
}

function stringChunkText(chunk: any): string {
  return chunk?.constructor?.name === "StringChunk" ? chunk.value.join("") : "";
}

/** Evaluates a drizzle boolean expression against one row. */
export function evalSql(node: unknown, row: Record<string, unknown>): boolean {
  const chunks: any[] = (node as any)?.queryChunks ?? [];

  // Composite expressions are nested SQL nodes joined by " and "/" or ".
  if (chunks.some((chunk) => chunk?.queryChunks)) {
    let result: boolean | null = null;
    let connector = "and";
    for (const chunk of chunks) {
      if (chunk?.queryChunks) {
        const value = evalSql(chunk, row);
        result = result === null ? value : connector === "and" ? result && value : result || value;
      } else {
        const text = stringChunkText(chunk).trim().toLowerCase();
        if (text === "and" || text === "or") connector = text;
      }
    }
    return result ?? true;
  }

  const columnAt = chunks.findIndex(
    (chunk) => chunk && typeof chunk === "object" && chunk.table && typeof chunk.name === "string",
  );
  if (columnAt === -1) return true;

  const key = jsKeyOfColumn(chunks[columnAt]);
  if (!key) return true;

  const operator = chunks
    .slice(columnAt + 1)
    .map(stringChunkText)
    .join("")
    .trim();
  const rhsChunk = chunks[columnAt + 2];
  const rhs =
    rhsChunk?.constructor?.name === "Param"
      ? rhsChunk.value
      : Array.isArray(rhsChunk)
        ? rhsChunk
        : rhsChunk === null || typeof rhsChunk !== "object"
          ? rhsChunk
          : undefined;
  const value = row[key];

  if (operator.includes("is not null")) return value !== null && value !== undefined;
  if (operator.includes("is null")) return value === null || value === undefined;
  // `not in` / `in`. Drizzle emits `` col in (…) `` as a StringChunk, a
  // column, a `" in "` StringChunk, then either a plain Array of Param objects
  // or one Param per value — unwrap both shapes to plain JS values.
  // `not in` must be tested FIRST: the `in` pattern also matches inside it,
  // which would silently invert every `notInArray` predicate.
  const inList = (): boolean => {
    const raw = Array.isArray(rhs)
      ? rhs
      : chunks
          .slice(columnAt + 2)
          .filter((chunk) => chunk && chunk.constructor?.name === "Param")
          .map((chunk) => chunk.value);
    const list = raw.map((entry) =>
      entry && typeof entry === "object" && entry.constructor?.name === "Param" ? entry.value : entry,
    );
    return list.some((entry) => entry === value);
  };
  if (/\bnot\s+in\b/.test(operator)) return !inList();
  if (/\bin\b/.test(operator)) return inList();
  if (operator === "=") return value === rhs;
  if (operator === "!=" || operator === "<>") return value !== rhs;
  if (operator === ">") return (value as any) > (rhs as any);
  if (operator === "<") return (value as any) < (rhs as any);
  if (operator === ">=") return (value as any) >= (rhs as any);
  if (operator === "<=") return (value as any) <= (rhs as any);
  throw new Error(`FakeDb: unsupported operator "${operator}"`);
}

/** Applies a `.set()` patch value, interpreting SQL increment fragments. */
function applyPatchValue(current: unknown, next: unknown): unknown {
  if (!isSql(next)) return next;
  const text = next.queryChunks.map(stringChunkText).join("");
  // Drizzle pushes literal numbers raw and strings as `Param`; accept both.
  const params = next.queryChunks.filter(
    (chunk: any) =>
      chunk === null || typeof chunk !== "object" || chunk?.constructor?.name === "Param",
  );
  const last = params[params.length - 1];
  const amount = last?.constructor?.name === "Param" ? last.value : last;
  if (text.includes("+")) return (current as number) + Number(amount);
  if (text.includes("-")) return (current as number) - Number(amount);
  throw new Error(`FakeDb: unsupported SQL update fragment "${text.trim()}"`);
}

/**
 * Unique indexes the real schema enforces, partial indexes included.
 * Reproduced because the grant layer's idempotency is defined by these
 * constraints, not by an application flag — a fake that lets duplicate rows
 * in would prove nothing. As in PostgreSQL: rows where every key column is
 * NULL are not compared, and a rule with `where` only applies to rows its
 * predicate accepts (the partial-index semantics of
 * `transactions_user_first_purchase_bonus_unique`).
 */
const UNIQUE_RULES: Array<{
  table: string;
  columns: string[];
  /** Partial-index predicate; the rule applies only to matching rows. */
  where?: (record: Record<string, unknown>) => boolean;
}> = [
  { table: "subscriptions", columns: ["gateway", "providerSubscriptionId"] },
  { table: "transactions", columns: ["gateway", "providerPaymentId"] },
  { table: "transactions", columns: ["gateway", "providerEventId"] },
  { table: "subscriptionTransactions", columns: ["gateway", "providerInvoiceId"] },
  { table: "webhookDeliveries", columns: ["gateway", "eventId"] },
  // Partial unique: one `first_purchase_bonus` row per user.
  {
    table: "transactions",
    columns: ["userId"],
    where: (record) => record.type === "first_purchase_bonus",
  },
];

function assertUnique(table: string, record: Record<string, unknown>, store: Record<string, any[]>): void {
  for (const rule of UNIQUE_RULES) {
    if (rule.table !== table) continue;
    if (rule.where && !rule.where(record)) continue;
    const values = rule.columns.map((column) => record[column]);
    if (values.some((value) => value === null || value === undefined)) continue;
    for (const existing of store[table]) {
      if (rule.where && !rule.where(existing)) continue;
      if (rule.columns.every((column, index) => existing[column] === values[index])) {
        const error = new Error(
          `duplicate key value violates unique constraint "${table}_${rule.columns.join("_")}_unique"`,
        ) as Error & { code: string };
        error.code = "23505";
        throw error;
      }
    }
  }
}

export interface FakeDb {
  /** Row store, keyed by schema name (`users`, `subscriptions`, …). */
  rows: Record<string, any[]>;
  dbRead: any;
  dbWrite: any;
  /** Replaces every table's rows (call between tests). */
  reset(seed?: Partial<Record<string, any[]>>): void;
}

/**
 * Builds the `dbRead`/`dbWrite` pair.
 *
 * Every chain is thenable, so `await … .limit(1)` resolves to the filtered
 * rows; `transaction(cb)` runs `cb` against the same row store.
 */
export function createFakeDb(): FakeDb {
  const rows: Record<string, any[]> = Object.fromEntries(Object.keys(KNOWN_TABLES).map((name) => [name, []]));

  function selectChain(): any {
    let table: unknown = null;
    let predicate: unknown = null;
    let limit: number | null = null;
    let offsetFrom: number | null = null;
    const chain: any = {
      from(next: unknown) {
        table = next;
        return chain;
      },
      where(next: unknown) {
        predicate = next;
        return chain;
      },
      limit(next: number) {
        limit = next;
        return chain;
      },
      offset(next: number) {
        offsetFrom = next;
        return chain;
      },
      orderBy: () => chain,
      for: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      then(resolve: (value: any) => void, reject: (error: unknown) => void) {
        try {
          let found = [...rows[tableNameOf(table)]];
          if (predicate) found = found.filter((row) => evalSql(predicate, row));
          // SQL applies OFFSET before LIMIT; admin list endpoints rely on it.
          if (offsetFrom !== null) found = found.slice(offsetFrom);
          if (limit !== null) found = found.slice(0, limit);
          resolve(found);
        } catch (error) {
          reject(error);
        }
        return undefined;
      },
    };
    return chain;
  }

  function insertChain(table: unknown): any {
    let payload: any = null;
    let settled = false;
    let result: any = null;
    let ignoreConflict = false;
    const commit = () => {
      if (settled) return result;
      settled = true;
      const name = tableNameOf(table);
      const candidate = { id: `${name}_${rows[name].length + 1}`, ...payload };
      try {
        assertUnique(name, candidate, rows);
      } catch (error) {
        const uniqueViolation =
          typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
        if (ignoreConflict && uniqueViolation) {
          result = undefined; // ON CONFLICT DO NOTHING — no row inserted
          return result;
        }
        throw error;
      }
      result = candidate;
      rows[name].push(candidate);
      return result;
    };
    const chain: any = {
      values(next: any) {
        payload = next;
        return chain;
      },
      returning: () => chain,
      onConflictDoNothing: () => {
        ignoreConflict = true;
        return chain;
      },
      then(resolve: (value: any) => void, reject: (error: unknown) => void) {
        try {
          const row = commit();
          resolve(row === undefined ? [] : [row]);
        } catch (error) {
          reject(error);
        }
        return undefined;
      },
    };
    return chain;
  }

  function updateChain(table: unknown): any {
    let predicate: unknown = null;
    let patch: Record<string, unknown> = {};
    const chain: any = {
      set(next: Record<string, unknown>) {
        patch = next;
        return chain;
      },
      where(next: unknown) {
        predicate = next;
        return chain;
      },
      // Mirrors drizzle `.returning()`: resolves the AFFECTED rows (Postgres
      // returns post-update values). Always collected — callers without
      // `.returning()` ignore the array exactly as before.
      returning: () => chain,
      then(resolve: (value: any) => void, reject: (error: unknown) => void) {
        try {
          const matched: any[] = [];
          for (const row of rows[tableNameOf(table)]) {
            if (predicate && !evalSql(predicate, row)) continue;
            for (const [key, value] of Object.entries(patch)) {
              row[key] = applyPatchValue(row[key], value);
            }
            matched.push({ ...row });
          }
          resolve(matched);
        } catch (error) {
          reject(error);
        }
        return undefined;
      },
    };
    return chain;
  }

  const dbWrite = {
    select: () => selectChain(),
    insert: (table: unknown) => insertChain(table),
    update: (table: unknown) => updateChain(table),
    delete: () => {
      throw new Error("FakeDb: delete is not used by these tests");
    },
    transaction: (callback: (tx: any) => Promise<any>) => Promise.resolve().then(() => callback(dbWrite)),
  };

  return {
    rows,
    dbRead: { select: () => selectChain() },
    dbWrite,
    reset(seed = {}) {
      for (const name of Object.keys(KNOWN_TABLES)) {
        rows[name] = seed[name] ? [...seed[name]] : [];
      }
    },
  };
}
