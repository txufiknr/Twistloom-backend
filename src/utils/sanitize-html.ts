/**
 * Server-side HTML sanitization for CMS content (portal blog).
 * Strips scripts, styles, event handlers, and dangerous URIs.
 * Allows a safe subset of semantic HTML from TipTap.
 */
import DOMPurify from "isomorphic-dompurify";

const BLOG_HTML_CONFIG: Parameters<typeof DOMPurify.sanitize>[1] = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input", "button"],
  FORBID_ATTR: ["style", "srcset"],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ["target", "rel"],
};

/**
 * Sanitize rich HTML from the admin TipTap editor before persistence.
 *
 * @param dirty - Untrusted HTML string from the client
 * @returns Safe HTML string safe for storage and portal `{@html}` (re-sanitized on read as defense-in-depth)
 */
export function sanitizeBlogHtml(dirty: string): string {
  if (!dirty || typeof dirty !== "string") return "";
  return DOMPurify.sanitize(dirty.trim(), BLOG_HTML_CONFIG);
}
