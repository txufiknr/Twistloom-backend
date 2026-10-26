import { describe, it, expect, mock } from "bun:test";
import {
  chunkArray,
  batchInsert,
  paginateWithKeysetCursor,
  POSTGRES_SAFE_PARAMETER_CEILING,
  DEFAULT_BATCH_CHUNK_SIZE,
  MAX_ADMIN_BULK_IDS,
} from "../../src/utils/batch.js";

describe("Batching & Keyset Fan-Out Primitives", () => {
  describe("chunkArray", () => {
    it("returns empty array for empty input", () => {
      expect(chunkArray([])).toEqual([]);
    });

    it("returns single chunk when items length <= chunkSize", () => {
      const items = [1, 2, 3];
      expect(chunkArray(items, 5)).toEqual([[1, 2, 3]]);
      expect(chunkArray(items, 3)).toEqual([[1, 2, 3]]);
    });

    it("chunks array correctly when length > chunkSize", () => {
      const items = [1, 2, 3, 4, 5, 6, 7];
      expect(chunkArray(items, 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    });

    it("handles default chunk size of 500", () => {
      const items = Array.from({ length: 1250 }, (_, i) => i);
      const chunks = chunkArray(items);
      expect(chunks.length).toBe(3);
      expect(chunks[0].length).toBe(DEFAULT_BATCH_CHUNK_SIZE);
      expect(chunks[1].length).toBe(DEFAULT_BATCH_CHUNK_SIZE);
      expect(chunks[2].length).toBe(250);
    });

    it("clamps invalid or 0 chunk sizes to minimum 1", () => {
      const items = [1, 2, 3];
      expect(chunkArray(items, 0)).toEqual([[1], [2], [3]]);
      expect(chunkArray(items, -10)).toEqual([[1], [2], [3]]);
    });
  });

  describe("batchInsert", () => {
    it("does nothing for empty array", async () => {
      const mockConn = {
        insert: mock(() => ({ values: mock() })),
      };
      await batchInsert(mockConn as any, {} as any, []);
      expect(mockConn.insert).not.toHaveBeenCalled();
    });

    it("dynamically clamps chunk size based on row column count", async () => {
      const insertedChunks: any[][] = [];
      const mockValues = mock((chunk: any[]) => {
        insertedChunks.push(chunk);
        return Promise.resolve();
      });
      const mockInsert = mock(() => ({ values: mockValues }));
      const mockConn = { insert: mockInsert };

      // Each row has 20 columns. Safe parameter ceiling is 60,000.
      // 60,000 / 20 = 3,000, capped at default 500.
      const rows = Array.from({ length: 1200 }, (_, i) => ({
        id: `id-${i}`,
        col1: 1, col2: 2, col3: 3, col4: 4, col5: 5,
        col6: 6, col7: 7, col8: 8, col9: 9, col10: 10,
        col11: 11, col12: 12, col13: 13, col14: 14, col15: 15,
        col16: 16, col17: 17, col18: 18, col19: 19,
      }));

      await batchInsert(mockConn as any, {} as any, rows);

      expect(mockInsert).toHaveBeenCalledTimes(3);
      expect(insertedChunks.length).toBe(3);
      expect(insertedChunks[0].length).toBe(500);
      expect(insertedChunks[1].length).toBe(500);
      expect(insertedChunks[2].length).toBe(200);
    });

    it("clamps chunk size below 500 when column count is extremely high", async () => {
      const insertedChunks: any[][] = [];
      const mockValues = mock((chunk: any[]) => {
        insertedChunks.push(chunk);
        return Promise.resolve();
      });
      const mockInsert = mock(() => ({ values: mockValues }));
      const mockConn = { insert: mockInsert };

      // Create an object with 200 keys
      const wideRow: Record<string, number> = {};
      for (let k = 0; k < 200; k++) wideRow[`col_${k}`] = k;

      // 60,000 / 200 = 300 maximum rows per chunk
      const rows = Array.from({ length: 700 }, () => ({ ...wideRow }));

      await batchInsert(mockConn as any, {} as any, rows);

      expect(mockInsert).toHaveBeenCalledTimes(3);
      expect(insertedChunks[0].length).toBe(300);
      expect(insertedChunks[1].length).toBe(300);
      expect(insertedChunks[2].length).toBe(100);
    });

    it("applies onConflictDoNothing when requested", async () => {
      const mockDoNothing = mock(() => Promise.resolve());
      const mockValues = mock(() => ({ onConflictDoNothing: mockDoNothing }));
      const mockInsert = mock(() => ({ values: mockValues }));
      const mockConn = { insert: mockInsert };

      const rows = [{ id: "1" }, { id: "2" }];
      await batchInsert(mockConn as any, {} as any, rows, { onConflictDoNothing: true });

      expect(mockDoNothing).toHaveBeenCalledTimes(1);
    });
  });

  describe("paginateWithKeysetCursor", () => {
    it("handles empty results gracefully", async () => {
      const fetchPage = mock(() => Promise.resolve([]));
      const processBatch = mock(() => Promise.resolve());

      const result = await paginateWithKeysetCursor({
        fetchPage,
        getCursor: (row: any) => row.id,
        processBatch,
        pageSize: 10,
      });

      expect(result).toEqual({ totalProcessed: 0, rounds: 0, hasMore: false });
      expect(fetchPage).toHaveBeenCalledTimes(1);
      expect(processBatch).not.toHaveBeenCalled();
    });

    it("iterates multiple pages passing cursor of last item", async () => {
      const pages: Record<string, any[]> = {
        initial: [{ id: "a" }, { id: "b" }],
        b: [{ id: "c" }, { id: "d" }],
        d: [{ id: "e" }],
      };

      const fetchPage = mock((cursor: string | null, limit: number) => {
        const key = cursor === null ? "initial" : cursor;
        return Promise.resolve(pages[key] ?? []);
      });

      const processed: string[] = [];
      const processBatch = mock(async (rows: any[]) => {
        processed.push(...rows.map((r) => r.id));
      });

      const result = await paginateWithKeysetCursor({
        fetchPage,
        getCursor: (row: any) => row.id,
        processBatch,
        pageSize: 2,
      });

      expect(result).toEqual({ totalProcessed: 5, rounds: 3, hasMore: false });
      expect(processed).toEqual(["a", "b", "c", "d", "e"]);
      expect(fetchPage).toHaveBeenCalledTimes(3);
    });

    it("respects maxRounds limit", async () => {
      const fetchPage = mock((cursor: string | null) => {
        return Promise.resolve([{ id: "1" }, { id: "2" }]);
      });
      const processBatch = mock(() => Promise.resolve());

      const result = await paginateWithKeysetCursor({
        fetchPage,
        getCursor: (row: any) => row.id,
        processBatch,
        pageSize: 2,
        maxRounds: 2,
      });

      expect(result.rounds).toBe(2);
      expect(result.totalProcessed).toBe(4);
      expect(result.hasMore).toBe(true);
      expect(fetchPage).toHaveBeenCalledTimes(2);
    });
  });

  describe("Constants", () => {
    it("defines secure parameter ceilings", () => {
      expect(POSTGRES_SAFE_PARAMETER_CEILING).toBeLessThan(65_535);
      expect(DEFAULT_BATCH_CHUNK_SIZE).toBe(500);
      expect(MAX_ADMIN_BULK_IDS).toBe(100);
    });
  });
});
