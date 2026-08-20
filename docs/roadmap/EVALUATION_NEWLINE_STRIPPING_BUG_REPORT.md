# Evaluation Pass Strips Paragraph Breaks (`\n\n`) from Story Pages — Bug Report & Implementation Plan

> **Document Version:** 1.2.0  
> **Date:** 2026-08-20  
> **Status:** Review & Decision Pending  
> **Bug Severity:** High (silent content corruption on every evaluated page)  
> **Audited Files:**  
> - `Twistloom-backend/src/utils/ai-chat.ts` (evaluation orchestration: `aiPrompt`, `runEvaluationPass`)  
> - `Twistloom-backend/src/utils/ai-parser.ts` (`parseAISafely`, `sanitise`)  
> - `Twistloom-backend/src/utils/prompt.ts` (`buildNextPageEvaluatorPrompt`, `buildEvaluatorOuputFormatBlurb`, `evaluateMergedStoryGeneration`, `executePromptForJSON`)  
> - `Twistloom-backend/src/schema/story.ts` (`buildEvaluationSchemaDefinition`, `EVALUATION_REQUIRED_FIELDS`)  
> - `Twistloom-backend/src/config/ai-clients.ts` (`AI_CHAT_MODELS_EVALUATION`)  
> - `Twistloom-backend/src/services/book.ts` (`buildBookMetaDocuments`)  

---

## 1. Executive Summary

Two distinct defects in the generation → evaluation pipeline are reported here.

**Finding 1 — Newline stripping (primary, high severity).** The evaluation pass silently destroys newline characters inside generated page text when it runs in "string mode" (its default for Gemini and `'auto'`).

Given this generated page text (paragraph breaks intact):

```
{"text":"Aku melantingkan tubuhku ke balik pilar beton di ujung lorong. Siku kananku membentur sudut semen yang kasar, mengirimkan sengatan nyeri hingga ke bahu.\n\n*PRRAAANG!*\n\nSuara ledakan kaca memecah keheningan bawah tanah.","mood":"panic",...}
```

...after the evaluation pass the reader sees:

```
{"text":"Aku melantingkan tubuhku ke balik pilar beton di ujung lorong. Siku kananku membentur sudut semen yang kasar, mengirimkan sengatan nyeri hingga ke bahu.PRRAAANG!Suara ledakan kaca memecah keheningan bawah tanah.","mood":"panic",...}
```

Every `\n` escape is gone — and in the observed production case the `**` emphasis markers around `*PRRAAANG!*` were removed too — paragraphs are fused together with no whitespace at all.

**Root cause (corrected in v1.2.0): the evaluator *model* strips the formatting itself during its correction pass — it is not a parser defect.** The raw provider output (logged *before* `parseAISafely` runs, `ai-chat.ts:114` vs `:1574`) already contains the fused text with no newlines and no asterisks; there are no raw bytes for `sanitise()` to delete. The evaluator's own `scoreBefore.issues` explicitly rationalizes the removal:

```json
{
  "dimension": "style",
  "issue": "The 'text' field contains '\\n\\n' control tokens, which are explicitly forbidden by the prompt.",
  "suggestion": "Remove all '\\n' and '\\t' characters from the 'text' string."
}
```

**No such rule exists.** A comprehensive search of `prompt.ts` (RULES, `FIELD INSTRUCTIONS`, output formats, evaluation rubric), `schema/story.ts` (`buildEvaluationSchemaDefinition`), and the field-instruction builders found nothing forbidding `\n`/`\t` in `text`. The justification is a model hallucination; the model gratuitously normalizes the prose in its "style" pass, deleting `\n\n` escapes (and `**` markers) that it perceives as formatting noise. (It then *also* fixes legitimate issues — injury decay, missing `pageAcquired`, etc. — so the correction pass runs and persists the corrupted text.)

**Secondary risk factor (not the cause of the observed corruption):** `sanitise()` in `parseAISafely` genuinely deletes raw LF/CR/TAB bytes from provider output (`ai-parser.ts:834`). If any model ever emits raw newline bytes instead of escapes, sanitise destroys them. This is a latent defect and worth fixing as defense-in-depth, but it did **not** corrupt the reported page — the model never emitted raw bytes.

**Finding 2 — Duplicate, untitled output-format block in the evaluator system prompt (medium severity).** The evaluator's system prompt contains **two copies** of the generation output JSON format, stacked back-to-back between the `DIALOGUE ACTIONS:` rules section and the `BOOK META:` document, with **no section title** explaining what either block is. The root cause is an inheritance bug in `runEvaluationPass`: it reuses the already-output-format-resolved system prompt *and* re-appends `options.outputFormat` on top. Reproduced byte-count-wise (exactly 2 occurrences) in §10. This wastes tokens, bloats prompt-cache content, and gives the evaluator contradictory, unexplained framing.

**Fix at a glance:** (Finding 1) **primary:** harden the evaluator prompt to mandate *verbatim* preservation of the `text` field — every `\n` escape and `**` marker must survive the correction pass; **defense-in-depth:** make the evaluation's inner `JSON.parse` tolerant (repair raw/under-escaped inner JSON), and stop `sanitise()` from deleting LF/CR/TAB bytes. (Finding 2) drop the inherited `outputFormat` from the evaluation call so the format is appended exactly once, and label the remaining block so the AI understands what it is. All changes are small, local, and verified against reproductions.

---

## 2. Bug Description

### 2.1 Repro (before → after)

**Input to evaluation** — `result.output`, the generated `StoryGeneration` JSON string, injected into the evaluator prompt as the `GENERATED JSON (from previous AI)` document (`ai-chat.ts:1689-1695`):

```json
{"text":"Aku melantingkan tubuhku ke balik pilar beton di ujung lorong. Siku kananku membentur sudut semen yang kasar, mengirimkan sengatan nyeri hingga ke bahu.\n\n*PRRAAANG!*\n\nSuara ledakan kaca memecah keheningan bawah tanah.","mood":"panic"}
```

**Output of evaluation** — `evaluationResult.output`, the corrected JSON string returned by the evaluator and later `JSON.parse`d:

```json
{"text":"Aku melantingkan tubuhku ke balik pilar beton di ujung lorong. Siku kananku membentur sudut semen yang kasar, mengirimkan sengatan nyeri hingga ke bahu.PRRAAANG!Suara ledakan kaca memecah keheningan bawah tanah.","mood":"panic"}
```

Observe: `bahu.\n\n*PRRAAANG!*\n\nSuara` → `bahu.PRRAAANG!Suara`. Both the newline escapes **and** the `*` emphasis markers were **deleted** by the evaluator model in its correction pass — not by the parser.

### 2.2 Evidence: the corruption is present in the pre-parse raw output

`logAISuccess` prints the raw provider response (`ai-logger.ts:20`) at `ai-chat.ts:114` — **before** `parseAISafely` runs at `ai-chat.ts:1574`. The production log for the affected page shows the fused text in that raw block:

```
[gemini] ✅ gemini-2.5-flash succeeded (8375 chars, finish: STOP, duration: 28270ms)
  """
  {
    "output": "{\"text\":\"Aku melantingkan tubuhku ke balik pilar beton di ujung lorong. Siku kananku membentur sudut semen yang kasar, mengirimkan sengatan nyeri hingga ke bahu.PRRAAANG!Suara ledakan kaca ...
```

There are no real newline bytes and no `\n` escapes — the model emitted the fused text directly. `sanitise()` had nothing to remove. The same response's `scoreBefore.issues` states the model's own rationale (quoted in §1). This is conclusive: **the damage originates inside the model, before any parsing.**

### 2.3 Impact

- **Page prose loses all paragraph/section breaks** — a single unreadable wall of text for the reader.
- **Silent**: no error is raised, no fallback to the pre-evaluation page happens. The corrupted page is persisted.
- **Non-obvious to debug**: the generation output (pre-evaluation) is correct, and the corruption is only visible by inspecting the *raw evaluator output* — the parsed result contains no trace of the original newlines.

---

## 3. Pipeline Walk-through

The evaluation pass is orchestrated by `runEvaluationPass` (`ai-chat.ts:1647-1761`), called from `aiPrompt` (`ai-chat.ts:1562-1565`):

1. **`aiPrompt` generates a page.** `result.output` is the full `StoryGeneration` JSON as a string (e.g. `{"text":"...\n\n...","mood":"panic",...}`). The `\n` here are literal backslash-`n` (2-char) sequences — valid JSON escapes.

2. **`runEvaluationPass` injects it as a document.** `result.output` becomes the snippet of the `GENERATED JSON (from previous AI)` document (`ai-chat.ts:1689-1695`). It is embedded verbatim into the evaluator's system prompt via `formatSystemPromptWithDocuments` (`ai-chat.ts:1934-1949`). The model therefore *sees* `\n\n` and interprets it as paragraph breaks.

3. **The evaluator is asked to re-emit the full corrected JSON as a string.** In string mode (the default — see §4.1), the schema's `output` field is `{ type: 'string' }` (`schema/story.ts:773-777`) and the prompt demands "the FULL corrected JSON serialized as a VALID JSON STRING" (`prompt.ts:1779-1783`). To do this *correctly*, the model must **double-escape**: the paragraph break inside the inner JSON must appear in the outer string literal as `\\n` (two backslashes), so that after the outer parse the inner JSON still contains `\n`, so that the final `JSON.parse` yields a real newline.

4. **The evaluator "corrects" the story.** STEP 3 of the evaluation instructions (`prompt.ts:1831-1835`) tells the model to rewrite prose only when required and to follow the writing-style rules. In practice the model treats `\n\n` escapes and `**` markers as formatting noise and strips them — **this is the corruption point, inside the model** (see §2.2).

5. **`aiPrompt` parses the evaluator response with `parseAISafely`.** The raw evaluator text flows through `parseAISafely` (`ai-chat.ts:1572-1579`) → `sanitise()` (`ai-parser.ts:832-839`). For the observed page this is a **no-op** w.r.t. newlines — the model already removed them.

6. **`runEvaluationPass` parses the inner JSON.** `correctedOutput = JSON.parse(raw)` (`ai-chat.ts:1726`). Because the model already fused the text, the parsed `text` is fused. (When a model *does* preserve escapes, this step is where a single-escape would otherwise cause a graceful fallback — see §4.3, case B.)

The whole design is a **double-encoded JSON round-trip**:
`StoryGeneration object → inner JSON string → outer evaluation object → (outer parse) → inner JSON string → (inner parse) → StoryGeneration object`.

---

## 4. Root Cause Analysis

### 4.1 Why string mode (the fragile part is unavoidable today)

`buildEvaluationSchemaDefinition` (`schema/story.ts:756-852`) has two modes:

- **Structured mode** (`useStringEvaluatorOutput = false`): `output` is a nested object schema copied from the generation schema. Providers enforce the full 35-field `StoryGeneration` shape.
- **String mode** (`useStringEvaluatorOutput = true`, default when `'auto'`): `output` is `{ type: 'string' }`; the model must produce a JSON *string* containing the corrected JSON document.

`resolveUseStringEvaluator` (`ai-chat.ts:1841-1847`) resolves `'auto'` → `true` whenever `gemini` is in the evaluator chain — and `AI_CHAT_MODELS_EVALUATION` puts **Gemini first** (`ai-clients.ts:775-779`). String mode exists because Gemini's constrained decoder cannot compile the full `StoryGeneration` schema (`GEMINI_SCHEMA_COMPLEXITY_ROADMAP.md`). So the double-encoding is a deliberate workaround and stays in place; we must harden the prompt *and* the parsing around it.

### 4.2 Primary cause: the evaluator model strips formatting in its correction pass

The raw evaluator output (pre-parse) for the affected page contained the fused text and the evaluator's own `scoreBefore.issues` entry claiming `\n\n` are "control tokens … explicitly forbidden by the prompt." No such prohibition exists anywhere in the codebase (verified by search across `prompt.ts`, `schema/story.ts`, field-instruction builders, and the evaluation rubric). The model:

1. Misreads `\n` inside the `GENERATED JSON` document as literal backslash-noise rather than as JSON escapes representing paragraph breaks.
2. In STEP 3 (CORRECT), applies a gratuitous "style normalization" that deletes `\n\n` escapes and `**` emphasis markers from the prose.
3. Persists that normalized text in the corrected `output`, which is then parsed and stored verbatim.

The model is not *being told* to do this — there is no prompt text driving it. It is a failure of instruction-following on the string-mode round-trip. The fix therefore belongs in the **prompt** (explicitly mandate verbatim preservation) with **parser hardening** as a safety net for the other escaping behaviors (§4.3).

### 4.3 Secondary factor: evaluator escaping behavior on the double-encoded round-trip

The evaluator must re-emit `\n\n` as `\\n\\n` inside the outer string. Models in the evaluator pool (Gemini flash tier, several `:free`/small models, `ai-clients.ts:775-804`) routinely get this wrong. Observed escaping behaviors:

| Model behavior in raw evaluator output | Outer JSON validity | Result today |
| --- | --- | --- |
| **A. Correct double-escape** `\\n\\n` | Valid | ✅ Newlines survive both parses. |
| **B. Single-escape** `\n\n` (backslash-`n`) | Valid (outer parse decodes to real newlines in `output`) | ⚠️ Inner `JSON.parse` (line 1726) throws → graceful fallback to original page (newlines survive, but the evaluator's *corrections* are discarded). |
| **C. Raw newline bytes** (unescaped LF) | Invalid | 🔴 `sanitise()` deletes the bytes → page persists with fused paragraphs. |
| **D. Strips the escapes entirely** (observed in production) | Valid | 🔴 The corrected `text` simply has no paragraph breaks (and often loses `**` markers). **The reported bug.** |

Case D is what happened in production: the model did not mis-escape — it *removed* the escapes and markers outright (evidence in §2.2). Case C is a related latent defect in `sanitise()` that can produce the same symptom via a different path.

### 4.4 Blast radius

- **Every evaluated page is at risk.** The corruption is triggered by the model's discretionary "style" pass, so it is probabilistic per-call and can strike regardless of prompt content.
- **The `sanitise()` defect (case C) is latent but real.** If a generation or evaluation model ever emits raw LF bytes (e.g. for `bio`, `appearance`, `contextHistory`, `viableEnding.text`, future-note summaries), `sanitise()`'s control-char deletion (`ai-parser.ts:834`) and `\s+` collapse (`:837`) destroy the newlines. This should be fixed defensively even though it is not the cause of the observed corruption.

---

## 5. Empirical Verification

1. **Production raw-log evidence (case D).** The pre-parse Gemini response (logged at `ai-chat.ts:114`) shows the corrected `output` with fused text (`bahu.PRRAAANG!Suara`) and the model's own rationalization in `scoreBefore.issues` ("forbidden by the prompt"). No newline bytes existed to be stripped. This *exonerates* `sanitise()` for the reported page and pins the root cause on model behavior.

2. **`sanitise()` current behavior (case C, latent defect).** Byte-level reproduction on `Bun v1.3.14`: raw evaluator output containing real LF bytes → after lines 834 + 837, `...bahu.\n\n*PRRAAANG!*\n\nSuara...` → `...bahu.*PRRAAANG!*Suara...` (bytes deleted); `parseAISafely` returned `text` without newlines, and `jsonrepair` succeeded on the now-"valid" text (test files created, run, and deleted per AGENTS.md).

3. **`sanitise()` proposed behavior** (preserve `\t\n\r`; collapse only `[^\S\r\n]+`): LF bytes survive to the repair stage; `jsonrepair` escapes them to `\n`; the final double-parse yields **real newline characters** in `text`.

4. **Inner parse tolerance** (`ai-chat.ts:1726`): `JSON.parse` alone rejects the real-newline inner document (`Unterminated string`), but `jsonrepair` + `JSON.parse` recovers it with newlines intact.

5. **Bun/V8 `JSON.parse`** rejects raw LF/CR/TAB bytes inside strings (all five tested control bytes rejected) — confirming the repair step is mandatory, not optional, in the hardened pipeline.

Result: case D needs the **prompt** fix (Phase 1); cases B/C need the **parser** fixes (Phases 2–3). With all phases applied, every model behavior (A/B/C/D) either preserves newlines or degrades gracefully — never corrupts.

---

## 6. Implementation Plan

### Phase 1 — Prompt hardening: mandate verbatim `text` preservation (core fix)

**File:** `src/utils/prompt.ts` — `buildNextPageEvaluatorPrompt` (`:1785`), `buildFirstBookEvaluatorPrompt` (`:2169`), and `buildEvaluatorOuputFormatBlurb` (`:1779-1783`).

The evaluator must be told explicitly that the prose formatting is meaningful and must survive the round-trip. Add to the STEP 3 (CORRECT) block and to the string-mode output blurb:

```
STEP 3 — CORRECT
...
CRITICAL — the "text" field must be preserved VERBATIM unless a substantive correction forces a rewrite:
  - Keep every paragraph break: a "\\n" inside the inner JSON is a real line break and must be re-emitted as "\\n" (escaped) inside the outer "output" string. Never delete, merge, or reflow paragraph breaks.
  - Keep all "**" / "*" emphasis markers exactly as written.
  - Never "clean up", rewrap, or normalize prose formatting during scoring or correction.
```

And in the output-format blurb (`prompt.ts:1779-1783`):

```
CRITICAL — the "output" field must be the FULL corrected JSON serialized as a VALID JSON STRING (see "EXPECTED JSON SCHEMA"). Begin with "{" and end exactly with "}". PRESERVE all inner escape sequences verbatim: every paragraph break inside the corrected JSON must be written as \\n\\n (backslash-n) — never as a literal newline, never removed. Preserve "**" / "*" emphasis markers exactly as written.
```

Why this is the primary fix: the production evidence (§2.2) shows the model *invented* a justification for stripping (`forbidden by the prompt`). An explicit, emphatic instruction to the contrary is the direct countermeasure. It is still a heuristic — prompts cannot guarantee model behavior — which is why Phases 2–3 exist as a safety net.

### Phase 2 — Tolerant inner parse in `runEvaluationPass` (completeness fix)

**File:** `src/utils/ai-parser.ts` (new exported helper) and `src/utils/ai-chat.ts:1723-1732`

Add a repair-aware string parser next to `parseAISafely` (keeps all JSON-repair logic in one module):

```typescript
/**
 * Parses an AI-produced JSON *document string* (the `output` field of a
 * string-mode evaluation) with newline tolerance.
 *
 * Models frequently emit the inner JSON with raw line-feed bytes instead of
 * `\n` escapes. Native JSON.parse rejects those; jsonrepair escapes them back,
 * so the paragraph breaks survive the round-trip.
 *
 * @param raw - JSON document text to parse
 * @returns The parsed value, or `null` when neither strategy succeeds
 */
export function parseJsonStringTolerant(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    // fall through to repair
  }
  try {
    return JSON.parse(jsonrepair(raw));
  } catch {
    return null;
  }
}
```

Use it in `runEvaluationPass`:

```typescript
// src/utils/ai-chat.ts:1723-1732 (string-mode branch)
if (evaluationOptions.useStringEvaluatorOutput) {
  try {
    const raw = evaluationResult.output as unknown as string;
    const parsed = raw ? parseJsonStringTolerant(raw) : null;
    correctedOutput = parsed !== null ? parsed as T : undefined;
  } catch {
    console.warn(`[${evaluationContext}] ⚠️ Failed to parse evaluator string output as JSON — falling back to original`);
  }
}
```

This converts model behaviors **B** (single-escape) and **C** (raw bytes) from "fall back to original" / "silently corrupt" into "evaluation succeeds with newlines preserved". The existing graceful fallback remains for genuinely unparseable cases.

### Phase 3 — Fix `sanitise()` to be newline-preserving (defense-in-depth)

**File:** `src/utils/ai-parser.ts:832-839`

```typescript
function sanitise(input: string): string {
  return input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '') // control chars — keeps \t \n \r
    .replace(/\uFFFD/g, '')                                                  // Unicode replacement char
    .replace(/[\u200B-\u200F\uFEFF]/g, '')                                   // zero-width / BOM chars
    .replace(/[^\S\r\n]+/g, ' ')                                             // collapse horizontal whitespace only
    .trim();
}
```

Rationale:
- **Line 834 →** exclude `\u0009` (TAB), `\u000A` (LF), `\u000D` (CR) from the deletion. Genuinely harmful control bytes (NUL `\u0000`-`\u0008`, VT `\u000B`, FF `\u000C`, and all of `\u000E`-`\u001F`, `\u007F`-`\u009F`) are still removed. LF/CR/TAB are legal JSON whitespace and meaningful in string values.
- **Line 837 →** `[^\S\r\n]+` matches horizontal whitespace only (spaces, tabs, NBSP, etc.), so runs of spaces collapse as before but newline runs are preserved. This stops the second, quieter form of the bug (newlines silently flattened to spaces, observed in the counterfactual run).
- Clean (valid) AI output is unaffected: it contains no raw control bytes and its whitespace outside strings is irrelevant to parsing. Dirty output that used to be "repaired" by deletion is now correctly repaired by `jsonrepair` (Stage 3) escaping the newlines — a strictly more faithful outcome. All downstream pipeline stages already handle arbitrary whitespace (`\s*`, `[\s\S]*?`, `.trim()`).

### Phase 4 — Verification & release checklist

1. Reproduce case D (production raw log): assert the evaluator prompt now contains the verbatim-preservation instruction, and a fresh generation→evaluation run keeps `\n\n` (and `**`) in `text`.
2. Run the Phase-0 harness: cases A/B/C all end with `text` containing real `\n\n`.
3. `bun run typecheck` — the `sanitise`, `parseJsonStringTolerant`, and prompt edits are type-neutral.
4. `bun run lint` (project style: no comments added beyond JSDoc per AGENTS.md).
5. Manual smoke: generate a book page through the normal pipeline with `logPrompts: true` and confirm paragraph breaks survive the evaluation pass, and that Gemini (string mode) still returns corrected output (including legitimate fixes like injury decay).
6. Regression sweep on other `parseAISafely` consumers (candidate generation, canon validation, pen) — expect no behavior change for clean outputs.

---

## 7. Risks & Trade-offs

| Change | Risk | Mitigation |
| --- | --- | --- |
| Prompt hardening (Phase 1) | Models may still ignore the instruction (prompts can't guarantee behavior). | It directly targets the observed failure mode (model *inventing* a prohibition); Phases 2–3 guarantee no corruption when mis-escaping occurs. |
| Tolerant inner parse (Phase 2) | `jsonrepair` may alter otherwise-valid inner JSON. | For valid JSON, `jsonrepair` is a no-op (first `JSON.parse` succeeds). |
| `sanitise()` preserving `\n\r\t` (Phase 3) | Previously-deleted junk whitespace in AI output now routes to `jsonrepair`/`JSON.parse`. | `JSON.parse` accepts legal whitespace; `jsonrepair` escapes any remaining illegal bytes. Clean-output paths are byte-identical. |
| `[^\S\r\n]+` collapse instead of `\s+` | Runs of exotic whitespace (NBSP etc.) still collapse — same as before; only newlines are now preserved. | Desired behavior; verified in the counterfactual test. |
| No code change to the double-encoding design | String mode remains inherently fragile. | Covered by prompt hardening + tolerant parsing; a future structured-mode switch for non-Gemini providers would eliminate double-encoding entirely (see Open Questions). |

---

## 8. Acceptance Criteria

- [ ] A fresh generation→evaluation run preserves `\n\n` paragraph breaks and `**`/`*` markers in the persisted `text` (case D regression test against the production log).
- [ ] The Phase-0 harness demonstrates cases A/B/C all preserve `\n\n` in `text`.
- [ ] `parseAISafely` never deletes LF/CR/TAB bytes from any string value.
- [ ] String-mode evaluation either returns corrected output with intact newlines, or falls back to the original — never corrupted output.
- [ ] No typecheck/lint regressions.

---

## 9. Open Questions

1. **Structured mode for non-Gemini evaluators?** Since string mode exists solely for Gemini's constrained decoder, other providers (Mistral, Cerebras, Groq, OpenRouter) could run structured mode where `output` is a real object — eliminating the double-encoding fragility at the source. This is a larger change (schema size, provider fallback semantics) and is recommended as a follow-up roadmap, not part of this hotfix.
2. **Should generation paths also get newline-persistence tests?** The `sanitise` fix protects every multi-line field across all `parseAISafely` consumers; a broader regression harness covering `bio`/`appearance`/`contextHistory` would lock that in.
3. **Logging the degradation path:** consider a structured log when `runEvaluationPass` falls back to the original, so Case-B behavior is observable in production telemetry.
4. **Other formatting the evaluator normalizes?** The observed response also stripped `*PRRAAANG!*` emphasis markers. Verify whether the UI/app expects `*...*`/`**...**` to be rendered as emphasis, and whether other prose features (dialogue line breaks, etc.) are at similar risk from the model's "style" pass.

---

## 10. Second Finding — Duplicate, Untitled Output-Format Block in the Evaluator System Prompt

> **Severity:** Medium (token waste + ambiguous AI framing)  
> **Affected Flows:** Book creation evaluation (`firstBookOutputFormat`), candidate-generation evaluation (`multiNextPageOutputFormat`)  
> **Not affected:** Multi-turn merged evaluation (`evaluateMergedStoryGeneration`) — it calls `runEvaluationPass` directly without an `outputFormat` option.

### 10.1 Symptom (as observed)

In the evaluator's **system prompt**, between the rules block that ends with `DIALOGUE ACTIONS:` (from `RULES_ACTIONS`) and the first document `BOOK META:`, the same generation output JSON format appears **twice**, back to back, separated only by `---`, with **no section title** and no explanation of what either copy is:

```
...DIALOGUE ACTIONS:
- Use sparingly, for internal scenes or interactions...

---
{
  "title": "Book Title",
  "alternativeTitles": [...],
  ...
}          ← OUTPUT FORMAT copy #1 (no label)

---
{
  "title": "Book Title",
  "alternativeTitles": [...],
  ...
}          ← OUTPUT FORMAT copy #2 (no label)

---
BOOK META:
[book meta document]
```

The final page-generation system prompt's JSON schema (`EXPECTED JSON SCHEMA` in the USER prompt) is *also* present, so the model sees the same shape up to three times across both messages — two unexplained copies in the system prompt plus one labeled copy in the user prompt.

### 10.2 Root Cause — `outputFormat` inheritance + system-prompt reuse double-appends

`options.outputFormat` is set in **one** place (`src/utils/prompt.ts:6036`, inside `executePromptForJSON`), from the `jsonStructure` argument — `firstBookOutputFormat` for book creation (`prompt.ts:4721`) and `multiNextPageOutputFormat` for candidate batches (`prompt.ts:5847`).

`aiPrompt` appends that format to the **system prompt** at `src/utils/ai-chat.ts:1448-1449`:

```typescript
const shouldAppendOutputFormat = options.outputFormat && (supportsStructuredOutput || provider === 'gemini');
const systemPrompt = shouldAppendOutputFormat ? `${originalSystemPrompt}\n\n---\n${options.outputFormat}` : originalSystemPrompt;
```

That resolved `systemPrompt` (now containing one copy of the format) is passed into `runEvaluationPass` (`ai-chat.ts:1563`) and reused verbatim as the evaluator's system prompt (`ai-chat.ts:1684`).

`runEvaluationPass` then builds its inner call options by spreading the **original** options (`ai-chat.ts:1673-1677`):

```typescript
const evaluationOptions: AIPromptOptions = {
  ...options,                       // ← outputFormat survives here
  modelSelection: AI_CHAT_MODELS_EVALUATION,
  useStringEvaluatorOutput: resolveUseStringEvaluator({ ...options, modelSelection: AI_CHAT_MODELS_EVALUATION }),
};
```

...and passes them into the inner `aiPrompt` (`ai-chat.ts:1681-1684`). Inside that inner `aiPrompt`, `shouldAppendOutputFormat` is true again (evaluation schema defines `outputJsonStructure` + `EVALUATION_REQUIRED_FIELDS`, and Gemini is first in the evaluator chain), so line 1449 appends `options.outputFormat` **a second time** — on top of the copy already baked into the reused `systemPrompt`:

```
final evaluator system prompt =
  [generation system prompt + OUTPUT FORMAT copy #1]        ← from outer aiPrompt, reused
  + "\n\n---\n" + OUTPUT FORMAT copy #2                     ← re-appended by the inner aiPrompt
  + "\n\n---\n" + documents (BOOK META, KNOWN CHARACTERS, GENERATED JSON ...)
```

`formatSystemPromptWithDocuments` (`ai-chat.ts:1934-1949`) then appends the documents (first one is `BOOK META`, `services/book.ts:2201`), which is exactly where the second copy ends and `BOOK META:` begins.

Empirically confirmed with a replication of both `ai-chat.ts:1448-1449` executions: the generation system prompt contains **1** copy, the evaluator system prompt contains **2**.

### 10.3 Why it matters

1. **Token waste.** `firstBookOutputFormat` is ≈5 KB and `multiNextPageOutputFormat` ≈15 KB. Duplicating them inflates every evaluation request's prompt and input-token bill, and reduces how many requests fit in per-provider daily budgets (e.g. `aionlabs`'s tiny budget).
2. **Cache pollution / reduced cache reuse.** The system prompt is part of Gemini/Mistral explicit-cache content keys. The duplicate makes the evaluation system prompt *different* from the generation one, undermining the intent of reusing the same resolved system prompt for "identical framing to the generator" (`ai-chat.ts` doc on `runEvaluationPass`'s `systemPrompt` param).
3. **Ambiguous, contradictory framing.** The block is appended with no label (`---\n${options.outputFormat}`, `ai-chat.ts:1449`) — the AI is never told what it is. Two identical copies with no explanation invite weaker evaluators to treat the second as an override, or to echo the *generation* shape instead of the required `{ output, scoreBefore, scoreAfter, actionFlags, integrityFlags }` evaluation object (which is only described in the USER prompt).
4. **Amplifies Finding 1.** More wasted context around the generated JSON makes model escaping/normalization errors (the trigger for newline stripping) more likely.

### 10.4 Implementation Plan

#### Fix A (primary) — stop the double append in `runEvaluationPass`

**File:** `src/utils/ai-chat.ts` (`runEvaluationPass`, options passed to the inner `aiPrompt` at `:1681-1704`)

The evaluator's output shape is already fully specified by `buildEvaluationSchemaDefinition` + the USER prompt's `OUTPUT FORMAT` section; it does not need the generation format re-appended. Explicitly drop it from the inner call:

```typescript
const response = await aiPrompt<AIJsonEvaluation<T>>(evaluatorPrompt, {
  ...evaluationOptions,
  outputFormat: undefined,          // generation format already in the reused systemPrompt — do not append again
  config: {...config, maxOutputToken: config.maxOutputToken + EVALUATION_SCORING_OUTPUT_TOKEN },
  systemPrompt,
  context: evaluationContext,
  fallbackLimit: evaluatorFallbackLimit,
  documents: [...],
  outputAsJson: true,
  outputJsonStructure: buildEvaluationSchemaDefinition(evaluationOptions),
  outputJsonRequired: EVALUATION_REQUIRED_FIELDS satisfies (keyof AIJsonEvaluation<T>)[],
  outputJsonFallbackField: 'output' satisfies keyof AIJsonEvaluation<T>,
}, undefined);
```

Effect: `options.outputFormat` is falsy in the inner `aiPrompt` → `shouldAppendOutputFormat` is `false` → the evaluator system prompt keeps exactly the single copy already present in the reused generation system prompt. Because `outputFormat` is only ever set by `executePromptForJSON` (which always supplies a schema → `supportsStructuredOutput` is always true → the generation copy is always present), this drop cannot lose the format in any real flow.

#### Fix B (labeling) — title the remaining block in `aiPrompt`

**File:** `src/utils/ai-chat.ts:1449`

```typescript
const systemPrompt = shouldAppendOutputFormat
  ? `${originalSystemPrompt}\n\n---\nEXPECTED OUTPUT JSON FORMAT (the exact JSON shape the generated response must match; already enforced by the JSON schema below):\n${options.outputFormat}`
  : originalSystemPrompt;
```

This makes the single surviving copy self-describing for both the generation call and the evaluation call (which reuses that system prompt), addressing the "no section title, no explanation" complaint directly.

#### Fix C (defense-in-depth, optional) — keep `outputFormat` out of `evaluationOptions` entirely

Alternative to Fix A implemented at the source of the inheritance (`ai-chat.ts:1673-1677`), so no other future option accidentally survives the spread:

```typescript
const { outputFormat: _outputFormat, ...evaluationOptions } = options;
```

Either A or C is sufficient; doing both is belt-and-suspenders but not required.

#### Fix D — regression assertions

Extend the Phase-0 harness (`§6`) with two assertions:
- The evaluator system prompt contains `outputFormat` **exactly once**.
- The block is preceded by the `EXPECTED OUTPUT JSON FORMAT` label.

### 10.5 Risks & Trade-offs

| Change | Risk | Mitigation |
| --- | --- | --- |
| `outputFormat: undefined` in the evaluation call | If some future flow sets `outputFormat` without a schema (so the generation copy is *not* present in the reused system prompt), the evaluator would lose the format. | No such flow exists today (`outputFormat` is only set by `executePromptForJSON`, which always has a schema). Document the invariant; the labeling in Fix B makes any future omission visible in logs. |
| Labeling the block | Cosmetic change to prompt text; all callers that enable `outputFormat` see one extra line. | Intended — improves clarity; does not change schema behavior. |
| Removing a duplicated block | None — it was redundant. | Verified by the harness assertion (exactly 1 copy remains). |

### 10.6 Acceptance Criteria

- [ ] Evaluation system prompt contains the generation output format exactly **once** (asserted in the harness).
- [ ] The single copy is preceded by the `EXPECTED OUTPUT JSON FORMAT` label.
- [ ] Book-creation and candidate-generation evaluation still pass the full schema and corrected-output contract (manual smoke with `logPrompts: true` shows one labeled block, then `BOOK META:`).
- [ ] No typecheck/lint regressions.