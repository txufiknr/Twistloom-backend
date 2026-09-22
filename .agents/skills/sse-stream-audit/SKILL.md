---
name: sse-stream-audit
description: >-
  Audit SSE streaming for correct wire protocol, abort signal propagation,
  text extraction correctness, and cache purity.
metadata:
  author: twistloom
  version: "1.0"
---

# SSE Stream Audit Skill

## Trigger
- Any change to SSE streaming code
- New streaming endpoint creation
- Performance investigation of streaming

## Procedure

1. **Wire Protocol Check**
   - Verify correct SSE headers (Content-Type, Cache-Control, Connection, X-Accel-Buffering).
   - Verify correct event types (start, chunk, done, end, error).
   - Check `stream.writeSSE` is used (not manual string encoding).

2. **Abort Signal Check**
   - Verify `c.req.raw.signal` is passed to all AI provider calls.
   - Verify client disconnection terminates upstream workloads.
   - Check no orphaned AI requests continue after disconnect.

3. **Text Extraction Check**
   - Verify `pipeSSEStreamAndExtractText` for text extraction.
   - Verify no raw Uint8Array concatenation + TextDecoder.
   - Verify DB cache stores pure text, not SSE wire envelopes.

4. **Structured JSON Check**
   - Verify `StreamingJsonAnswerExtractor` for JSON responses.
   - Verify no raw JSON tokens piped to client.
   - Check JSON mode response includes both prose stream and typed `done` payload.

5. **Report**
   - List findings with file:line references.
   - Categorize as Critical / Warning / Suggestion.
