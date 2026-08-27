import type { StoryGeneration, StoryState, PlotFlag } from "../types/story.js";
import type {
  CanonValidationOutcome,
  CanonValidationResult,
  CanonValidationSummary,
  CanonViolationType,
} from "../types/canon-validation.js";
import type { AIJsonProperty } from "../types/ai-chat.js";
import type { AIChatProvider } from "../types/ai-chat.js";
import { getStoryStateInfo } from "../utils/story.js";
import { aiPrompt, createAIOptionsWithSchema } from "../utils/ai-chat.js";
import { AI_CHAT_MODELS_EVALUATION } from "../config/ai-clients.js";
import { AI_CHAT_CONFIG_DEFAULT } from "../config/ai-chat.js";
import { CANON_VALIDATION_MAX_OUTPUT_TOKEN, CANON_VALIDATION_MAX_REWRITE_ATTEMPTS, CANON_REWRITE_MAX_OUTPUT_TOKEN, CANON_VALIDATION_ENABLED } from "../config/canon-validation.js";
import { dbWrite } from "../db/client.js";
import { canonValidations } from "../db/schema.js";

// ============================================================================
// Schema for structured AI output
// ============================================================================

/** All valid violation category labels — drives both the AI schema enum and runtime validation */
const CANON_VIOLATION_TYPE_ENUM: CanonViolationType[] = [
  'timeline',
  'character_knowledge',
  'character_presence',
  'character_behavior',
  'established_fact',
  'place_state',
  'relationship',
  'inventory',
  'other',
];

/**
 * Structured-output schema definition for the validation judge.
 * Mirrors CanonValidationResult shape; consumed by createAIOptionsWithSchema
 * to enforce JSON adherence from the AI response.
 */
export const CANON_VALIDATION_SCHEMA_DEFINITION: Record<keyof CanonValidationResult, AIJsonProperty> = {
  outcome: {
    type: 'string',
    enum: ['passed', 'revised', 'rejected'],
  },
  violationType: {
    type: 'string',
    enum: CANON_VIOLATION_TYPE_ENUM,
  },
  violations: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: CANON_VIOLATION_TYPE_ENUM },
        description: { type: 'string' },
        severity: { type: 'number' },
      },
      required: ['type', 'description', 'severity'],
      additionalProperties: false,
    },
  },
  severityScore: { type: 'number' },
  description: { type: 'string' },
  revisedText: { type: 'string' },
};

/** Fields the AI must always populate — outcome, score, description, violations are mandatory */
export const CANON_VALIDATION_REQUIRED_FIELDS: (keyof CanonValidationResult)[] = [
  'outcome',
  'severityScore',
  'description',
  'violations',
];

// ============================================================================
// Context builders (slim lore snapshot for the judge)
// ============================================================================

/** Collapse factsHistory into a sorted bullet list — only the latest value per key */
function formatFactsForCanon(
  factsHistory: StoryState['factsHistory'],
): string {
  const entries: string[] = [];
  for (const [key, history] of Object.entries(factsHistory)) {
    const last = history.at(-1);
    if (last) {
      const pageInfo = last.page !== undefined ? ` (from page ${last.page})` : '';
      entries.push(`  · ${key}: ${last.value}${pageInfo}`);
    }
  }
  if (!entries.length) return '  No facts discovered yet.';
  return entries.sort().join('\n');
}

/** Summarise major plot flags (all retained) and recent minor developments */
function formatPlotFlagsForCanon(plotFlags: PlotFlag[]): string {
  if (!plotFlags.length) return '  None yet.';
  const major = plotFlags.filter((f) => f.isMajorEvent);
  const recent = plotFlags.filter((f) => !f.isMajorEvent).slice(-8);
  const lines: string[] = [];
  if (major.length) {
    lines.push('  Major Milestones (Crucial Canon):');
    for (const f of major) {
      lines.push(`  - [p.${f.page}] [${f.type.toUpperCase()}] ${f.fact} (MAJOR)`);
    }
  }
  if (recent.length) {
    lines.push('  Recent Developments:');
    for (const f of recent) {
      lines.push(`  - [p.${f.page}] [${f.type}] ${f.fact}`);
    }
  }
  return lines.join('\n');
}

/** Render up to 24 known characters with role, status, and up to 2 secrets each */
function formatCharactersForCanon(state: StoryState): string {
  const entries = Object.entries(state.characters);
  if (!entries.length) return '  None introduced.';
  return entries
    .slice(0, 24)
    .map(([id, ch]) => {
      const secrets = ch.secrets?.length ? `; secrets: ${ch.secrets.slice(0, 2).join('; ')}` : '';
      return `  · ${ch.knownName ?? id} (${ch.role}, status: ${ch.status}${secrets})`;
    })
    .join('\n');
}

/** Render up to 16 known places with type and truncated context */
function formatPlacesForCanon(state: StoryState): string {
  const entries = Object.entries(state.places);
  if (!entries.length) return '  None known.';
  return entries
    .slice(0, 16)
    .map(([id, p]) => `  · ${p.knownName ?? id} (${p.type}): ${(p.context ?? '').slice(0, 120)}`)
    .join('\n');
}

/** Render inventory items — appends xN count for stacked items */
function formatInventoryForCanon(state: StoryState): string {
  if (!state.inventory.length) return '  (empty)';
  return state.inventory
    .map((i) => `  · ${i.name}${i.amount && i.amount > 1 ? ` (x${i.amount})` : ''}`)
    .join('\n');
}

/** Render active narrative threads with priority and status */
function formatThreadsForCanon(state: StoryState): string {
  if (!state.threads.length) return '  No active threads.';
  return state.threads
    .map((t) => `  · [${t.priority}] ${t.title} (${t.status})`)
    .join('\n');
}

/** Serialise a single generated page into the structured context block the judge sees — text, location, characters, proposed facts */
function formatGeneratedPageForCanon(page: StoryGeneration): string {
  const parts: string[] = [];
  parts.push(`TEXT:\n"""\n${page.text}\n"""`);
  if (page.placeId) parts.push(`placeId: ${page.placeId}`);
  if (page.calendarDate) parts.push(`calendarDate: ${page.calendarDate}`);
  if (page.timeOfDay) parts.push(`timeOfDay: ${page.timeOfDay}`);
  if (page.sceneType) parts.push(`sceneType: ${page.sceneType}`);
  if (page.charactersPresent?.length) {
    parts.push(
      `charactersPresent: ${page.charactersPresent.map((c) => c.characterId).join(', ')}`,
    );
  }
  if (page.keyEvents?.length) {
    parts.push(`keyEvents:\n${page.keyEvents.map((e) => `  · ${e}`).join('\n')}`);
  }
  if (page.addPlotFlags?.length) {
    parts.push(
      `proposedPlotFlags:\n${page.addPlotFlags.map((f) => `  · ${f.fact} (${f.type})`).join('\n')}`,
    );
  }
  if (page.factUpdates?.length) {
    parts.push(
      `proposedFactUpdates:\n${page.factUpdates.map((f) => `  · ${f.key}: ${String(f.value ?? '')}`).join('\n')}`,
    );
  }
  return parts.join('\n');
}

/**
 * Slim story-state context for canon judgment — not the full writer prompt.
 */
export function buildCanonValidationContext(
  state: StoryState,
  generatedPage: StoryGeneration,
): string {
  const { phase, phaseGoal } = getStoryStateInfo(state);
  const { realityStability } = state.hiddenState;
  const { stability } = state.psychologicalProfile;

  return `GENERATED PAGE TO VALIDATE:
${formatGeneratedPageForCanon(generatedPage)}

STORY PHASE: ${phase} — ${phaseGoal}

CURRENT FACTS (source of truth):
${formatFactsForCanon(state.factsHistory)}

MAJOR / RECENT PLOT FLAGS:
${formatPlotFlagsForCanon(state.plotFlags)}

KNOWN CHARACTERS:
${formatCharactersForCanon(state)}

KNOWN PLACES:
${formatPlacesForCanon(state)}

MC INVENTORY:
${formatInventoryForCanon(state)}

ACTIVE THREADS:
${formatThreadsForCanon(state)}

REALITY DISTORTION:
- Reality stability: ${realityStability}
- Psychological stability: ${stability}

CONTEXT SUMMARY (lossy — soft reference only):
${(state.contextHistory || '(none)').slice(0, 1200)}`;
}

/**
 * Gate 2-style structured judge for generated page prose vs established lore.
 * Uses a detailed rubric of violation types and special rules (reality distortion,
 * lossy context) to prevent false positives from intentional narrative techniques.
 */
export function buildCanonValidationPrompt(
  state: StoryState,
  generatedPage: StoryGeneration,
): string {
  const context = buildCanonValidationContext(state, generatedPage);

  return `You are a canon continuity judge for a psychological thriller with branching narrative. Your job is to detect contradictions between a newly generated page and established story state — not to score prose quality, tension, or style.

Return a JSON object with this exact schema:

{
  "outcome": "passed" | "revised" | "rejected",
  "violationType": "timeline" | "character_knowledge" | "character_presence" | "character_behavior" | "established_fact" | "place_state" | "relationship" | "inventory" | "other" | null,
  "violations": [
    { "type": "<same enum>", "description": "brief internal reason", "severity": 0.0-1.0 }
  ],
  "severityScore": 0.0-1.0,
  "description": "1-2 sentence internal summary",
  "revisedText": "full corrected page prose if outcome is revised, otherwise null or omit"
}

OUTCOME RULES:
1. passed — No hard contradictions with facts, character knowledge, presence, inventory, places, relationships, or timeline. Minor stylistic issues are NOT violations. Empty violations array. severityScore near 0.
2. revised — Fixable contradictions exist. Provide revisedText that keeps narrative voice, trajectory, and structure but removes or softens the contradictions. Prefer minimal edits. Set violationType to the dominant type.
3. rejected — Critical, non-local contradictions that would require rewriting the whole scene (e.g. character dead but conversing without uncanny framing; major fact reversed without in-world justification; inventory item used that never existed and cannot be narrated as a failed attempt). Leave revisedText null.

WHAT COUNTS AS A VIOLATION:
- established_fact: Contradicts CURRENT FACTS or major plot flags without narrator unreliability framing
- character_knowledge: Character knows something they never learned
- character_presence: Character on-scene who cannot be there (dead, elsewhere with no transition) without intentional uncanny framing
- character_behavior: Personality/relationship shift with no cause
- timeline: calendarDate/timeOfDay/order of events impossible vs established sequence
- place_state: Place properties or connections contradict known place memory
- relationship: Relationship state contradicted
- inventory: MC uses item not in inventory without failure framing

SPECIAL RULES:
- Reality distortion / psychological instability: when reality is slipping/broken or psychology is unstable, dream logic and unreliable perception are ALLOWED. Only flag contradictions that are NOT grounded in narrator unreliability.
- Do not invent new plot. Prefer passed when uncertain.
- contextHistory is lossy — prefer facts, plot flags, characters, places, inventory over the summary.
- Never reveal hidden narrative state in description beyond what is needed for engineering audit.
- revisedText must be the full page text in the same language as the original, not a summary.

${context}`;
}

/**
 * Build the prompt for the targeted rewrite pass (invoked on rejected outcome).
 * Feed it only the violation details + original text — no redundant context.
 */
function buildCanonRewritePrompt(
  state: StoryState,
  generatedPage: StoryGeneration,
  validation: CanonValidationResult,
): string {
  const violationList =
    validation.violations?.map((v) => `- [${v.type}] ${v.description}`).join('\n') ||
    `- ${validation.description}`;

  return `You are rewriting a psychological-thriller story page to fix canon contradictions. Keep voice, pacing, and trajectory. Fix only the listed issues.

VIOLATIONS TO FIX:
${violationList}

ESTABLISHED FACTS (do not contradict):
${formatFactsForCanon(state.factsHistory)}

ORIGINAL PAGE TEXT:
"""
${generatedPage.text}
"""

Return JSON only:
{
  "text": "full corrected page prose"
}`;
}

// ============================================================================
// Normalize / apply
// ============================================================================

/** Canonical set of valid outcome labels — any other string from the AI is treated as null (fail-open) */
const VALID_OUTCOMES = new Set<CanonValidationOutcome>(['passed', 'revised', 'rejected']);

/**
 * Sanitise and coerce a raw AI response into a well-typed CanonValidationResult.
 * Handles missing fields, out-of-range scores, invalid enum values, and two
 * implicit demotion rules (revised→rejected when no text; passed→revised/rejected
 * when contradictions exist). Returns null only when outcome is missing or invalid.
 */
function normalizeValidationResult(
  raw: CanonValidationResult | null | undefined,
): CanonValidationResult | null {
  if (!raw || !VALID_OUTCOMES.has(raw.outcome)) return null;

  const severityScore = Math.min(1, Math.max(0, Number(raw.severityScore) || 0));
  const violations = Array.isArray(raw.violations)
    ? raw.violations.map((v) => ({
        type: (CANON_VIOLATION_TYPE_ENUM.includes(v.type as CanonViolationType)
          ? v.type
          : 'other') as CanonViolationType,
        description: String(v.description ?? ''),
        severity: Math.min(1, Math.max(0, Number(v.severity) || 0)),
      }))
    : [];

  let outcome = raw.outcome;
  const revisedText =
    typeof raw.revisedText === 'string' && raw.revisedText.trim().length > 0
      ? raw.revisedText.trim()
      : null;

  // revised without usable text → treat as reject so rewrite path can run
  if (outcome === 'revised' && !revisedText) {
    outcome = 'rejected';
  }

  // passed with high severity → demote to revised if we have text, else reject
  if (outcome === 'passed' && severityScore >= 0.55 && violations.length > 0) {
    outcome = revisedText ? 'revised' : 'rejected';
  }

  return {
    outcome,
    violationType: raw.violationType ?? violations[0]?.type ?? null,
    violations,
    severityScore,
    description: String(raw.description ?? ''),
    revisedText,
  };
}

/**
 * Apply validation outcome to a generated page (text only — metadata is authoritative).
 * Only `revised` with usable `revisedText` mutates the page; all other outcomes
 * pass through unchanged so the story continues even on rejection.
 */
export function applyCanonValidationToPage(
  page: StoryGeneration,
  result: CanonValidationResult,
): StoryGeneration {
  if (result.outcome === 'revised' && result.revisedText) {
    return { ...page, text: result.revisedText };
  }
  return page;
}

// ============================================================================
// AI calls
// ============================================================================

/**
 * Run the structured validation AI call.
 * fail-open: any error returns `{ result: null }` so generation is never blocked.
 * The AI options are built with schema enforcement (createAIOptionsWithSchema)
 * and the judge model selection from AI_CHAT_MODELS_EVALUATION.
 */
async function runCanonValidationAi(
  state: StoryState,
  generatedPage: StoryGeneration,
  bookId: string,
): Promise<{
  result: CanonValidationResult | null;
  provider?: AIChatProvider | 'none';
  model?: string;
}> {
  const userPrompt = buildCanonValidationPrompt(state, generatedPage);

  const evalConfig = {
    schema: CANON_VALIDATION_SCHEMA_DEFINITION,
    requiredFields: CANON_VALIDATION_REQUIRED_FIELDS,
    fallbackField: 'description' as const,
    baseOptions: {
      modelSelection: AI_CHAT_MODELS_EVALUATION,
      context: 'canon-validation',
      config: { ...AI_CHAT_CONFIG_DEFAULT, maxOutputToken: CANON_VALIDATION_MAX_OUTPUT_TOKEN },
      meta: { bookId },
    },
  };

  try {
    const options = createAIOptionsWithSchema<CanonValidationResult>(evalConfig);
    const response = await aiPrompt<CanonValidationResult>(userPrompt, options);
    return {
      result: normalizeValidationResult(response.result),
      provider: response.provider,
      model: response.model,
    };
  } catch (error) {
    console.error('[canon-validation] ❌ AI validation failed (fail-open):', error);
    return { result: null };
  }
}

/**
 * Run the targeted rewrite AI call.
 * Uses `satisfies Record<'text', AIJsonProperty>` for schema definition
 * without losing the literal type — only `text` is needed.
 * fail-open: returns null on any error.
 */
async function runCanonRewriteAi(
  state: StoryState,
  generatedPage: StoryGeneration,
  validation: CanonValidationResult,
  bookId: string,
): Promise<string | null> {
  const userPrompt = buildCanonRewritePrompt(state, generatedPage, validation);

  const rewriteConfig = {
    schema: {
      text: { type: 'string' as const },
    } satisfies Record<'text', AIJsonProperty>,
    requiredFields: ['text'] as ('text')[],
    fallbackField: 'text' as const,
    baseOptions: {
      modelSelection: AI_CHAT_MODELS_EVALUATION,
      context: 'canon-rewrite',
      config: { ...AI_CHAT_CONFIG_DEFAULT, maxOutputToken: CANON_REWRITE_MAX_OUTPUT_TOKEN },
      meta: { bookId },
    },
  };

  try {
    const options = createAIOptionsWithSchema<{ text: string }>(rewriteConfig);
    const response = await aiPrompt<{ text: string }>(userPrompt, options);
    const text = response.result?.text?.trim();
    return text && text.length > 0 ? text : null;
  } catch (error) {
    console.error('[canon-validation] ❌ AI rewrite failed:', error);
    return null;
  }
}

// ============================================================================
// Public orchestration
// ============================================================================

/** Shape returned to callers — includes the (possibly rewritten) page, a reader-facing summary, and a full audit trail */
export type CanonValidationPassResult = {
  page: StoryGeneration;
  summary: CanonValidationSummary | null;
  audit: {
    outcome: CanonValidationOutcome;
    violationType?: CanonViolationType | null;
    description: string;
    severityScore: number;
    violations: CanonValidationResult['violations'];
    wasRevised: boolean;
    rewriteAttempts: number;
  } | null;
};

/**
 * Generation-time canon pass — the main entry point.
 *
 * Flow:
 * 1. Check enabled (per-call override → config default)
 * 2. Structured AI validation against story state
 * 3. Passed → return page as-is with audit
 * 4. Revised with text → apply revision immediately, return
 * 5. Rejected (or revised without text) → enter capped rewrite loop:
 *    a. Targeted AI rewrite of just the contradictions
 *    b. Re-validate the rewritten page
 *    c. If passed/revised → return; if still rejected → retry up to N times
 * 6. Residual reject → fail-open: return best page anyway so generation pipeline isn't blocked
 *
 * The rewrite loop is capped by CANON_VALIDATION_MAX_REWRITE_ATTEMPTS (default 1)
 * to prevent infinite AI calls on an irreconcilable page.
 */
export async function runCanonValidationPass(params: {
  state: StoryState;
  generatedPage: StoryGeneration;
  bookId: string;
  logContext?: string;
  /** Per-call override; when omitted, uses CANON_VALIDATION_ENABLED (default false). */
  enabled?: boolean;
}): Promise<CanonValidationPassResult> {
  const { state, bookId, enabled = CANON_VALIDATION_ENABLED } = params;
  const logContext = params.logContext ?? 'canon-validation';

  // Gate: per-call override OR config default; if disabled, skip all validation work
  if (!enabled) {
    return { page: params.generatedPage, summary: null, audit: null };
  }

  let page = params.generatedPage;
  let rewriteAttempts = 0;
  let wasRevised = false;

  // Step 1: initial structured validation judgement
  const { result: firstResult } = await runCanonValidationAi(state, page, bookId);

  if (!firstResult) {
    // fail-open: AI error or no valid outcome → return original page, no audit
    console.warn(`[${logContext}] ⚠️ Canon validation returned no result — fail-open`);
    return { page, summary: null, audit: null };
  }

  // Step 2: clean pass → return immediately with audit trail
  if (firstResult.outcome === 'passed') {
    console.log(`[${logContext}] ✅ Canon validation passed (severity=${firstResult.severityScore})`);
    return {
      page,
      summary: { outcome: 'passed', wasRevised: false, severityScore: firstResult.severityScore },
      audit: {
        outcome: 'passed',
        violationType: firstResult.violationType,
        description: firstResult.description,
        severityScore: firstResult.severityScore,
        violations: firstResult.violations,
        wasRevised: false,
        rewriteAttempts: 0,
      },
    };
  }

  // Step 3: AI self-revised with usable text → apply revision and return
  if (firstResult.outcome === 'revised' && firstResult.revisedText) {
    page = applyCanonValidationToPage(page, firstResult);
    console.log(
      `[${logContext}] 🔧 Canon revised page (type=${firstResult.violationType}, severity=${firstResult.severityScore})`,
    );
    return {
      page,
      summary: {
        outcome: 'revised',
        violationType: firstResult.violationType ?? undefined,
        severityScore: firstResult.severityScore,
        wasRevised: true,
      },
      audit: {
        outcome: 'revised',
        violationType: firstResult.violationType,
        description: firstResult.description,
        severityScore: firstResult.severityScore,
        violations: firstResult.violations,
        wasRevised: true,
        rewriteAttempts: 0,
      },
    };
  }

  // Step 4: rejected (or revised without text) → enter capped rewrite loop
  let lastResult: CanonValidationResult = firstResult;

  while (rewriteAttempts < CANON_VALIDATION_MAX_REWRITE_ATTEMPTS) {
    rewriteAttempts += 1;
    console.log(
      `[${logContext}] 🔁 Canon reject → rewrite attempt ${rewriteAttempts}/${CANON_VALIDATION_MAX_REWRITE_ATTEMPTS}`,
    );

    // Step 4a: targeted AI rewrite limited to the listed violations
    const rewritten = await runCanonRewriteAi(state, page, lastResult, bookId);
    if (!rewritten) break; // rewrite failed → exit loop, keep best page

    page = { ...page, text: rewritten };
    wasRevised = true;

    // Step 4b: re-validate the rewritten page
    const { result: recheck } = await runCanonValidationAi(state, page, bookId);
    if (!recheck) break; // re-check failed → exit loop, keep rewritten page
    lastResult = recheck;

    // Step 4c: rewrite fully resolved contradictions → return as revised
    if (recheck.outcome === 'passed') {
      console.log(`[${logContext}] ✅ Canon re-check passed after rewrite`);
      return {
        page,
        summary: {
          outcome: 'revised',
          violationType: firstResult.violationType ?? undefined,
          severityScore: recheck.severityScore,
          wasRevised: true,
        },
        audit: {
          outcome: 'revised',
          violationType: firstResult.violationType,
          description: `Rewritten after reject: ${firstResult.description}`,
          severityScore: recheck.severityScore,
          violations: firstResult.violations,
          wasRevised: true,
          rewriteAttempts,
        },
      };
    }

    // Step 4d: rewrite reduced severity but minor issues remain → apply revised text
    if (recheck.outcome === 'revised' && recheck.revisedText) {
      page = applyCanonValidationToPage(page, recheck);
      console.log(`[${logContext}] 🔧 Canon re-check applied further revision`);
      return {
        page,
        summary: {
          outcome: 'revised',
          violationType: recheck.violationType ?? firstResult.violationType ?? undefined,
          severityScore: recheck.severityScore,
          wasRevised: true,
        },
        audit: {
          outcome: 'revised',
          violationType: recheck.violationType ?? firstResult.violationType,
          description: recheck.description,
          severityScore: recheck.severityScore,
          violations: recheck.violations.length ? recheck.violations : firstResult.violations,
          wasRevised: true,
          rewriteAttempts,
        },
      };
    }
  }

  // Step 5: residual reject — exhausted rewrite attempts or AI kept rejecting
  // fail-open: return the best available (possibly rewritten) page so the
  // generation pipeline is never blocked by an irreconcilable page
  console.warn(
    `[${logContext}] ⚠️ Canon residual reject after ${rewriteAttempts} rewrite(s) — persisting best page (type=${lastResult.violationType})`,
  );

  return {
    page,
    summary: {
      outcome: 'rejected',
      violationType: lastResult.violationType ?? firstResult.violationType ?? undefined,
      severityScore: lastResult.severityScore,
      wasRevised,
    },
    audit: {
      outcome: 'rejected',
      violationType: lastResult.violationType ?? firstResult.violationType,
      description: lastResult.description,
      severityScore: lastResult.severityScore,
      violations: lastResult.violations,
      wasRevised,
      rewriteAttempts,
    },
  };
}

/**
 * Persist audit row after the page has an id. Fire-and-forget safe.
 */
export async function insertCanonValidationAudit(params: {
  bookId: string;
  pageId: string;
  audit: NonNullable<CanonValidationPassResult['audit']>;
}): Promise<void> {
  const { bookId, pageId, audit } = params;
  try {
    await dbWrite.insert(canonValidations).values({
      bookId,
      pageId,
      outcome: audit.outcome,
      violationType: audit.violationType ?? null,
      description: audit.description,
      severityScore: audit.severityScore,
      violations: audit.violations,
      wasRevised: audit.wasRevised,
      rewriteAttempts: audit.rewriteAttempts,
    });
  } catch (error) {
    console.error('[canon-validation] ❌ Failed to insert audit row:', error);
  }
}

/**
 * Downcast a full audit into the reader-facing summary shape.
 * Softens a `rejected` outcome to `revised` when a rewrite was actually
 * applied — the reader only needs to know the page was repaired,
 * not the internal severity of the original violation.
 */
export function toCanonValidationSummary(
  audit: CanonValidationPassResult['audit'],
): CanonValidationSummary | null {
  if (!audit) return null;
  return {
    outcome: audit.outcome === 'rejected' && audit.wasRevised ? 'revised' : audit.outcome,
    violationType: audit.violationType ?? undefined,
    severityScore: audit.severityScore,
    wasRevised: audit.wasRevised,
  };
}
