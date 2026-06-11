/**
 * Rough token estimator — assumes ~4 chars per token (GPT-4 average).
 * Good enough for planning; not for billing.
 */
export function estimateTokens(promptChars: number): number {
  return Math.ceil(promptChars / 4);
}

export interface GenerationTelemetry {
  provider: string;
  model: string;
  context?: string;
  promptChars: number;
  estimatedPromptTokens: number;
  requestStartedAt: number;
  firstTokenAt: number | null;
  completedAt: number | null;
  ttftMs: number | null;
  generationMs: number | null;
}

export function logGenerationTelemetry(t: GenerationTelemetry): void {
  let prefix = '📊 TTFT';
  // ── TTFT quality gate (for future alerting) ──────────────────────────────
  if (t.ttftMs != null) {
    if      (t.ttftMs < 1000) prefix = `✅ TTFT EXCELLENT`;
    else if (t.ttftMs < 2000) prefix = `🟢 TTFT GOOD`;
    else if (t.ttftMs < 3000) prefix = `🟡 TTFT ACCEPTABLE`;
    else                      prefix = `🔴 TTFT POOR`;
  }

  console.log(
    `[${t.provider}] ${prefix} (model: ${t.model}) | prompt ~${t.estimatedPromptTokens.toLocaleString()} tokens (${t.promptChars.toLocaleString()} chars)` +
    (t.ttftMs != null ? ` | TTFT ${t.ttftMs}ms` : '') +
    (t.generationMs != null ? ` | gen ${t.generationMs}ms` : '') +
    (t.context ? ` | ctx: ${t.context}` : '')
  );
}