/**
 * Server-side HTML sanitization for CMS content (portal blog).
 * Uses `ultrahtml` — a lightweight, ESM-native HTML transformer
 * with zero dependencies — to parse and filter TipTap HTML.
 */
import { transform, walkSync, ELEMENT_NODE, COMMENT_NODE } from "ultrahtml";
import sanitize from "ultrahtml/transformers/sanitize";

// ---------------------------------------------------------------------------
// Allowlists
// ---------------------------------------------------------------------------

/** Tags allowed through the sanitizer */
const ALLOWED_ELEMENTS = [
  "a", "abbr", "b", "bdi", "bdo", "blockquote", "br",
  "caption", "cite", "code", "col", "colgroup",
  "data", "dd", "del", "dfn", "div", "dl", "dt",
  "em", "figcaption", "figure",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr",
  "i", "img", "ins", "kbd",
  "li", "mark", "menu",
  "ol", "p", "pre",
  "q", "rp", "rt", "ruby",
  "s", "samp", "small", "span", "strong", "sub", "sup",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr",
  "u", "ul", "var", "wbr",
];

/** Tags (and their content) to fully drop */
const DROP_ELEMENTS = [
  "button", "embed", "form", "iframe", "input",
  "noscript", "object", "option", "script", "select", "style", "textarea",
];

/** Per-tag allowed attributes */
const ALLOWED_ATTRS: Record<string, ReadonlySet<string>> = {
  a:    new Set(["href", "name", "rel", "target"]),
  col:  new Set(["span"]),
  img:  new Set(["alt", "height", "loading", "src", "title", "width"]),
  li:   new Set(["value"]),
  ol:   new Set(["reversed", "start", "type"]),
  td:   new Set(["colspan", "rowspan"]),
  th:   new Set(["colspan", "rowspan", "scope"]),
};

const SAFE_URL_SCHEMES = new Set(["http", "https", "mailto", "ftp"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSafeUrl(value: string): boolean {
  const v = value.trim();
  if (!v || /^[/#]/.test(v) || !v.includes(":")) return true;
  try {
    return SAFE_URL_SCHEMES.has(new URL(v).protocol.slice(0, -1));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Custom transformers
// ---------------------------------------------------------------------------

/**
 * Strip attributes not in the allowlist per tag, remove event handlers,
 * and sanitize `href` / `src` URLs.
 */
function sanitizeAttrs() {
  return (doc: any) => {
    walkSync(doc, (node: any) => {
      if (node.type !== ELEMENT_NODE) return;
      const attrs: Record<string, string> = node.attributes;
      const allowed = ALLOWED_ATTRS[node.name as string];
      if (!allowed) {
        node.attributes = {};
        return;
      }
      for (const key of Object.keys(attrs)) {
        if (!allowed.has(key) || key.startsWith("on")) {
          delete attrs[key];
          continue;
        }
        if (key === "href" || key === "src") {
          if (!isSafeUrl(attrs[key])) {
            delete attrs[key];
          }
        }
      }
    });
    return doc;
  };
}

/** Remove comment nodes from the AST. */
function removeComments() {
  return (doc: any) => {
    const removals: Array<{ parent: any; child: any }> = [];
    walkSync(doc, (node: any, parent: any) => {
      if (node.type === COMMENT_NODE) {
        removals.push({ parent, child: node });
      }
    });
    for (const { parent, child } of removals) {
      const children: any[] | undefined = parent.children;
      if (children) {
        const idx = children.indexOf(child);
        if (idx !== -1) children.splice(idx, 1);
      }
    }
    return doc;
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const SANITIZE_BLOG = sanitize({
  allowElements: ALLOWED_ELEMENTS,
  dropElements: DROP_ELEMENTS,
  allowComments: false,
});

const TRANSFORMERS = [SANITIZE_BLOG, sanitizeAttrs(), removeComments()];

/**
 * Lightweight HTML tag stripper for plain-text inputs (custom actions,
 * hint purchase text, etc.). No dependencies — synchronous.
 *
 * Removes all HTML tags (including self-closing) and decodes common
 * HTML entities back to their plain-text equivalents.
 *
 * @param text - Raw text that may contain HTML markup
 * @returns Plain text with tags stripped and entities decoded
 */
export function stripHtml(text: string): string {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;|&#47;/g, "/")
    .trim();
}

/**
 * Sanitize rich HTML from the admin TipTap editor before persistence.
 *
 * @param dirty - Untrusted HTML string from the client
 * @returns Safe HTML string safe for storage and portal `{@html}` (re-sanitized on read as defense-in-depth)
 */
export async function sanitizeBlogHtml(dirty: string): Promise<string> {
  if (!dirty || typeof dirty !== "string") return "";
  return transform(dirty.trim(), TRANSFORMERS);
}
