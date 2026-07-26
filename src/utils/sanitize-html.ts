/**
 * Server-side HTML sanitizer for TipTap CMS content.
 * Zero external dependencies — avoids ESM/CJS module resolution issues
 * in serverless environments.
 *
 * Uses strict allowlists for tags and attributes; everything else is stripped.
 */

/** Tag allowlist (TipTap semantic subset) */
const ALLOWED_TAGS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "blockquote", "br",
  "caption", "cite", "code", "col", "colgroup",
  "data", "dd", "del", "dfn", "div", "dl", "dt",
  "em", "figcaption", "figure",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr",
  "i", "img", "ins", "kbd",
  "li", "mark", "menu",
  "ol",
  "p", "pre",
  "q", "rp", "rt", "ruby",
  "s", "samp", "small", "span", "strong", "sub", "sup",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr",
  "u", "ul", "var", "wbr",
]);

/** Per-tag attribute allowlists */
const ALLOWED_ATTRS: Record<string, ReadonlySet<string>> = {
  a:    new Set(["href", "name", "rel", "target"]),
  col:  new Set(["span"]),
  img:  new Set(["alt", "height", "loading", "src", "title", "width"]),
  li:   new Set(["value"]),
  ol:   new Set(["reversed", "start", "type"]),
  td:   new Set(["colspan", "rowspan"]),
  th:   new Set(["colspan", "rowspan", "scope"]),
};

/** Tags whose content should be fully removed (not just the tag itself) */
const REMOVE_BLOCK_TAGS = new Set([
  "button", "embed", "form", "iframe", "input",
  "noscript", "object", "option", "script", "select", "style", "textarea",
]);

const SAFE_SCHEMES = new Set(["http", "https", "mailto", "ftp"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENTITY_RE = /[&<>"']/g;
const ENTITY_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};

function esc(text: string): string {
  return text.replace(ENTITY_RE, (ch) => ENTITY_MAP[ch]);
}

function escAttr(text: string): string {
  return text.replace(/[&"]/g, (ch) => ENTITY_MAP[ch]);
}

function isSafeUrl(value: string): boolean {
  const v = value.trim();
  if (!v || /^[/#]/.test(v) || !v.includes(":")) return true;
  try {
    return SAFE_SCHEMES.has(new URL(v).protocol.slice(0, -1));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function sanitizeBlogHtml(dirty: string): string {
  if (!dirty || typeof dirty !== "string") return "";

  // 1 — Fully remove dangerous block tags and their content
  let html = dirty;
  for (const tag of REMOVE_BLOCK_TAGS) {
    html = html.replace(
      new RegExp(`<${tag}[^>]*?>[\\s\\S]*?<\\/${tag}>`, "gi"),
      "",
    );
  }

  // 2 — Strip comments, XML prologs, CDATA
  html = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");

  // 3 — Walk tag-by-tag; keep text content, filter tags/attrs
  const TAG_RE = /<\/?([\w-]+)((?:\s+(?:\w[\w-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?))*)\s*\/?>|$/g;
  const ATTR_RE = /(\w[\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;

  const out: string[] = [];
  let lastIdx = 0;

  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(html)) !== null) {
    if (match.index > lastIdx) {
      out.push(esc(html.slice(lastIdx, match.index)));
    }

    const full = match[0];
    if (!full) break;

    const tag = match[1].toLowerCase();
    const isClosing = full.startsWith("</");
    const isSelfClose = /\s\/>$/.test(full);

    if (isClosing) {
      if (ALLOWED_TAGS.has(tag)) {
        out.push(`</${tag}>`);
      }
    } else {
      if (ALLOWED_TAGS.has(tag)) {
        const allowed = ALLOWED_ATTRS[tag];
        const attrs: string[] = [];
        if (allowed) {
          let am: RegExpExecArray | null;
          while ((am = ATTR_RE.exec(match[2])) !== null) {
            const name = am[1].toLowerCase();
            const value = am[2] ?? am[3] ?? am[4] ?? "";
            if (name.startsWith("on")) continue;
            if (!allowed.has(name)) continue;
            if (name === "href" || name === "src") {
              if (!isSafeUrl(value)) continue;
            }
            attrs.push(`${name}="${escAttr(value)}"`);
          }
        }
        out.push(`<${tag}${attrs.length ? " " + attrs.join(" ") : ""}${isSelfClose ? " /" : ""}>`);
      }
    }

    lastIdx = TAG_RE.lastIndex;
  }

  if (lastIdx < html.length) {
    out.push(esc(html.slice(lastIdx)));
  }

  return out.join("");
}
