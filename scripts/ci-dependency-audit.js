/**
 * CI dependency audit reporter for `.github/workflows/dependency-audit.yml`.
 *
 * Reads the JSON emitted by `bun audit --json` (written to `audit.json` by the
 * workflow) and:
 *   1. Prints a severity summary (low / moderate / high / critical).
 *   2. Emits a GitHub Actions `::warning::` annotation per advisory.
 *   3. Fails the job when any `high` or `critical` advisory exists
 *      (set `FAIL_ON_CRITICAL_ONLY=true` to fail only on critical).
 *
 * The parser extracts the JSON object between the first `{` and last `}` so it
 * tolerates the `bun audit` banner printed to the stream on some runners.
 */

import { readFileSync } from "node:fs";

const raw = readFileSync("audit.json", "utf8");
const start = raw.indexOf("{");
const end = raw.lastIndexOf("}");
const json = start >= 0 && end > start ? raw.slice(start, end + 1) : "{}";
const data = JSON.parse(json);

const advisories = [];
for (const [pkg, list] of Object.entries(data)) {
  for (const a of list) {
    advisories.push({ pkg, severity: a.severity, title: a.title, url: a.url });
  }
}

const counts = { low: 0, moderate: 0, high: 0, critical: 0 };
for (const a of advisories) {
  counts[a.severity] = (counts[a.severity] ?? 0) + 1;
}

console.log(
  `Vulnerabilities: low=${counts.low} moderate=${counts.moderate} high=${counts.high} critical=${counts.critical}`
);
for (const a of advisories) {
  console.log(`::warning::[${a.severity}] ${a.pkg}: ${a.title} ${a.url}`);
}

const strict = process.env.FAIL_ON_CRITICAL_ONLY === "true";
const blocking = strict ? counts.critical : counts.critical + counts.high;
if (blocking > 0) {
  console.error(`Found ${blocking} blocking advisory(ies) (${strict ? "critical only" : "high or critical"}).`);
  process.exit(1);
}
console.log("No blocking advisories found.");
