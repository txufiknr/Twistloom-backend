import { describe, expect, it } from "bun:test";
import { getBookPageCacheControl } from "../src/services/book-page-cache.js";

describe("reader page cache policy", () => {
  it("does not cache authenticated page projections", () => {
    expect(getBookPageCacheControl("reader-1")).toBe("private, no-store");
  });

  it("keeps a short public cache for anonymous page projections", () => {
    expect(getBookPageCacheControl()).toBe("public, max-age=60");
    expect(getBookPageCacheControl(null)).toBe("public, max-age=60");
  });
});