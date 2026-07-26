/**
 * Server-side HTML sanitization for CMS content (portal blog).
 * Strips scripts, styles, event handlers, and dangerous URIs.
 * Allows a safe subset of semantic HTML from TipTap.
 */
import sanitizeHtml from "sanitize-html";

const BLOG_HTML_CONFIG: sanitizeHtml.IOptions = {
  allowedTags: [...sanitizeHtml.defaults.allowedTags, "img"],
  allowedAttributes: {
    a: ["href", "name", "target", "rel"],
    img: ["src", "alt", "title", "width", "height", "loading"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
};

/**
 * Sanitize rich HTML from the admin TipTap editor before persistence.
 *
 * @param dirty - Untrusted HTML string from the client
 * @returns Safe HTML string safe for storage and portal `{@html}` (re-sanitized on read as defense-in-depth)
 */
export function sanitizeBlogHtml(dirty: string): string {
  if (!dirty || typeof dirty !== "string") return "";
  return sanitizeHtml(dirty.trim(), BLOG_HTML_CONFIG);
}
