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
import { generateId } from "../../src/utils/uuid.js";
import {
  adminSettings,
  adminUsers,
  announcements,
  emailCampaigns,
  emailMessages,
  books,
  broadcasts,
  subscriptionTransactions,
  subscriptions,
  transactions,
  users,
  userAuth,
  userCompletedBooks,
  userNotifications,
  userPageProgress,
  userSessions,
  webhookDeliveries,
} from "../../src/db/schema.js";

const KNOWN_TABLES: Record<string, Table> = {
  users,
  userAuth,
  subscriptions,
  transactions,
  subscriptionTransactions,
  webhookDeliveries,
  userNotifications,
  announcements,
  emailCampaigns,
  emailMessages,
  broadcasts,
  // Book access policy + admin moderation tests (`book-access-gate`,
  // `admin-moderation`): the gate reads `books` by primary key, the admin
  // routers resolve membership from `admin_users`, and ban takedowns read the
  // `admin_settings` key-value store through `getBanPolicy`.
  books,
  adminUsers,
  adminSettings,
  // Story-reset eligibility tests (`story-reset-idempotency`,
  // `credits-cost-resolver`): `evaluateStoryReset` reads the reader's session
  // frontier, action-selection progress, and completion row to decide
  // eligibility and cost.
  userSessions,
  userPageProgress,
  userCompletedBooks,
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
  if (isSql(node) && node.queryChunks.some(chunk => typeof chunk === "object" && chunk !== null && stringChunkText(chunk).includes("COALESCE("))) {
    const prefs = row.emailPreferences;
    return !(typeof prefs === "object" && prefs !== null && "productAnnouncements" in prefs && prefs.productAnnouncements === false);
  }
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
    const list = raw.length ? raw.map((entry) =>
      entry && typeof entry === "object" && entry.constructor?.name === "Param" ? entry.value : entry,
    ) : [...operator.matchAll(/'([^']+)'/g)].map(match => match[1]);
    return list.some((entry) => entry === value);
  };
  if (/\bnot\s+in\b/i.test(operator)) return !inList();
  if (/\bin\b/i.test(operator)) return inList();
  if (/^=\s*'([^']+)'$/.test(operator)) return value === operator.match(/^=\s*'([^']+)'$/)?.[1];
  if (operator === "=") return value === rhs;
  if (operator === "!=" || operator === "<>") return value !== rhs;
  if (operator === ">") return (value as any) > (rhs as any);
  if (operator === "<") return (value as any) < (rhs as any);
  if (operator === ">=") return (value as any) >= (rhs as any);
  if (operator === "<=") return (value as any) <= (rhs as any);
  throw new Error(`FakeDb: unsupported operator "${operator}"`);
}

/** Applies a `.set()` patch value, interpreting SQL increment fragments. */
function applyPatchValue(current: unknown, next: unknown, rowId?: string): unknown {
  if (!isSql(next)) return next;
  const text = next.queryChunks.map(stringChunkText).join("");
  if (text.includes('CASE')) {
    const flatten = (node: any): any[] => node?.queryChunks ? node.queryChunks.flatMap(flatten) : [node];
    const all = flatten(next);
    for (let i = 0; i < all.length; i++) {
      if (!stringChunkText(all[i]).includes('WHEN')) continue;
      const id = all[i + 1]?.constructor?.name === 'Param' ? all[i + 1].value : all[i + 1];
      const then = all[i + 3]?.constructor?.name === 'Param' ? all[i + 3].value : all[i + 3];
      if (id === rowId) return then;
    }
    return current;
  }
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
  // Partial unique: Cap-1 singleton for announcements (at most one scheduled or active)
  {
    table: "announcements",
    columns: [],
    where: (record) => ["scheduled", "active"].includes(record.status as string),
  },
  { table: "emailCampaigns", columns: ["requestKey"] },
  { table: "emailMessages", columns: ["requestKey"] },
  { table: "emailCampaigns", columns: ["announcementId"], where: record => record.status === "queued" || record.status === "running" },
];

function assertUnique(
  table: string,
  record: Record<string, unknown>,
  store: Record<string, any[]>,
  ignoreRow?: unknown,
): void {
  for (const rule of UNIQUE_RULES) {
    if (rule.table !== table) continue;
    if (rule.where && !rule.where(record)) continue;
    const values = rule.columns.map((column) => record[column]);
    if (values.some((value) => value === null || value === undefined)) continue;
    for (const existing of store[table]) {
      if (existing === record || existing === ignoreRow) continue;
      if (rule.where && !rule.where(existing)) continue;
      if (rule.columns.every((column, index) => existing[column] === values[index])) {
        const constraintName =
          rule.columns.length > 0 ? `${table}_${rule.columns.join("_")}_unique` : "announcements_one_published_unique";
        const error = new Error(
          `duplicate key value violates unique constraint "${constraintName}"`,
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
  /** Acquisition order only; this fake does not simulate PostgreSQL lock contention. */
  locks: string[];
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
  const locks: string[] = [];

  function selectChain(projection?: any): any {
    let table: unknown = null;
    let predicate: unknown = null;
    let limit: number | null = null;
    let offsetFrom: number | null = null;
    let order: unknown[] = [];
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
      orderBy: (...next: unknown[]) => { order = next; return chain; },
      for: () => { locks.push(tableNameOf(table)); return chain; },
      innerJoin: () => chain,
      leftJoin: () => chain,
      then(resolve: (value: any) => void, reject: (error: unknown) => void) {
        try {
          let found = rows[tableNameOf(table)].map(row => ({ ...row }));
          if (predicate) found = found.filter((row) => evalSql(predicate, row));
          for (const term of [...order].reverse()) {
            if (!isSql(term)) continue;
            const key = term.queryChunks.map(jsKeyOfColumn).find(value => value !== undefined);
            if (!key) continue;
            const direction = term.queryChunks.some(chunk => stringChunkText(chunk).toLowerCase().includes("desc")) ? -1 : 1;
            found.sort((a, b) => {
              const left = a[key] instanceof Date ? a[key].getTime() : a[key];
              const right = b[key] instanceof Date ? b[key].getTime() : b[key];
              return (left < right ? -1 : left > right ? 1 : 0) * direction;
            });
          }
          if (projection && typeof projection === "object" && !Array.isArray(projection)) {
            const entries = Object.entries(projection);
            const isCount = entries.some(
              ([_, col]) =>
                isSql(col) && (col as any).queryChunks?.some((c: any) => stringChunkText(c).toLowerCase().includes("count")),
            );
            if (isCount) {
              const res: Record<string, any> = {};
              for (const [k] of entries) res[k] = found.length;
              resolve([res]);
              return undefined;
            }
            found = found.map((row) => {
              const mapped: Record<string, any> = {};
              for (const [key, col] of entries) {
                const colKey = jsKeyOfColumn(col);
                if (colKey) {
                  mapped[key] = row[colKey];
                } else if ((col as any)?.name && typeof (col as any).name === "string") {
                  mapped[key] = row[(col as any).name];
                } else {
                  mapped[key] = row[key];
                }
              }
              return mapped;
            });
          }
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
      const payloads: Record<string, unknown>[] = Array.isArray(payload) ? payload : [payload];
      const inserted: Record<string, unknown>[] = [];
      for (const item of payloads) {
      const candidate = {
        id: name === "announcements" ? (item.id ?? generateId()) : `${name}_${rows[name].length + 1}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...item,
      };
      try {
        assertUnique(name, candidate, rows);
      } catch (error) {
        const uniqueViolation =
          typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
        if (ignoreConflict && uniqueViolation) {
          continue; // ON CONFLICT DO NOTHING — no row inserted
        }
        throw error;
      }
      rows[name].push(candidate);
      inserted.push(candidate);
      }
      result = inserted;
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
          resolve(row);
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
          const name = tableNameOf(table);
          const matched: any[] = [];
          for (const row of rows[name]) {
            if (predicate && !evalSql(predicate, row)) continue;
            const updated = { ...row };
            for (const [key, value] of Object.entries(patch)) {
              updated[key] = applyPatchValue(updated[key], value, row.id);
            }
            assertUnique(name, updated, rows, row);
            Object.assign(row, updated);
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

  function deleteChain(table: unknown): any {
    let predicate: unknown = null;
    const chain: any = {
      where(next: unknown) {
        predicate = next;
        return chain;
      },
      returning: () => chain,
      then(resolve: (value: any) => void, reject: (error: unknown) => void) {
        try {
          const name = tableNameOf(table);
          const remaining: any[] = [];
          const deleted: any[] = [];
          for (const row of rows[name]) {
            if (predicate && evalSql(predicate, row)) {
              deleted.push(row);
            } else {
              remaining.push(row);
            }
          }
          rows[name] = remaining;
          if (name === "announcements") {
            for (const campaign of rows.emailCampaigns) {
              if (deleted.some(row => row.id === campaign.announcementId)) campaign.announcementId = null;
            }
          }
          resolve(deleted);
        } catch (error) {
          reject(error);
        }
        return undefined;
      },
    };
    return chain;
  }

  const dbWrite = {
    // Unit tests do not model database lock contention. Integration tests must.
    execute: async () => ({ rows: [] }),
    select: (projection?: any) => selectChain(projection),
    insert: (table: unknown) => insertChain(table),
    update: (table: unknown) => updateChain(table),
    delete: (table: unknown) => deleteChain(table),
    transaction: (callback: (tx: any) => Promise<any>) => {
      const snapshot = structuredClone(rows);
      return Promise.resolve().then(() => callback(dbWrite)).catch(error => {
        for (const name of Object.keys(rows)) rows[name] = snapshot[name];
        throw error;
      });
    },
  };

  return {
    rows,
    dbRead: { select: (projection?: any) => selectChain(projection) },
    dbWrite,
    locks,
    reset(seed = {}) {
      locks.length = 0;
      for (const name of Object.keys(KNOWN_TABLES)) {
        rows[name] = seed[name] ? [...seed[name]] : [];
      }
    },
  };
}
