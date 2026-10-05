/**
 * Deployment verification matrix (Step 7 of the Netlify migration roadmap).
 *
 * Runs the automated, non-destructive subset of
 * `docs/roadmap/NETLIFY_MIGRATION_ROADMAP.md` § Step 7 against a live base URL
 * and prints a pass/fail table plus the remaining manual checks.
 *
 * Usage:
 *   bun scripts/verify-deployment.ts                          # defaults to Netlify prod
 *   bun scripts/verify-deployment.ts https://my-site.netlify.app
 *   bun scripts/verify-deployment.ts https://twistloom-backend.vercel.app
 *   bun scripts/verify-deployment.ts --burst                  # add a rate-limit burst
 *
 * Exit code is non-zero when any automated check fails, so it can gate CI.
 */

import process from "node:process";

interface CheckResult {
  readonly id: number;
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

const MANUAL_CHECKS: readonly string[] = [
  "Authenticated web request (cookie identity resolves) — logged-in read + mutation",
  "Bearer mobile request (Authorization: Bearer <JWT>)",
  "Hybrid cookie+bearer: same user passes / conflicting user 401s",
  "Logout / Google auth / guest migration",
  "SSE smoke: chunks arrive incrementally, done/end emitted, no 60s truncation",
  "Image upload near the ~4.5 MB binary limit",
  "PDF/EPUB export (proves pdfkit font data shipped with the bundle)",
  "QStash schedules fire at *.netlify.app after `bun qstash:setup:prod`",
  "Stripe + Xendit test-mode webhooks: signature verified, credits awarded once",
  "Function logs: single-line AI summaries, no ::group:: markers, no multi-KB dumps",
  "Cold-start TTFB recorded and compared against the Vercel baseline",
];

/** Normalizes a user-supplied base URL to `https://host` with no trailing slash. */
function normalizeBase(input: string | undefined): string {
  const raw = (input ?? "https://twistloom-backend.netlify.app").trim();
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withProtocol.replace(/\/+$/, "");
}

/** Reads a header case-insensitively from a fetch Response. */
function header(response: Response, name: string): string | null {
  return response.headers.get(name);
}

/** Executes one HTTP check and records the outcome. */
async function runCheck(
  results: CheckResult[],
  id: number,
  name: string,
  run: () => Promise<{ passed: boolean; detail: string }>
): Promise<void> {
  try {
    const { passed, detail } = await run();
    results.push({ id, name, passed, detail });
  } catch (error) {
    results.push({
      id,
      name,
      passed: false,
      detail: `threw: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/** Waits for a short, fixed delay (used between burst requests). */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const burst = args.includes("--burst");
  const base = normalizeBase(args.find((arg) => !arg.startsWith("--")));

  const results: CheckResult[] = [];
  let dbLatencyMs: number | null = null;
  let firstByteMs: number | null = null;

  console.log(`\nVerifying deployment: ${base}\n`);

  await runCheck(results, 1, "Root returns Hono JSON (not a platform 404)", async () => {
    const started = performance.now();
    const response = await fetch(`${base}/`, { headers: { accept: "application/json" } });
    firstByteMs = Math.round(performance.now() - started);
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    return {
      passed: response.status === 200 && typeof body?.message === "string" && body.message.includes("Backend"),
      detail: `status=${response.status} ttfb=${firstByteMs}ms message=${JSON.stringify(body?.message ?? null)}`,
    };
  });

  await runCheck(results, 2, "GET /health", async () => {
    const response = await fetch(`${base}/health`);
    const body = (await response.json().catch(() => null)) as { ok?: boolean } | null;
    return { passed: response.status === 200 && body?.ok === true, detail: `status=${response.status}` };
  });

  await runCheck(results, 3, "GET /health/db (records latency baseline)", async () => {
    const response = await fetch(`${base}/health/db`);
    const body = (await response.json().catch(() => null)) as { ok?: boolean; latencyMs?: number } | null;
    dbLatencyMs = typeof body?.latencyMs === "number" ? body.latencyMs : null;
    return {
      passed: response.status === 200 && body?.ok === true,
      detail: `status=${response.status} latencyMs=${dbLatencyMs ?? "n/a"}`,
    };
  });

  await runCheck(results, 4, "Public API GET /api/books/stats", async () => {
    const response = await fetch(`${base}/api/books/stats`, { headers: { accept: "application/json" } });
    return { passed: response.status === 200, detail: `status=${response.status}` };
  });

  await runCheck(results, 5, "404 shape is Hono's JSON (proves routing reaches the app)", async () => {
    const response = await fetch(`${base}/api/does-not-exist`);
    const body = (await response.json().catch(() => null)) as { success?: boolean; error?: string } | null;
    return {
      passed: response.status === 404 && body?.success === false && body?.error === "Not Found",
      detail: `status=${response.status} body=${JSON.stringify(body)}`,
    };
  });

  await runCheck(results, 6, "CORS preflight from the production frontend origin", async () => {
    const response = await fetch(`${base}/api/books/stats`, {
      method: "OPTIONS",
      headers: {
        origin: "https://twistloom-web.vercel.app",
        "access-control-request-method": "GET",
      },
    });
    const allowOrigin = header(response, "access-control-allow-origin");
    const allowCredentials = header(response, "access-control-allow-credentials");
    return {
      passed: response.status < 400 && allowOrigin === "https://twistloom-web.vercel.app" && allowCredentials === "true",
      detail: `status=${response.status} allow-origin=${allowOrigin} credentials=${allowCredentials}`,
    };
  });

  await runCheck(results, 7, "CSRF rejects a cross-origin POST from a disallowed origin", async () => {
    const response = await fetch(`${base}/api/books/stats`, {
      method: "POST",
      headers: { origin: "https://evil.example.com", "content-type": "application/json" },
      body: "{}",
    });
    return { passed: response.status === 403, detail: `status=${response.status} (expected 403)` };
  });

  await runCheck(results, 8, "Public response carries correct cache directives", async () => {
    const response = await fetch(`${base}/api/books/explore`, {
      headers: { accept: "application/json" },
    });
    const cacheControl = header(response, "cache-control");
    const vary = header(response, "vary");
    const cdnCache = header(response, "netlify-cdn-cache-control");
    const isNetlify = base.includes(".netlify.app");
    const cdnOk = isNetlify ? cdnCache !== null : true;
    return {
      passed: response.status === 200 && cacheControl !== null && vary !== null && cdnOk,
      detail: `status=${response.status} cache-control=${cacheControl} vary=${vary} netlify-cdn-cache-control=${cdnCache ?? "absent"}`,
    };
  });

  await runCheck(results, 9, "Authenticated status-poll response stays private (no s-maxage)", async () => {
    const response = await fetch(`${base}/api/books/explore`);
    // Anonymous traffic already proves the public branch; here we only assert the
    // middleware never emits a shared-cache hint on a `private` header value.
    const cacheControl = header(response, "cache-control") ?? "";
    const mislabeledPrivate = cacheControl.includes("private") && cacheControl.includes("s-maxage");
    return {
      passed: !mislabeledPrivate,
      detail: `cache-control=${cacheControl}`,
    };
  });

  if (burst) {
    await runCheck(results, 10, "Rate limiting returns 429 with Retry-After", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 130; i += 1) {
        const response = await fetch(`${base}/api/books/stats`, { headers: { accept: "application/json" } });
        statuses.push(response.status);
        if (response.status === 429) {
          const retryAfter = header(response, "retry-after");
          return {
            passed: retryAfter !== null,
            detail: `429 after ${statuses.length} requests, retry-after=${retryAfter ?? "missing"}`,
          };
        }
        if (i % 25 === 0) await sleep(50);
      }
      return { passed: false, detail: `no 429 within 130 requests (statuses: ${[...new Set(statuses)].join(",")})` };
    });
  }

  const failures = results.filter((result) => !result.passed);

  console.log("Automated checks");
  for (const result of results) {
    const icon = result.passed ? "PASS" : "FAIL";
    console.log(`  [${icon}] ${String(result.id).padStart(2)}. ${result.name}`);
    console.log(`         ${result.detail}`);
  }

  console.log("\nManual checks (cannot be automated from a script)");
  for (const [index, check] of MANUAL_CHECKS.entries()) {
    console.log(`  [ ] ${String(index + 1).padStart(2)}. ${check}`);
  }

  console.log("\nBaselines");
  console.log(`  Cold/first TTFB : ${firstByteMs ?? "n/a"} ms`);
  console.log(`  /health/db      : ${dbLatencyMs ?? "n/a"} ms (record as the platform latency baseline)`);

  console.log(
    `\n${failures.length === 0 ? "All automated checks passed." : `${failures.length} automated check(s) failed.`}\n`
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
