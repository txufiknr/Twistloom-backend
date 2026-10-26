#!/usr/bin/env bun
/**
 * Cross-platform git diff exporter for local AI code reviews against REVIEW.md.
 * Exports uncommitted changes or branch diff into .tmp/current-diff.patch.
 *
 * @see REVIEW.md
 * @see docs/roadmap/AI_CODE_REVIEW_PROTOCOL_ROADMAP.md
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const targetDir = path.resolve(process.cwd(), ".tmp");
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}
const targetFile = path.join(targetDir, "current-diff.patch");

try {
  let diff = "";
  try {
    diff = execSync("git diff main...HEAD", { encoding: "utf8" });
  } catch {
    // Fall back if branch diff cannot be resolved
  }

  if (!diff || !diff.trim()) {
    diff = execSync("git diff HEAD", { encoding: "utf8" });
  }

  if (!diff || !diff.trim()) {
    diff = execSync("git diff", { encoding: "utf8" });
  }

  fs.writeFileSync(targetFile, diff, "utf8");
  console.log(`✅ Git diff saved to ${targetFile} (${diff.length} bytes) for review against REVIEW.md.`);
} catch (error) {
  console.error("❌ Failed to export git diff:", error instanceof Error ? error.message : error);
  process.exit(1);
}
