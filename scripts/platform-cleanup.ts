/**
 * Platform artifact lifecycle: status / cleanup for the Vercel and Netlify
 * deployment adapters.
 *
 * Twistloom keeps **both** deployment adapters in the repository so either
 * platform can serve traffic at any time (the current setup is deliberately
 * dual-track). This script performs the *destructive* half — deleting one
 * platform's files and stripping its code from shared modules — only when you
 * explicitly decide that platform is retired.
 *
 * Usage:
 *   bun scripts/platform-cleanup.ts status              # what is present right now
 *   bun scripts/platform-cleanup.ts vercel              # dry-run Vercel cleanup
 *   bun scripts/platform-cleanup.ts vercel --apply      # actually remove Vercel artifacts
 *   bun scripts/platform-cleanup.ts netlify --apply     # actually remove Netlify artifacts
 *   bun scripts/platform-cleanup.ts restore [stamp]     # undo the last (or given) --apply
 *
 * Every run is idempotent: already-cleaned files are reported as "already
 * clean" instead of failing. Dry-run is the default — nothing is written
 * without `--apply`. All edits are line-based so CRLF and LF checkouts behave
 * identically.
 *
 * Safety: `--apply` first snapshots every path it is about to touch into
 * `.platform-cleanup-backup/<timestamp>/` (gitignored) and prints the location.
 * `restore` replays that snapshot, so a cleanup can be undone without git.
 *
 * The full decision record, revert steps, and external (dashboard/secret)
 * checklists live in `docs/operations/DEPLOYMENT_PLATFORM_LIFECYCLE.md`.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

type Platform = "vercel" | "netlify";
type Command = "status" | "restore" | Platform;

/** Result of a line-based transform: new lines, or `null` when already clean. */
type LineTransform = (lines: readonly string[]) => string[] | null;

interface Change {
  /** Human-readable description shown in dry-run and apply output. */
  readonly label: string;
  /** Repository-relative paths this change may create, edit, or delete. */
  readonly paths: readonly string[];
  /** Applies the change; returns a short outcome ("updated", "already clean"). */
  readonly apply: () => string;
}

/** One file/directory captured in a pre-apply snapshot. */
interface BackupEntry {
  path: string;
  existed: boolean;
}

/** `manifest.json` written alongside every snapshot. */
interface BackupManifest {
  command: string;
  at: string;
  entries: BackupEntry[];
}

const ROOT = process.cwd();

/** Gitignored directory holding pre-apply snapshots (see `restore`). */
const BACKUP_ROOT = ".platform-cleanup-backup";

/** Resolves a repository-relative path to an absolute one. */
function resolvePath(relative: string): string {
  return path.join(ROOT, relative);
}

/** Deletes a file or directory if it exists; otherwise reports it as already clean. */
function deletePath(relative: string): Change {
  return {
    label: `delete ${relative}`,
    paths: [relative],
    apply: () => {
      const absolute = resolvePath(relative);
      if (!fs.existsSync(absolute)) return "already clean";
      fs.rmSync(absolute, { recursive: true, force: true });
      return "removed";
    },
  };
}

/**
 * Rewrites a file with a line-based transform.
 *
 * The transform returns `null` when the file is already in the target state,
 * or the new line array otherwise. It throws when neither the "before" nor the
 * "after" state is recognizable, which aborts the run instead of writing a
 * half-migrated file.
 */
function editFile(relative: string, transform: LineTransform): Change {
  return {
    label: `edit  ${relative}`,
    paths: [relative],
    apply: () => {
      const absolute = resolvePath(relative);
      if (!fs.existsSync(absolute)) throw new Error(`${relative} not found`);
      const content = fs.readFileSync(absolute, "utf8");
      const eol = content.includes("\r\n") ? "\r\n" : "\n";
      const before = content.split(/\r?\n/);
      const after = transform(before);
      if (after === null) return "already clean";
      if (after.length === before.length && after.every((line, i) => line === before[i])) {
        return "unchanged";
      }
      fs.writeFileSync(absolute, after.join(eol), "utf8");
      return "updated";
    },
  };
}

/** Removes the first line containing `needle`; `null` when no such line exists. */
function removeLineContaining(relative: string, needle: string): Change {
  return editFile(relative, (lines) => {
    const index = lines.findIndex((line) => line.includes(needle));
    if (index === -1) return null;
    return [...lines.slice(0, index), ...lines.slice(index + 1)];
  });
}

/**
 * Removes the inclusive range from the first line matching `start` through the
 * first later line matching `end`.
 *
 * `endOccurrence` lets a marker appear more than once (e.g. an explanatory
 * comment mentioning the marker it surrounds).
 */
function removeRange(
  relative: string,
  start: (line: string) => boolean,
  end: (line: string) => boolean,
  endOccurrence = 1
): Change {
  return editFile(relative, (lines) => {
    const startIndex = lines.findIndex(start);
    if (startIndex === -1) return null;
    let seen = 0;
    let endIndex = -1;
    for (let i = startIndex + 1; i < lines.length; i += 1) {
      if (end(lines[i])) {
        seen += 1;
        if (seen === endOccurrence) {
          endIndex = i;
          break;
        }
      }
    }
    if (endIndex === -1) throw new Error(`${relative}: closing marker not found`);
    return [...lines.slice(0, startIndex), ...lines.slice(endIndex + 1)];
  });
}

/** Inserts `addition` after the first line equal to `anchor`; `null` when already present. */
function insertAfter(relative: string, anchor: string, addition: string): Change {
  return editFile(relative, (lines) => {
    if (lines.includes(addition)) return null;
    const index = lines.indexOf(anchor);
    if (index === -1) throw new Error(`${relative}: anchor "${anchor}" not found`);
    return [...lines.slice(0, index + 1), addition, ...lines.slice(index + 1)];
  });
}

/** Removes every line containing `needle`; `null` when none exist. */
function removeLinesContaining(relative: string, needle: string): Change {
  return editFile(relative, (lines) => {
    const kept = lines.filter((line) => !line.includes(needle));
    return kept.length === lines.length ? null : kept;
  });
}

/** Substitutes `find` → `replace` on the single line containing `find`. */
function replaceInLine(relative: string, find: string, replace: string): Change {
  return editFile(relative, (lines) => {
    const index = lines.findIndex((line) => line.includes(find));
    if (index === -1) return null;
    return lines.map((line, i) => (i === index ? line.replace(find, replace) : line));
  });
}

/**
 * Deletes a directory only when its contents are exactly `allowedEntries`;
 * otherwise deletes just those entries and leaves the directory alone.
 */
function deleteDirectoryContents(relative: string, allowedEntries: readonly string[]): Change {
  return {
    label: `purge ${relative}/* (${allowedEntries.join(", ")})`,
    paths: allowedEntries.map((entry) => path.join(relative, entry)),
    apply: () => {
      const absolute = resolvePath(relative);
      if (!fs.existsSync(absolute)) return "already clean";
      const entries = fs.readdirSync(absolute);
      const unexpected = entries.filter((entry) => !allowedEntries.includes(entry));
      let removed = 0;
      for (const entry of allowedEntries) {
        const target = path.join(absolute, entry);
        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true });
          removed += 1;
        }
      }
      if (unexpected.length === 0) fs.rmdirSync(absolute);
      return removed === 0
        ? "already clean"
        : unexpected.length > 0
          ? `removed ${removed} entr${removed === 1 ? "y" : "ies"} (kept ${unexpected.join(", ")})`
          : `removed ${removed} entr${removed === 1 ? "y" : "ies"} and the directory`;
    },
  };
}

/** Builds the Vercel-retirement change list (roadmap Step 8). */
function vercelChanges(): Change[] {
  return [
    deletePath("vercel.json"),
    deletePath("api"),
    // Everything between the markers (comment header, `config`, adapter) goes.
    removeRange(
      "src/app.ts",
      (line) => line.trim() === "// __PLATFORM_VERCEL_ADAPTER_BEGIN__",
      (line) => line.trim() === "// __PLATFORM_VERCEL_ADAPTER_END__"
    ),
    // The adapter used to be the default export; the pure Hono app takes over.
    insertAfter("src/app.ts", "export { app };", "export default app;"),
    removeLineContaining(
      "src/app.ts",
      'import type { IncomingMessage, ServerResponse } from "node:http";'
    ),
    removeLineContaining("src/config/constants.ts", "export const APP_WEB_URL"),
  ];
}

/** Builds the Netlify-retirement change list. */
function netlifyChanges(): Change[] {
  return [
    deletePath("netlify.toml"),
    deletePath("netlify"),
    deletePath("bun.lockb"),
    deleteDirectoryContents("public", ["robots.txt"]),
    deletePath("src/utils/netlify-cache.ts"),
    removeLineContaining(
      "src/middleware/cache.ts",
      'import { applyPublicCdnCache } from "../utils/netlify-cache.js";'
    ),
    removeRange(
      "src/middleware/cache.ts",
      (line) => line.trimStart().startsWith("// Netlify shared-cache opt-in"),
      (line) => line.includes("applyPublicCdnCache(c, path);")
    ),
    removeLineContaining(
      "src/services/cache.ts",
      "import { CATALOGUE_CACHE_TAGS, purgeNetlifyCacheTags } from '../utils/netlify-cache.js';"
    ),
    removeRange(
      "src/services/cache.ts",
      (line) => line.trimStart().startsWith("// Keep the Netlify edge/durable cache"),
      (line) => line.includes("await purgeNetlifyCacheTags(CATALOGUE_CACHE_TAGS);")
    ),
    replaceInLine("tsconfig.json", '"netlify/**/*.mts", ', ""),
    removeLinesContaining("package.json", '"netlify:dev"'),
    removeLinesContaining("package.json", '"netlify:build"'),
  ];
}

/** True when the Vercel adapter markers are present in `src/app.ts`. */
function hasAdapterMarkers(): boolean {
  const absolute = resolvePath("src/app.ts");
  if (!fs.existsSync(absolute)) return false;
  return fs.readFileSync(absolute, "utf8").includes("__PLATFORM_VERCEL_ADAPTER_BEGIN__");
}

/** Prints the current presence of every platform artifact. */
function printStatus(): void {
  const artifacts: ReadonlyArray<readonly [Platform, readonly string[]]> = [
    ["vercel", ["vercel.json", "api/index.ts", "src/app.ts (adapter markers)"]],
    [
      "netlify",
      [
        "netlify.toml",
        "netlify/functions/api.mts",
        "bun.lockb",
        "public/robots.txt",
        "src/utils/netlify-cache.ts",
      ],
    ],
  ];

  console.log("\nDeployment platform artifacts\n");
  for (const [platform, paths] of artifacts) {
    console.log(`  ${platform}`);
    for (const relative of paths) {
      const exists = relative.includes("markers")
        ? hasAdapterMarkers()
        : fs.existsSync(resolvePath(relative));
      console.log(`    [${exists ? "present" : "absent"}] ${relative}`);
    }
  }

  const hasVercel = fs.existsSync(resolvePath("vercel.json"));
  const hasNetlify = fs.existsSync(resolvePath("netlify.toml"));
  const mode =
    hasVercel && hasNetlify
      ? "DUAL-TRACK (both adapters live)"
      : hasNetlify
        ? "Netlify-only"
        : hasVercel
          ? "Vercel-only"
          : "no adapter";
  console.log(`\n  Mode: ${mode}\n`);
}

/** Runs a change list in dry-run or apply mode. */
function runChanges(changes: readonly Change[], apply: boolean): number {
  let failures = 0;
  console.log(
    apply ? "\nApplying changes\n" : "\nDry run (no files written — pass --apply to execute)\n"
  );
  for (const change of changes) {
    try {
      const outcome = apply ? change.apply() : "pending";
      console.log(`  [${apply ? "ok" : "plan"}] ${change.label} — ${outcome}`);
    } catch (error) {
      failures += 1;
      console.log(
        `  [fail] ${change.label} — ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return failures;
}

/**
 * Snapshots every path the given changes will touch so the run can be undone.
 *
 * @param command - `vercel` or `netlify`, recorded in the manifest
 * @param changes - Change list about to be applied
 * @returns Backup folder (relative to the repository root), or `null` when
 *          nothing needed backing up
 */
function writeBackup(command: string, changes: readonly Change[]): string | null {
  const paths = [...new Set(changes.flatMap((change) => [...change.paths]))];
  if (paths.length === 0) return null;

  const at = new Date().toISOString().replace(/[:.]/g, "-");
  const relativeDir = `${BACKUP_ROOT}/${at}`;
  const absoluteDir = resolvePath(relativeDir);
  const entries: BackupEntry[] = [];

  for (const relative of paths) {
    const absolute = resolvePath(relative);
    const existed = fs.existsSync(absolute);
    entries.push({ path: relative, existed });
    if (existed) {
      const destination = path.join(absoluteDir, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(absolute, destination, { recursive: true });
    }
  }

  const manifest: BackupManifest = { command, at, entries };
  fs.mkdirSync(absoluteDir, { recursive: true });
  fs.writeFileSync(
    path.join(absoluteDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  return relativeDir;
}

/**
 * Replays a snapshot created by {@link writeBackup}.
 *
 * @param stamp - Backup folder name; the most recent one when omitted
 * @throws When no backup exists for the requested stamp
 */
function restoreBackup(stamp: string | undefined): void {
  const root = resolvePath(BACKUP_ROOT);
  const available = fs.existsSync(root)
    ? fs
        .readdirSync(root)
        .filter((entry) => fs.statSync(path.join(root, entry)).isDirectory())
        .sort()
    : [];

  if (available.length === 0) {
    throw new Error(`no backups found in ${BACKUP_ROOT}/ — run an --apply first`);
  }

  const name = stamp ?? available[available.length - 1];
  if (!available.includes(name)) {
    throw new Error(`backup "${name}" not found. Available: ${available.join(", ")}`);
  }

  const backupDir = path.join(root, name);
  const manifestPath = path.join(backupDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`${manifestPath} missing — backup is unusable`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BackupManifest;
  console.log(`\nRestoring snapshot ${name} (applied ${manifest.at}, command: ${manifest.command})\n`);

  for (const entry of manifest.entries) {
    const target = resolvePath(entry.path);
    const source = path.join(backupDir, entry.path);
    if (entry.existed) {
      if (!fs.existsSync(source)) {
        console.log(`  [fail] ${entry.path} — snapshot copy missing, left untouched`);
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(source, target, { recursive: true });
      console.log(`  [ok]   ${entry.path} — restored`);
    } else {
      if (!fs.existsSync(target)) {
        console.log(`  [ok]   ${entry.path} — already absent`);
        continue;
      }
      fs.rmSync(target, { recursive: true, force: true });
      console.log(`  [ok]   ${entry.path} — removed (was created by the cleanup)`);
    }
  }
  console.log(`\nSnapshot ${name} restored. Re-run \`bun run check\` to verify.\n`);
}

function main(): void {
  const args = process.argv.slice(2);
  const positionals = args.filter((arg) => !arg.startsWith("--"));
  const command = (positionals[0] ?? "status") as Command;
  const apply = args.includes("--apply");

  if (command !== "status" && command !== "vercel" && command !== "netlify" && command !== "restore") {
    console.error(
      `Unknown command "${command}". Use: status | vercel | netlify [--apply] | restore [stamp]`
    );
    process.exit(2);
  }

  if (command === "status") {
    printStatus();
    return;
  }

  if (command === "restore") {
    try {
      restoreBackup(positionals[1]);
    } catch (error) {
      console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
    return;
  }

  const changes = command === "vercel" ? vercelChanges() : netlifyChanges();

  if (apply) {
    try {
      const backup = writeBackup(command, changes);
      if (backup) console.log(`\nSnapshot written to ${backup}/ (undo with \`bun platform:restore\`)`);
    } catch (error) {
      console.error(
        `\nBackup failed, aborting before any file is touched: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
      process.exit(1);
    }
  }

  const failures = runChanges(changes, apply);

  if (command === "vercel") {
    console.log("\nFollow-up (outside this repository):");
    console.log(
      "  1. `bun run check` — confirm no `vercelHandler` / `IncomingMessage` hits remain in src/"
    );
    console.log(
      "  2. Netlify UI — set NODE_ENV=production (Functions scope); never set VERCEL / VERCEL_ENV"
    );
    console.log(
      "  3. Point BACKEND_URL, QStash schedules, GitHub secret BACKEND_URL, Stripe/Xendit webhooks at the Netlify domain"
    );
    console.log(
      "  4. Decommission the Vercel project (dashboard → Settings → General → Delete Project)"
    );
  } else {
    console.log("\nFollow-up (outside this repository):");
    console.log(
      "  1. Vercel UI — confirm NODE_ENV=production and every secret from .env.example is still present"
    );
    console.log("  2. `bun remove @netlify/functions` — the runtime dependency is no longer referenced");
    console.log(
      "  3. `bun run check` — confirm no `netlify-cache` / `applyPublicCdnCache` hits remain"
    );
    console.log(
      "  4. Point BACKEND_URL, QStash schedules, GitHub secret BACKEND_URL, Stripe/Xendit webhooks at the Vercel domain"
    );
    console.log("  5. Delete the Netlify site (or disconnect the Git repo)");
  }

  if (failures > 0) {
    console.error(`\n${failures} change(s) failed — those entries were not written.\n`);
    process.exit(1);
  }
  console.log("");
}

main();
