/**
 * In-memory stand-in for `src/db/client.js` used by store-verification tests.
 *
 * The real module needs a live database; these tests only need deterministic
 * rows. Drizzle predicates (`eq`/`and`/`inArray`/comparisons) are evaluated
 * against those rows so a test cannot observe a result a real database would
 * not produce — filtering is the entire point of the
 * `type = 'first_purchase_bonus'` check, and ignoring `.where()` would make
 * that assertion lie.
 *
 * SQL fragments used as update values (e.g. `` sql`${users.credits} + ${n}` ``)
 * are interpreted for the `+`/`-` increment forms only; anything else is
 * rejected loudly rather than silently writing an `SQL` object into a row.
 */

import { Table } from "drizzle-orm";
import {
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
  if (operator.includes(" in ")) return Array.isArray(rhs) && rhs.includes(value);
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
 * Composite unique indexes the real schema enforces. Reproduced because the
 * grant layer's idempotency is defined by these constraints, not by an
 * application flag — a fake that lets duplicate rows in would prove nothing.
 * As in PostgreSQL, rows where every key column is NULL are not compared.
 */
const UNIQUE_RULES: Array<{ table: string; columns: string[] }> = [
  { table: "subscriptions", columns: ["gateway", "providerSubscriptionId"] },
  { table: "transactions", columns: ["gateway", "providerPaymentId"] },
  { table: "transactions", columns: ["gateway", "providerEventId"] },
  { table: "subscriptionTransactions", columns: ["gateway", "providerInvoiceId"] },
  { table: "webhookDeliveries", columns: ["gateway", "eventId"] },
];

function assertUnique(table: string, record: Record<string, unknown>, store: Record<string, any[]>): void {
  for (const rule of UNIQUE_RULES) {
    if (rule.table !== table) continue;
    const values = rule.columns.map((column) => record[column]);
    if (values.some((value) => value === null || value === undefined)) continue;
    for (const existing of store[table]) {
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
      orderBy: () => chain,
      for: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      then(resolve: (value: any) => void, reject: (error: unknown) => void) {
        try {
          let found = [...rows[tableNameOf(table)]];
          if (predicate) found = found.filter((row) => evalSql(predicate, row));
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
    let committed: any = null;
    const commit = () => {
      if (committed) return committed;
      const name = tableNameOf(table);
      committed = { id: `${name}_${rows[name].length + 1}`, ...payload };
      assertUnique(name, committed, rows);
      rows[name].push(committed);
      return committed;
    };
    const chain: any = {
      values(next: any) {
        payload = next;
        return chain;
      },
      returning: () => chain,
      onConflictDoNothing: () => chain,
      then(resolve: (value: any) => void, reject: (error: unknown) => void) {
        try {
          resolve([commit()]);
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
      then(resolve: (value: any) => void, reject: (error: unknown) => void) {
        try {
          for (const row of rows[tableNameOf(table)]) {
            if (predicate && !evalSql(predicate, row)) continue;
            for (const [key, value] of Object.entries(patch)) {
              row[key] = applyPatchValue(row[key], value);
            }
          }
          resolve([]);
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
