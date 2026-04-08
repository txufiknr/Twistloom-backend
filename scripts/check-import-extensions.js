#!/usr/bin/env node

/**
 * check-import-extensions.js
 *
 * Scans TypeScript source files for relative imports that are missing
 * the ".js" extension — required for ESM-safe Node.js / Vercel serverless.
 *
 * Usage:
 *   node check-import-extensions.js              # scans ./src
 *   node check-import-extensions.js src/routes   # scans a specific dir
 *   node check-import-extensions.js --fix        # auto-appends .js (dry-run preview)
 *   node check-import-extensions.js --fix --write  # actually writes fixes
 *
 * Catches:
 *   import { foo } from "./bar"          ← missing .js
 *   import { foo } from "../utils/bar"   ← missing .js
 *   export { foo } from "./bar"          ← missing .js (re-exports too)
 *
 * Ignores:
 *   import { foo } from "./bar.js"       ← already correct
 *   import { foo } from "./bar.json"     ← non-JS extension, skip
 *   import type { Foo } from "some-pkg"  ← package import, not relative
 *   // import { foo } from "./bar"       ← commented out
 */

import fs from "fs";
import path from "path";

// ─── CLI Args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const shouldFix = args.includes("--fix");
const shouldWrite = args.includes("--write");
const scanDir = args.find((a) => !a.startsWith("--")) ?? "src";

// ─── Config ──────────────────────────────────────────────────────────────────

const EXTENSIONS_TO_SCAN = [".ts", ".tsx"];

/**
 * Extensions that are explicitly allowed without ".js" appended.
 * e.g. "./styles.css", "./data.json" are fine as-is.
 */
const ALLOWED_NON_JS_EXTENSIONS = new Set([
  ".json",
  ".css",
  ".scss",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".html",
  ".txt",
  ".md",
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isRelative(importPath) {
  return importPath.startsWith("./") || importPath.startsWith("../");
}

function hasKnownExtension(importPath) {
  const ext = path.extname(importPath);
  return ext.length > 0; // any extension present (.js, .ts, .json, .css, ...)
}

function isAllowedWithoutJs(importPath) {
  const ext = path.extname(importPath);
  return ALLOWED_NON_JS_EXTENSIONS.has(ext);
}

function shouldFlag(importPath) {
  if (!isRelative(importPath)) return false;       // skip packages
  if (isAllowedWithoutJs(importPath)) return false; // skip .json, .css, etc.
  if (hasKnownExtension(importPath)) return false;  // already has .js or .ts etc.
  return true;
}

/** Walk a directory recursively, yielding file paths. */
function* walkDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* walkDir(full);
    } else if (entry.isFile() && EXTENSIONS_TO_SCAN.includes(path.extname(full))) {
      yield full;
    }
  }
}

/**
 * Find all offending imports in a file.
 * Returns an array of { line, col, importPath, fullMatch } objects.
 */
function findOffenses(source) {
  const offenses = [];
  const lines = source.split("\n");

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];

    // Skip comment lines
    if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;

    // Match all imports on this line
    const lineImportRe =
      /(?:import|export)\s+(?:type\s+)?(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"]/g;

    let match;
    while ((match = lineImportRe.exec(line)) !== null) {
      const importPath = match[1];
      if (shouldFlag(importPath)) {
        offenses.push({
          line: lineIdx + 1, // 1-based
          col: match.index + 1,
          importPath,
        });
      }
    }
  }

  return offenses;
}

/**
 * Apply fix: append ".js" to all offending relative imports in source text.
 * Replaces in-string, so won't touch comments or strings that aren't imports
 * (the regex anchors on import/export keyword context).
 */
function applyFix(source) {
  // Replace bare relative imports — append .js before the closing quote
  return source.replace(
    /((?:import|export)\s+(?:type\s+)?(?:[^'"]*\s+from\s+)?)(['"])(\.{1,2}\/[^'"]+?)(\2)/g,
    (fullMatch, prefix, quote, importPath, closingQuote) => {
      if (shouldFlag(importPath)) {
        return `${prefix}${quote}${importPath}.js${closingQuote}`;
      }
      return fullMatch;
    }
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

const absoluteScanDir = path.resolve(scanDir);

if (!fs.existsSync(absoluteScanDir)) {
  console.error(`❌  Directory not found: ${absoluteScanDir}`);
  process.exit(1);
}

let totalFiles = 0;
let offendingFiles = 0;
let totalOffenses = 0;
const report = [];

for (const filePath of walkDir(absoluteScanDir)) {
  totalFiles++;
  const source = fs.readFileSync(filePath, "utf8");
  const offenses = findOffenses(source);

  if (offenses.length === 0) continue;

  offendingFiles++;
  totalOffenses += offenses.length;

  const relPath = path.relative(process.cwd(), filePath);
  report.push({ filePath, relPath, source, offenses });
}

// ─── Output ──────────────────────────────────────────────────────────────────

if (report.length === 0) {
  console.log(`✅  All relative imports have .js extensions. (${totalFiles} files scanned)`);
  process.exit(0);
}

// Print offenses
for (const { relPath, offenses } of report) {
  console.log(`\n📄  ${relPath}`);
  for (const { line, col, importPath } of offenses) {
    console.log(`    ${String(line).padStart(4)}:${String(col).padEnd(4)}  ⚠️  "${importPath}"  →  "${importPath}.js"`);
  }
}

console.log(
  `\n⚠️  Found ${totalOffenses} missing .js extension${totalOffenses !== 1 ? "s" : ""} across ${offendingFiles} file${offendingFiles !== 1 ? "s" : ""} (${totalFiles} scanned)\n`
);

// ─── Fix Mode ────────────────────────────────────────────────────────────────

if (shouldFix) {
  console.log(shouldWrite ? "🔧  Writing fixes...\n" : "🔍  Dry-run preview (pass --write to apply):\n");

  for (const { filePath, relPath, source } of report) {
    const fixed = applyFix(source);
    if (fixed === source) {
      console.log(`  ⚠️  ${relPath} — fix produced no changes (manual review needed)`);
      continue;
    }

    if (shouldWrite) {
      fs.writeFileSync(filePath, fixed, "utf8");
      console.log(`  ✅  ${relPath}`);
    } else {
      // Show a compact diff-style preview
      const originalLines = source.split("\n");
      const fixedLines = fixed.split("\n");
      console.log(`  📄  ${relPath}`);
      for (let i = 0; i < originalLines.length; i++) {
        if (originalLines[i] !== fixedLines[i]) {
          console.log(`      - ${originalLines[i].trim()}`);
          console.log(`      + ${fixedLines[i].trim()}`);
        }
      }
      console.log();
    }
  }

  if (shouldWrite) {
    console.log(`\n✅  Fixed ${report.length} file${report.length !== 1 ? "s" : ""}.`);
  }
} else {
  console.log(`💡  Run with --fix --write to auto-append .js to all offending imports.`);
}

// Exit with non-zero if offenses found (useful for CI)
if (!shouldWrite) {
  process.exit(1);
}