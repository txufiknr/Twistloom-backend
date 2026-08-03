/**
 * @summary Runs periodic automated social mention discovery jobs
 * @description Collects community posts containing "Twistloom" across open internet vectors.
 * 
 * Idempotency & Safety:
 * - Safe to run continuously: relies on unique URL conflict exclusion rules (`onConflictDoNothing`).
 * - Fault tolerant: individual source network or parsing failures will never kill the whole pipeline.
 * - Local heuristic screening: computes context scores without hitting external semantic inference engines.
 * - Per-source timeouts: a single slow or hung upstream can never block the whole pipeline.
 * 
 * Process Environment Requirements:
 * - `BRAVE_SEARCH_API_KEY` (Optional): Required only to unlock cross-platform broad web searching.
 *   Register at https://api.search.brave.com/app/dashboard
 * 
 * Sources (all keyless except Brave):
 * - Reddit (public search JSON)
 * - Hacker News (Algolia API)
 * - GitHub (Search API: issues/PRs/discussions)
 * - Bluesky (public AT Protocol search)
 * - Brave Search (optional, API key)
 * 
 * Schedule: Recommended to execute every 12 to 24 hours.
 */
import { getErrorMessage } from "../utils/error.js";

// Canonical search configurations
const SEARCH_KEYWORD = "Twistloom";

/** Hard ceiling for any single upstream fetch (ms). Prevents a hung source from stalling the run. */
const SOURCE_FETCH_TIMEOUT_MS = 15_000;

/** Base exponential backoff delay (ms) before retrying a transient upstream failure. */
const RETRY_BASE_DELAY_MS = 1_000;

/**
 * HTTP statuses treated as transient and worth retrying with backoff.
 * 403 is included because some public APIs (e.g. Bluesky) intermittently
 * throttle datacenter IPs; the cost of one retry is negligible.
 */
const TRANSIENT_HTTP_STATUSES = new Set([403, 408, 425, 429, 500, 502, 503, 504]);

/**
 * Pauses execution for the given duration, used to space out retry attempts.
 *
 * @param ms - Number of milliseconds to wait
 * @returns Promise that resolves once the wait elapses
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determines whether a fetch failure is transient enough to warrant a retry.
 * Retries timeouts, aborts, network errors, and transient HTTP statuses; all
 * other errors (e.g. JSON parse failures) are treated as permanent.
 *
 * @param error - Error captured from a failed fetch attempt
 * @returns True when retrying may help; false for permanent failures
 */
function isTransientFetchFailure(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  const statusMatch = message.match(/http error status received: (\d{3})/);
  if (statusMatch) {
    return TRANSIENT_HTTP_STATUSES.has(Number(statusMatch[1]));
  }
  return /abort|timeout|timed out|network|econn|enet|und_err|socket|fetch failed/i.test(message);
}

interface NormalizedMention {
  platform: string;
  author: string;
  authorAvatar?: string | null;
  title?: string | null;
  content: string;
  url: string;
  score: number;
  publishedAt: Date | null;
}

/**
 * Wraps a fetch call with an abort timeout so a single slow upstream cannot
 * block the entire ingestion pipeline. Optionally retries transient failures
 * with exponential backoff. Returns `null` on final failure so the caller can
 * treat it as "no data from this source" without crashing.
 *
 * @param url - Target URL
 * @param options - Standard fetch options (headers, method, etc.)
 * @param retries - Number of additional attempts after the first failure (default: 0)
 * @returns Parsed JSON response, or null if the request failed or timed out
 */
async function fetchWithTimeout(url: string, options: RequestInit = {}, retries = 0): Promise<any | null> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SOURCE_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP error status received: ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries && isTransientFetchFailure(error)) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      } else if (attempt < retries) {
        // Permanent failure (e.g. JSON parse error): skip remaining attempts
        break;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  console.error(`[social-ingest] ⚠️ Fetch failed (${url}):`, getErrorMessage(lastError));
  return null;
}

/**
 * Evaluates text parameters locally using deterministic criteria to establish content priorities
 * @returns Object containing context heuristic evaluation scores
 */
function computeLocalHeuristics(textToAnalyze: string, title?: string | null): { relevance: number; sentiment: number } {
  const combined = `${title || ""} ${textToAnalyze}`.toLowerCase();
  let relevance = 0;
  let sentiment = 0;

  // Relevance logic
  if (combined.includes("twistloom.com")) relevance += 50;
  if (combined.includes(SEARCH_KEYWORD.toLowerCase())) relevance += 30;
  
  // Basic context keywords matching
  const contextKeywords = ["story", "thriller", "branching", "interactive", "ai", "plot", "game", "novel"];
  contextKeywords.forEach(kw => {
    if (combined.includes(kw)) relevance += 5;
  });

  // Sentiment heuristics (word-boundary matches to avoid false positives like "bad" in "badge")
  const positiveWords = ["love", "amazing", "best", "good", "cool", "hooked", "impressed", "awesome", "wow", "fun"];
  const negativeWords = ["bad", "terrible", "worst", "crash", "broken", "sucks", "hate", "trash", "buggy"];

  positiveWords.forEach(word => {
    const matches = (combined.match(new RegExp(`\\b${word}\\b`, "g")) || []).length;
    sentiment += matches * 0.2;
  });
  negativeWords.forEach(word => {
    const matches = (combined.match(new RegExp(`\\b${word}\\b`, "g")) || []).length;
    sentiment -= matches * 0.3;
    relevance -= matches * 10; // Deprioritize structural complaints or bug text on the homepage
  });

  return {
    relevance: Math.max(0, relevance),
    sentiment: Math.max(-1, Math.min(1, sentiment))
  };
}

/**
 * Collects mentions from Reddit's unauthenticated public JSON endpoints.
 * Reddit frequently 403s datacenter requests, so a mirror on old.reddit.com
 * is tried as a fallback before giving up on this source.
 */
async function fetchRedditMentions(): Promise<NormalizedMention[]> {
  try {
    console.log("[social-ingest] 🟠 Querying Reddit public search standard endpoints...");
    const redditUserAgent =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

    const queryUrl = (baseHost: string) =>
      `https://${baseHost}/search.json?q=${encodeURIComponent(SEARCH_KEYWORD)}&sort=new&limit=25`;

    let data = await fetchWithTimeout(queryUrl("www.reddit.com"), {
      headers: { "User-Agent": redditUserAgent },
    });

    if (!data) {
      console.log("[social-ingest] 🟠 Retrying Reddit via old.reddit.com mirror endpoint...");
      data = await fetchWithTimeout(queryUrl("old.reddit.com"), {
        headers: { "User-Agent": redditUserAgent },
      });
    }

    if (!data) return [];

    const items = data?.data?.children || [];
    return items.map((item: any): NormalizedMention => {
      const post = item.data;
      return {
        platform: "reddit",
        author: `u/${post.author}`,
        authorAvatar: null,
        title: post.title,
        content: post.selftext || post.title,
        url: `https://www.reddit.com${post.permalink}`,
        score: post.ups || 0,
        publishedAt: post.created_utc ? new Date(post.created_utc * 1000) : null
      };
    });
  } catch (error) {
    console.error("[social-ingest] ❌ Failed to fetch telemetry from Reddit vector:", getErrorMessage(error));
    return [];
  }
}

/**
 * Collects mentions from Hacker News via the unauthenticated Algolia search indexing API
 */
async function fetchHackerNewsMentions(): Promise<NormalizedMention[]> {
  try {
    console.log("[social-ingest] 🌐 Querying Hacker News Algolia historic indexing service...");
    const data = await fetchWithTimeout(
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(SEARCH_KEYWORD)}&tags=(story,comment)`
    );

    if (!data) return [];

    const hits = data?.hits || [];
    return hits.map((hit: any): NormalizedMention => {
      const isComment = hit.title === null || typeof hit.title === "undefined";
      // HN returns naive timestamps; append Z so Date parses as UTC, not local time.
      const rawDate = hit.created_at ? `${hit.created_at}`.replace(" ", "T") : null;
      return {
        platform: "hackernews",
        author: hit.author || "anonymous",
        authorAvatar: null,
        title: isComment ? `HN Comment on thread #${hit.story_id}` : hit.title,
        content: hit.comment_text || hit.story_text || "",
        url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        score: hit.points || 0,
        publishedAt: rawDate ? new Date(rawDate.endsWith("Z") ? rawDate : `${rawDate}Z`) : null
      };
    });
  } catch (error) {
    console.error("[social-ingest] ❌ Failed to fetch telemetry from Hacker News vector:", getErrorMessage(error));
    return [];
  }
}

/**
 * Collects cross-platform web indicators using Brave Search Data API
 * @see https://api.search.brave.com/app/dashboard to register applications and acquire token keys
 */
async function fetchBraveSearchMentions(apiKey?: string): Promise<NormalizedMention[]> {
  if (!apiKey) {
    console.log("[social-ingest] 🔍 Skipping Brave Search query string evaluation (API key absent)");
    return [];
  }

  try {
    console.log("[social-ingest] 🦁 Evaluating generic web indexing tables via Brave Search API...");
    const data = await fetchWithTimeout(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(SEARCH_KEYWORD)}&count=20`,
      {
        headers: {
          "Accept": "application/json",
          "X-Subscription-Token": apiKey,
        },
      },
      1
    );

    if (!data) return [];

    const results = data?.web?.results || [];
    return results.map((result: any): NormalizedMention => {
      // Isolate root domains to stand in as generic alternative platform labels
      let platformLabel = "web";
      try { platformLabel = new URL(result.url).hostname.replace("www.", ""); } catch {
        // no-op
      }

      return {
        platform: platformLabel,
        author: platformLabel,
        authorAvatar: null,
        title: result.title,
        content: result.description || "",
        url: result.url,
        score: 0, // General indexing results don't have standard vote tracking configurations
        publishedAt: result.page_age ? new Date(result.page_age) : null
      };
    });
  } catch (error) {
    console.error("[social-ingest] ❌ Failed to compile data maps from Brave Search interface:", getErrorMessage(error));
    return [];
  }
}

/**
 * Collects mentions from GitHub (issues, PRs, discussions) via the unauthenticated
 * Search API. Developer-oriented and high-signal for a dev-tool-adjacent product.
 * No API key required (10 req/min unauthenticated; the timeout guard protects the run).
 *
 * @see https://docs.github.com/en/rest/search
 */
async function fetchGitHubMentions(): Promise<NormalizedMention[]> {
  try {
    console.log("[social-ingest] 🐙 Querying GitHub Search indexing service...");
    const data = await fetchWithTimeout(
      `https://api.github.com/search/issues?q=${encodeURIComponent(SEARCH_KEYWORD)}&sort=updated&order=desc&per_page=20`,
      { headers: { "User-Agent": "TwistloomSocialProofBot/1.0.0", "Accept": "application/vnd.github+json" } }
    );

    if (!data) return [];

    const items = data?.items || [];
    return items.map((item: any): NormalizedMention => {
      const isPr = item.pull_request !== undefined;
      return {
        platform: "github",
        author: item.user?.login || "anonymous",
        authorAvatar: item.user?.avatar_url || null,
        title: `[${isPr ? "PR" : "Issue"} #${item.number}] ${item.title}`,
        content: item.body || item.title,
        url: item.html_url,
        score: item.reactions?.total_count || item.comments || 0,
        publishedAt: item.created_at ? new Date(item.created_at) : null
      };
    });
  } catch (error) {
    console.error("[social-ingest] ❌ Failed to fetch telemetry from GitHub vector:", getErrorMessage(error));
    return [];
  }
}

/**
 * Collects mentions from Bluesky via the public AT Protocol post search endpoint.
 * Bluesky is the open "X replacement" and requires no API key for public search.
 *
 * @see https://docs.bsky.app/docs/api/app-bsky-feed-search-posts
 */
async function fetchBlueskyMentions(): Promise<NormalizedMention[]> {
  try {
    console.log("[social-ingest] 🦋 Querying Bluesky public AT Protocol search endpoint...");
    // Retry transient 403/5xx throttling from datacenter IPs with exponential backoff
    const data = await fetchWithTimeout(
      `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(SEARCH_KEYWORD)}&limit=25`,
      {},
      2
    );

    if (!data) return [];

    const posts = data?.posts || [];
    return posts.map((post: any): NormalizedMention => {
      const author = post.author || {};
      const record = post.record || {};
      return {
        platform: "bluesky",
        author: author.handle ? `@${author.handle}` : (author.displayName || "anonymous"),
        authorAvatar: author.avatar || null,
        title: null,
        content: record.text || "",
        url: `https://bsky.app/profile/${author.handle}/post/${post.uri?.split("/").pop() || ""}`,
        score: post.likeCount || 0,
        publishedAt: record.createdAt ? new Date(record.createdAt) : null
      };
    });
  } catch (error) {
    console.error("[social-ingest] ❌ Failed to fetch telemetry from Bluesky vector:", getErrorMessage(error));
    return [];
  }
}

/**
 * Execution pipeline controller managing cascading multi-source content workflows
 */
export async function runSocialMentionCollection(): Promise<void> {
  const startedAt = Date.now();
  
  try {
    console.log("[social-ingest] 🚀 Initiating global social commentary pipeline discovery...");

    // Lazy load runtime persistence drivers
    const { dbWrite } = await import("../db/client.js");
    const { socialMentions } = await import("../db/schema.js");

    const braveKey = process.env.BRAVE_SEARCH_API_KEY;

    // Parallel fetch initialization (each source self-guards via fetchWithTimeout)
    const [redditResults, hnResults, braveResults, githubResults, blueskyResults] = await Promise.all([
      fetchRedditMentions(),
      fetchHackerNewsMentions(),
      fetchBraveSearchMentions(braveKey),
      fetchGitHubMentions(),
      fetchBlueskyMentions(),
    ]);

    // Consolidate payload structures
    const unifiedCollection = [
      ...redditResults,
      ...hnResults,
      ...braveResults,
      ...githubResults,
      ...blueskyResults,
    ];
    
    if (unifiedCollection.length === 0) {
      console.log("[social-ingest] ✨ No indexing instances identified during this polling pass");
      return;
    }

    console.log(`[social-ingest] 🔨 Processing ${unifiedCollection.length} raw inbound nodes for validation...`);
    const { extractAndResolveTwistloomLink } = await import("../services/social/extract-twistloom-link.js");
    let insertedCount = 0;
    let skippedEmptyCount = 0;
    let errorCount = 0;
    let autoLinkedCount = 0;

    for (const mention of unifiedCollection) {
      try {
        // Strip noise strings or HTML markers from indexing sources
        const strippedContent = mention.content
          .replace(/<[^>]*>/g, "")
          .replace(/&quot;/g, '"')
          .replace(/&#x27;/g, "'")
          .trim();

        if (!strippedContent) {
          skippedEmptyCount++;
          continue;
        }

        // Run algorithmic sorting metrics local calculations
        const heuristics = computeLocalHeuristics(strippedContent, mention.title);

        // Best-effort product link extract (public books only; never features)
        let relatedBookId: string | null = null;
        let relatedPageId: string | null = null;
        let relatedBookSource: "auto" | null = null;
        try {
          const resolved = await extractAndResolveTwistloomLink(mention.title, strippedContent, "auto");
          if (resolved) {
            relatedBookId = resolved.bookId;
            relatedPageId = resolved.pageId;
            relatedBookSource = "auto";
            autoLinkedCount++;
          }
        } catch (linkError) {
          console.error(`[social-ingest] ⚠️ Link extract failed for ${mention.url}:`, getErrorMessage(linkError));
        }

        // Deduplication handled automatically during the standard writing query logic block
        await dbWrite
          .insert(socialMentions)
          .values({
            platform: mention.platform,
            author: mention.author,
            authorAvatar: mention.authorAvatar,
            title: mention.title,
            content: strippedContent,
            url: mention.url,
            score: mention.score,
            sentimentScore: heuristics.sentiment,
            relevanceScore: heuristics.relevance,
            status: "pending", // Queued for user curation
            publishedAt: mention.publishedAt,
            relatedBookId,
            relatedPageId,
            relatedBookSource,
          })
          .onConflictDoNothing({ target: socialMentions.url });

        insertedCount++;
      } catch (innerError) {
        // Shield iterating items from general loop terminations
        errorCount++;
        console.error(`[social-ingest] ⚠️ Encountered issues handling record point (${mention.url}):`, getErrorMessage(innerError));
      }
    }

    const totalDuration = Date.now() - startedAt;
    console.log(`[social-ingest] ✅ Aggregation pipeline concluded safely in ${totalDuration}ms:`, {
      totalDiscovered: unifiedCollection.length,
      inserted: insertedCount,
      skippedEmptyContent: skippedEmptyCount,
      itemErrors: errorCount,
      autoLinked: autoLinkedCount,
      perSource: {
        reddit: redditResults.length,
        hackernews: hnResults.length,
        brave: braveResults.length,
        github: githubResults.length,
        bluesky: blueskyResults.length,
      },
    });

  } catch (error) {
    console.error("[social-ingest] ❌ Unrecoverable failure processing data streams:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Main command terminal runtime invocation layer
 */
async function main(): Promise<void> {
  const startedAt = Date.now();
  try {
    await runSocialMentionCollection();
    console.log(`[social-ingest] ✅ Job ended safely in ${Date.now() - startedAt}ms`);
    process.exit(0);
  } catch (error) {
    console.error("[social-ingest] ❌ Ingestion process terminated unexpectedly:", error);
    process.exit(1);
  }
}

// Global runtime termination traps mapping to structural validation expectations
process.on("unhandledRejection", (reason) => {
  console.error("[social-ingest] Fatal unhandled promise error caught:", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("[social-ingest] Fatal uncaught system error context thrown:", error);
  process.exit(1);
});

void main();