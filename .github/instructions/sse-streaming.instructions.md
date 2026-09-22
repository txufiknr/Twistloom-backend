---
applyTo: "src/utils/*stream*.ts, src/utils/*sse*.ts, src/routes/**/stream*.ts"
---

# SSE Streaming Instructions

See `AGENTS.md` for the full streaming architecture. This file adds path-specific context for SSE wire protocol, text extraction, and streaming correctness.

## The 4 Streaming Archetypes

1. **Pure Prose Text Stream** — Unstructured narrative tokens piped via `aiStreamSSE` + `pipeSSEStreamAndExtractText`.
2. **Structured JSON Delta Extraction** — Intercepts LLM JSON responses with `StreamingJsonAnswerExtractor`.
3. **Adaptive Cached Replay** — Replays database-cached text with 3-stage human typing cadence via `streamCachedPrompt`.
4. **Long-Running Task Progress** — Progress events updating client on multi-step generation milestones.

## Standard SSE Wire Protocol

- Headers: `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`
- Events: `start`, `chunk`, `done`, `end`, `error`

## Critical Anti-Patterns

- **Raw Uint8Array Concatenation Trap**: Do NOT concatenate raw chunks and decode with TextDecoder — pollutes cache with wire envelopes. Use `pipeSSEStreamAndExtractText`.
- **Double Protocol Wrapping**: Never feed SSE protocol strings into `streamCachedPrompt()`. DB cache MUST store pure text.
- **Raw JSON Leaks**: Never pipe raw structured JSON tokens to client. Use `StreamingJsonAnswerExtractor`.
- **Missing AbortSignal**: ALWAYS pass `c.req.raw.signal` into `aiStreamSSE` or provider calls.
- **Manual String Encoding**: Use Hono's typed helper: `await stream.writeSSE({ event: "chunk", data: JSON.stringify(...) })`.
