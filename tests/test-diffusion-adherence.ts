/**
 * Diffusion LLM adherence trial — Tier A (parse adherence) + a lightweight
 * Tier B (continuity) probe.
 *
 * This is Step 4/6 of docs/roadmap/AI_DIFFUSION_TOKEN_SAVING_EXECUTION_ROADMAP.
 * It measures two things for a provider (callable today, no DB required for
 * providers without `rpd`/`rpmo` in AI_RATE_LIMITS — e.g. inception):
 *
 * 1. **Parse adherence (Tier A)** — how often the provider's raw output survives
 *    the 9-stage repair/parse pipeline (src/utils/ai-parser.ts) WITHOUT needing
 *    the repair stages. The pipeline counts `clean` when Stages 1–2 succeed and
 *    `repaired` when Stages 3–9 run; `repairRate` = repaired / total. Counters
 *    are keyed by the `logContext` provider prefix, so run each provider in its
 *    own bucket.
 *
 * 2. **Continuity (Tier B probe)** — whether the returned `text` still
 *    references the prior story state's fixed character names and location.
 *    The full Tier B needs the DB + pgvector recall plumbing on a real book and
 *    stays manual (see roadmap §Tier B); this probe is a cheap local signal.
 *
 * Usage (from the repo root):
 * ```
 * bun tests/test-diffusion-adherence.ts                       # default: providers from AI_CHAT_MODELS_DIFFUSION
 * bun tests/test-diffusion-adherence.ts "inception,gemini"    # explicit provider list
 * DIFFUSION_RUNS=10 bun tests/test-diffusion-adherence.ts      # runs per provider (default 30)
 * DIFFUSION_MODELS=mercury-coder-small bun tests/test-diffusion-adherence.ts
 * ```
 *
 * Requires a valid API key in .env for each provider under test.
 */
import { aiPrompt, createAIOptionsWithSchema } from "../src/utils/ai-chat.js";
import { getParseAdherenceStats, parseAISafely, resetParseAdherenceStats } from "../src/utils/ai-parser.js";
import {
  STORY_GENERATION_REQUIRED_FIELDS,
  STORY_GENERATION_SCHEMA_DEFINITION,
} from "../src/schema/story.js";
import { AI_CHAT_MODELS_DIFFUSION } from "../src/config/ai-clients.js";
import { AI_PROVIDER_API_KEYS } from "../src/utils/ai-clients.js";
import type { AIModelSelection, AIChatProvider } from "../src/types/ai-chat.js";
import type { StoryGeneration } from "../src/types/story.js";

/** Number of generation runs per provider-model pair (override with DIFFUSION_RUNS). */
const RUNS_PER_PROVIDER = Number(process.env.DIFFUSION_RUNS ?? 30);

/** Model override per the whole run (override with DIFFUSION_MODELS). */
const MODEL_OVERRIDE = process.env.DIFFUSION_MODELS;

/** Fixed prior state every continuation must preserve — used by the Tier B probe. */
const CHARACTERS = ["Aisha", "Farid", "Uncle Kemal"];
const LOCATION = "the lantern-lit harbor district of Salara";

/**
 * Builds a single-shot story-continuation prompt that embeds the fixed prior
 * state. The model must continue the page AND keep the schema flat — exactly
 * the stress that measures diffusion adherence.
 */
function buildContinuationPrompt(): string {
  return [
    `Continue the interactive story page. Respect the established facts below exactly:`,
    ``,
    `ACTIVE CHARACTERS: ${CHARACTERS.join(', ')}.`,
    `LOCATION: ${LOCATION}.`,
    ``,
    `LAST PAGE (verbatim, from the story so far):`,
    `"The tide clock above the fish market struck eleven as Aisha pulled her shawl tight. Farid was already at the quay, tapping a sealed brass canister against his palm. Uncle Kemal had told them to wait for the third lantern — anything earlier meant the arrangement had changed."`,
    ``,
    `CURRENT STORY STATE:`,
    `- mood: tense, hopeful`,
    `- timeOfDay: night, just past eleven`,
    `- Aisha holds a brass canister; Farid is anxious but resolute.`,
    `- No injuries yet. No items beyond the canister.`,
    ``,
    `Write the next page (3-5 paragraphs): advance the scene without contradicting the state above,`,
    `and return the result as a single JSON object with keys text, actions and calendarDate.`,
    `Mention at least one of ${CHARACTERS.join(', ')} by name and keep the scene at ${LOCATION}.`,
  ].join('\n');
}

/**
 * Runs the Tier A + B trial for one provider/model pair.
 *
 * @param provider - AI provider key, used as the parse-adherence counter bucket
 * @param model - specific model id to test
 * @param report - mutable map collecting per-provider attempt stats
 */
async function runProvider(
  provider: AIChatProvider,
  model: string,
  report: Record<string, { attempts: number; successes: number; continuityHits: number; totalMs: number }>,
): Promise<void> {
  const prompt = buildContinuationPrompt();
  const bucket = report[provider] ?? { attempts: 0, successes: 0, continuityHits: 0, totalMs: 0 };

  const selection: AIModelSelection = { [provider]: [model] };
  const options = createAIOptionsWithSchema<StoryGeneration>({
    schema: STORY_GENERATION_SCHEMA_DEFINITION,
    requiredFields: STORY_GENERATION_REQUIRED_FIELDS,
    fallbackField: 'text',
  });

  console.log(`\n▶ Running ${provider}/${model} — ${RUNS_PER_PROVIDER} iterations...`);

  for (let i = 0; i < RUNS_PER_PROVIDER; i++) {
    bucket.attempts += 1;
    const startedAt = Date.now();

    try {
      // modelSelection deliberately scoped to a single pair so fallback can't
      // bleed this provider's counters into another.
      const aiResponse = await aiPrompt<StoryGeneration>(prompt, {
        ...options,
        modelSelection: selection,
        context: 'diffusion-adherence-test',
        logPrompts: false,
      });

      bucket.totalMs += Date.now() - startedAt;

      if (!aiResponse || aiResponse.provider === 'none' || !aiResponse.output) {
        console.log(`  [${provider}] ❌ attempt ${i + 1}: no output returned by provider`);
        continue;
      }

      bucket.successes += 1;

      // Tier A — run the raw output through the 9-stage pipeline. The counter
      // key derives from logContext.split('-')[0] = provider, so each provider
      // gets its own clean/repaired bucket.
      await parseAISafely<StoryGeneration>(
        { output: aiResponse.output, provider },
        {
          schema: STORY_GENERATION_SCHEMA_DEFINITION,
          requiredFields: STORY_GENERATION_REQUIRED_FIELDS,
          fallbackField: 'text',
          logContext: provider,
        },
      );

      // Tier B probe — cheap continuity check: the model must still mention a
      // character and stay in the location. (Full continuity needs DB recall;
      // this is a local signal, not a verdict.)
      const text = aiResponse.output.toLowerCase();
      const mentionsCharacter = CHARACTERS.some((c) => text.includes(c.toLowerCase()));
      const mentionsLocation = LOCATION.split(' ').slice(0, 3).some((word) => text.includes(word));
      if (mentionsCharacter && mentionsLocation) bucket.continuityHits += 1;
    } catch (error) {
      bucket.totalMs += Date.now() - startedAt;
      console.log(`  [${provider}] ⚠️ attempt ${i + 1} threw: ${error instanceof Error ? error.message : String(error)}`);
    }

    if ((i + 1) % 10 === 0) {
      console.log(`  [${provider}] progress: ${i + 1}/${RUNS_PER_PROVIDER}`);
    }
  }

  report[provider] = bucket;
}

/**
 * Resolves which provider→model pairs to test.
 *
 * Precedence: explicit CLI arg → DIFFUSION_MODELS + AI_CHAT_MODELS_DIFFUSION →
 * all of AI_CHAT_MODELS_DIFFUSION.
 */
function resolveSelections(): AIModelSelection {
  const argList = process.argv[2];
  if (argList) {
    const out: AIModelSelection = {};
    for (const provider of argList.split(',')) {
      const p = provider.trim() as AIChatProvider;
      out[p] = MODEL_OVERRIDE ? [MODEL_OVERRIDE] : undefined;
    }
    return out;
  }

  const out: AIModelSelection = {};
  for (const [provider, models] of Object.entries(AI_CHAT_MODELS_DIFFUSION)) {
    out[provider as AIChatProvider] = MODEL_OVERRIDE ? [MODEL_OVERRIDE] : models;
  }
  return out;
}

async function main(): Promise<void> {
  resetParseAdherenceStats();

  const selections = resolveSelections();
  const report: Record<string, { attempts: number; successes: number; continuityHits: number; totalMs: number }> = {};

  for (const [provider, models] of Object.entries(selections)) {
    const modelList = models ?? [];
    if (modelList.length === 0) {
      console.log(`[${provider}] ⚠️ no model configured — skipping`);
      continue;
    }

    const keyVar = AI_PROVIDER_API_KEYS[provider as AIChatProvider];
    if (!process.env[keyVar]) {
      console.log(`[${provider}] ⚠️ ${keyVar} not set — skipping (set it in .env before running)`);
      continue;
    }

    for (const model of modelList) {
      await runProvider(provider as AIChatProvider, model, report);
    }
  }

  console.log('\n\n=== PARSE ADHERENCE (Tier A) — repairRate < 15% is the target ===');
  console.table(getParseAdherenceStats());

  console.log('\n=== RUN SUMMARY (Tier B probe — full continuity needs DB, manual) ===');
  console.table(
    Object.fromEntries(
      Object.entries(report).map(([provider, b]) => [
        provider,
        {
          attempts: b.attempts,
          successes: b.successes,
          successRate: b.successes / b.attempts,
          continuityHits: b.continuityHits,
          continuityRate: b.successes ? b.continuityHits / b.successes : 0,
          avgMs: b.totalMs / b.attempts,
        },
      ]),
    ),
  );

  process.exit(0);
}

await main();