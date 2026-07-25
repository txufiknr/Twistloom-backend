/**
 * @summary Best-effort extraction of Twistloom book links from free-form text.
 * @description Used by the social-mention ingestion cron and admin "paste URL"
 * flows so both paths share identical host allowlists and path parsers.
 *
 * Product rules (SOCIAL_TESTIMONY_INGESTION_ENHANCEMENT.md D2/D3/D6):
 * - Only first-party hosts (FRONTEND_URL + SOCIAL_MENTION_LINK_HOSTS + defaults)
 * - Only public+active books are resolved for auto-link
 * - Deep page ids may be stored but Read CTA defaults to book landing
 */

import { and, eq, sql } from "drizzle-orm";
import { dbRead } from "../../db/client.js";
import { books, uploadedImages } from "../../db/schema.js";

/** Path patterns that identify a Twistloom product URL inside free text. */
const TWISTLOOM_PATH_RE =
  /(?:https?:\/\/[^\s<>"')\]]+)|(?:www\.[^\s<>"')\]]+)/gi;

const BOOKS_PATH_RE =
  /^(?:\/(?:en|id|es|fr|de|ja|ko|zh|pt|ru))?\/books\/([a-zA-Z0-9][a-zA-Z0-9\-_]*)(?:\/([0-9a-fA-F-]{36}))?(?:[/?#]|$)/i;

const SHARE_PATH_RE =
  /^(?:\/(?:en|id|es|fr|de|ja|ko|zh|pt|ru))?\/share\/[^/]+\/([a-zA-Z0-9][a-zA-Z0-9\-_]*)(?:\/([0-9a-fA-F-]{36}))?(?:[/?#]|$)/i;

const bookCoverImageSql = sql<string | null>`(
  SELECT ui.image_url FROM ${uploadedImages} ui WHERE ui.image_id = ${books.imageId} LIMIT 1
)`.as("image_url");

export type RelatedBookSource = "auto" | "admin";

export interface ExtractedTwistloomLink {
  /** Book slug from /books/:slug or /share/.../:bookSlug */
  slug: string;
  /** Optional page UUID when present in the URL */
  pageId: string | null;
  /** Matched absolute or path-only URL (for logging) */
  matchedUrl: string;
  /** Path kind used for resolution */
  kind: "books" | "share";
}

export interface ResolvedPublicBookLink {
  bookId: string;
  slug: string;
  title: string;
  imageUrl: string | null;
  pageId: string | null;
  source: RelatedBookSource;
}

/**
 * Builds the set of hostnames treated as first-party Twistloom frontends.
 * Defaults always include production; FRONTEND_URL and SOCIAL_MENTION_LINK_HOSTS extend the list.
 */
export function getTwistloomLinkHosts(): Set<string> {
  const hosts = new Set<string>([
    "twistloom.com",
    "www.twistloom.com",
    "twistloom-web.vercel.app",
  ]);

  const frontendUrl = process.env.FRONTEND_URL;
  if (frontendUrl) {
    try {
      hosts.add(new URL(frontendUrl).hostname.toLowerCase());
    } catch {
      // ignore malformed FRONTEND_URL
    }
  }

  const extra = process.env.SOCIAL_MENTION_LINK_HOSTS;
  if (extra) {
    for (const part of extra.split(",")) {
      const host = part.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
      if (host) hosts.add(host);
    }
  }

  return hosts;
}

/**
 * Parses a single URL (absolute or path starting with /) into a book slug + optional page.
 * Returns null when the URL is not a first-party Twistloom book/share path.
 */
export function parseTwistloomProductUrl(
  rawUrl: string,
  allowedHosts: Set<string> = getTwistloomLinkHosts(),
): ExtractedTwistloomLink | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let pathname: string;

  if (trimmed.startsWith("/")) {
    pathname = trimmed;
  } else {
    let candidate = trimmed;
    if (!/^https?:\/\//i.test(candidate)) {
      candidate = `https://${candidate}`;
    }
    try {
      const parsed = new URL(candidate);
      const hostname = parsed.hostname.toLowerCase();
      pathname = parsed.pathname + (parsed.search || "");
      if (!allowedHosts.has(hostname)) {
        return null;
      }
    } catch {
      return null;
    }
  }

  const pathOnly = pathname.split("?")[0].split("#")[0] || "/";

  const booksMatch = pathOnly.match(BOOKS_PATH_RE);
  if (booksMatch) {
    return {
      slug: booksMatch[1],
      pageId: booksMatch[2] ?? null,
      matchedUrl: trimmed,
      kind: "books",
    };
  }

  const shareMatch = pathOnly.match(SHARE_PATH_RE);
  if (shareMatch) {
    return {
      slug: shareMatch[1],
      pageId: shareMatch[2] ?? null,
      matchedUrl: trimmed,
      kind: "share",
    };
  }

  return null;
}

/**
 * Scans free-form title + body text for the first Twistloom product URL.
 */
export function extractTwistloomLinkFromText(
  title: string | null | undefined,
  content: string | null | undefined,
): ExtractedTwistloomLink | null {
  const combined = `${title ?? ""}\n${content ?? ""}`;
  const allowedHosts = getTwistloomLinkHosts();

  const absoluteMatches = combined.match(TWISTLOOM_PATH_RE) ?? [];
  for (const match of absoluteMatches) {
    const cleaned = match.replace(/[.,;:!?)]+$/, "");
    const parsed = parseTwistloomProductUrl(cleaned, allowedHosts);
    if (parsed) return parsed;
  }

  const pathOnlyRe = /(?:^|\s)(\/(?:en|id)?\/?(?:books|share)\/[^\s<>"')\]]+)/gi;
  let pathMatch: RegExpExecArray | null;
  while ((pathMatch = pathOnlyRe.exec(combined)) !== null) {
    const cleaned = pathMatch[1].replace(/[.,;:!?)]+$/, "");
    const parsed = parseTwistloomProductUrl(cleaned, allowedHosts);
    if (parsed) return parsed;
  }

  return null;
}

/**
 * Resolves a book slug to a public+active book id suitable for homepage CTAs.
 * Returns null when the book is missing, not public, or not active (D3).
 */
export async function resolvePublicBookBySlug(
  slug: string,
): Promise<{ bookId: string; slug: string; title: string; imageUrl: string | null } | null> {
  const [row] = await dbRead
    .select({
      bookId: books.id,
      slug: books.slug,
      title: books.title,
      imageUrl: bookCoverImageSql,
    })
    .from(books)
    .where(and(eq(books.slug, slug), eq(books.status, "active"), eq(books.visibility, "public")))
    .limit(1);

  if (!row?.slug) return null;

  return {
    bookId: row.bookId,
    slug: row.slug,
    title: row.title,
    imageUrl: row.imageUrl,
  };
}

/**
 * Resolves a book by id only when it is still public+active (wall CTA eligibility).
 */
export async function resolvePublicBookById(
  bookId: string,
): Promise<{ bookId: string; slug: string; title: string; imageUrl: string | null } | null> {
  const [row] = await dbRead
    .select({
      bookId: books.id,
      slug: books.slug,
      title: books.title,
      imageUrl: bookCoverImageSql,
    })
    .from(books)
    .where(and(eq(books.id, bookId), eq(books.status, "active"), eq(books.visibility, "public")))
    .limit(1);

  if (!row?.slug) return null;

  return {
    bookId: row.bookId,
    slug: row.slug,
    title: row.title,
    imageUrl: row.imageUrl,
  };
}

/**
 * Looks up a book by id for admin validation (any visibility). Returns null if missing.
 * Public-wall CTA eligibility is still enforced via resolvePublicBookById at read time.
 */
export async function resolveBookByIdForAdmin(
  bookId: string,
): Promise<{ bookId: string; slug: string | null; title: string; isPublicActive: boolean } | null> {
  const [row] = await dbRead
    .select({
      bookId: books.id,
      slug: books.slug,
      title: books.title,
      status: books.status,
      visibility: books.visibility,
    })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);

  if (!row) return null;

  return {
    bookId: row.bookId,
    slug: row.slug,
    title: row.title,
    isPublicActive: row.status === "active" && row.visibility === "public",
  };
}

/**
 * Extracts a Twistloom link from text and resolves it to a public book when possible.
 */
export async function extractAndResolveTwistloomLink(
  title: string | null | undefined,
  content: string | null | undefined,
  source: RelatedBookSource = "auto",
): Promise<ResolvedPublicBookLink | null> {
  const extracted = extractTwistloomLinkFromText(title, content);
  if (!extracted) return null;

  const book = await resolvePublicBookBySlug(extracted.slug);
  if (!book) return null;

  return {
    bookId: book.bookId,
    slug: book.slug,
    title: book.title,
    imageUrl: book.imageUrl,
    pageId: extracted.pageId,
    source,
  };
}

/**
 * Builds locale-agnostic Read href (landing page). Deep links are admin-promoted later (D2).
 */
export function buildBookReadHref(slug: string): string {
  return `/books/${slug}`;
}
