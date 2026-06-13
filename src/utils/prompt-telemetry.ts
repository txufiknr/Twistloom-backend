import type { GenerationTelemetry } from "../types/prompt.js";

/**
 * Rough token estimator — assumes ~4 chars per token (GPT-4 average).
 * Good enough for planning; not for billing.
 */
export function estimateTokens(promptChars: number): number {
  return Math.ceil(promptChars / 4);
}

export function logGenerationTelemetry(t: GenerationTelemetry): void {
  console.log(
    `[telemetry] 📊 ${t.provider}/${t.model} | prompt ~${t.estimatedPromptTokens.toLocaleString()} tokens (${t.promptChars.toLocaleString()} chars)` +
    (t.ttftMs != null ? ` | TTFT ${t.ttftMs}ms` : '') +
    (t.generationMs != null ? ` | gen ${t.generationMs}ms` : '') +
    (t.cacheHitRate != null ? ` | cache ${Math.round(t.cacheHitRate * 100)}% (${t.cachedTokens ?? 0} tokens)` : '') +
    (t.context ? ` | ctx: ${t.context}` : '')
  );

  if (t.ttftMs != null) {
    if      (t.ttftMs < 1000) console.log(`[telemetry] ✅ TTFT EXCELLENT`);
    else if (t.ttftMs < 2000) console.log(`[telemetry] 🟢 TTFT GOOD`);
    else if (t.ttftMs < 3000) console.log(`[telemetry] 🟡 TTFT ACCEPTABLE`);
    else                      console.log(`[telemetry] 🔴 TTFT POOR`);
  }
  
  // ── Cache hit rate quality gate ────────────────────────────────────────
  if (t.cacheHitRate != null) {
    if      (t.cacheHitRate > 0.5) console.log(`[telemetry] 💚 Cache hit EXCELLENT (>${Math.round(t.cacheHitRate*100)}%)`);
    else if (t.cacheHitRate > 0.2) console.log(`[telemetry] 🟡 Cache hit PARTIAL`);
    else if (t.cacheHitRate > 0)   console.log(`[telemetry] 🟠 Cache hit LOW`);
    else                           console.log(`[telemetry] ⚪ Cache MISS`);
  }
}