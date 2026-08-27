# Twistloom - Server-Sent Events (SSE) Streaming Architecture & Developer Guide

**Scope:** Master architectural blueprint, protocol specifications, shared utility functions, implementation recipes, and anti-pattern prevention for all real-time Server-Sent Events (SSE) streaming across the Twistloom backend.  
**Target Audience:** Backend engineers implementing or refactoring AI streaming, progress tracking, or cached stream replay endpoints.  
**Companion docs:** [`AI_CHAT_STREAM_ARCHITECTURE.md`](file:///d:/Projects/Twistloom/Twistloom-backend/docs/architecture/AI_CHAT_STREAM_ARCHITECTURE.md) / [`SPARK_SURPRISE_PROMPT_ARCHITECTURE.md`](file:///d:/Projects/Twistloom/Twistloom-web/docs/architecture/SPARK_SURPRISE_PROMPT_ARCHITECTURE.md) / [`READER_COMPANION_ARCHITECTURE.md`](file:///d:/Projects/Twistloom/Twistloom-web/docs/architecture/READER_COMPANION_ARCHITECTURE.md)

---

## Table of Contents

1. [Executive Summary & The 4 Streaming Archetypes](#1-executive-summary--the-4-streaming-archetypes)
2. [High-Level Architectural Flow](#2-high-level-architectural-flow)
3. [SSE Wire Protocol Specification](#3-sse-wire-protocol-specification)
4. [The Canonical Streaming Toolset (Helper Functions)](#4-the-canonical-streaming-toolset-helper-functions)
   - [4.1 `aiStreamSSE` — Multi-Provider Orchestrator](#41-aistreamsse--multi-provider-orchestrator)
   - [4.2 `pipeSSEStreamAndExtractText` — Live Piping & Text Extraction](#42-pipespestreamandextracttext--live-piping--text-extraction)
   - [4.3 `parseSSEStreamContent` — SSE Stream Decoder](#43-parsessestreamcontent--sse-stream-decoder)
   - [4.4 `streamCompanionAnswerSSE` & `StreamingJsonAnswerExtractor` — Live JSON Unwrapping](#44-streamcompanionanswersse--streamingjsonanswerextractor--live-json-unwrapping)
   - [4.5 `streamCachedPrompt` — Adaptive Typing Replay](#45-streamcachedprompt--adaptive-typing-replay)
5. [Critical Anti-Patterns & Past Pitfalls (DO NOT REPEAT)](#5-critical-anti-patterns--past-pitfalls-do-not-repeat)
   - [Pitfall 1: The Raw Uint8Array TextDecoder Concatenation Trap](#pitfall-1-the-raw-uint8array-textdecoder-concatenation-trap)
   - [Pitfall 2: Double SSE Protocol Wrapping on Cache Hits](#pitfall-2-double-sse-protocol-wrapping-on-cache-hits)
   - [Pitfall 3: Raw JSON Syntax Leaking into Chat Bubbles](#pitfall-3-raw-json-syntax-leaking-into-chat-bubbles)
   - [Pitfall 4: Orphaned Provider Streams from Missing AbortSignal](#pitfall-4-orphaned-provider-streams-from-missing-abortsignal)
   - [Pitfall 5: Manual Wire Formatting Instead of `stream.writeSSE`](#pitfall-5-manual-wire-formatting-instead-of-streamwritesse)
6. [Standard Implementation Recipes](#6-standard-implementation-recipes)
   - [Recipe 1: Pure Prose Text Stream (`GET /prompt`)](#recipe-1-pure-prose-text-stream-get-prompt)
   - [Recipe 2: Credit-Gated Structured JSON Stream (`POST .../companion/ask/stream`)](#recipe-2-credit-gated-structured-json-stream-post-companionaskstream)
   - [Recipe 3: Adaptive Cached Stream Replay](#recipe-3-adaptive-cached-stream-replay)
7. [File Reference Map](#7-file-reference-map)

---

## 1. Executive Summary & The 4 Streaming Archetypes

Real-time streaming in Twistloom delivers immediate feedback (Time-To-First-Token < 300ms) rather than forcing users to stare at static loaders. Across the backend, all SSE streaming endpoints belong to one of **4 distinct streaming archetypes**:

```
                                  TWISTLOOM SSE STREAMING TAXONOMY
                                                 │
         ┌────────────────────────┬──────────────┴───────────────┬────────────────────────┐
         │                        │                              │                        │
    Archetype 1              Archetype 2                    Archetype 3              Archetype 4
  Pure Prose Text          Structured JSON                Adaptive Cached           Long-Running
     Streaming           Delta Extraction                Typing Replay            Task Progress
         │                        │                              │                        │
  • /api/books/prompt      • /companion/ask/stream        • prompt_cache replay   • /custom-actions/preview
  • aiStreamSSE            • StreamingJsonAnswerExtractor • streamCachedPrompt    • step_start / complete
  • event: chunk           • event: chunk (prose)         • 3-stage velocity      • poll / trigger
                           • event: done (JSON)
```

| Archetype | Typical Endpoints | Input Prompt | Stream Output | Core Engine |
|---|---|---|---|---|
| **1. Pure Prose Text** | `GET /api/books/prompt` | Unstructured creative prompt | Plain text narrative tokens | `aiStreamSSE` + `pipeSSEStreamAndExtractText` |
| **2. Structured JSON Extraction** | `POST /api/books/:id/:pageId/companion/ask/stream` | Multi-turn Q&A + JSON schema | Prose tokens live on `chunk`, full JSON on `done` | `streamCompanionAnswerSSE` (`StreamingJsonAnswerExtractor`) |
| **3. Adaptive Cached Replay** | Cached `GET /api/books/prompt` | None (reads DB `prompt_cache`) | Simulated human typing tokens | `streamCachedPrompt` |
| **4. Long-Running Task Progress** | `POST /api/books/stream`, `/candidates` | DB / Generation IDs | Step-by-step progress events | Hono `streamSSE` + progress polling |

---

## 2. High-Level Architectural Flow

### A. Pure Prose vs. Structured JSON Streaming Comparison

```mermaid
sequenceDiagram
    autonumber
    participant Client as Frontend (useSurprisePrompt / useCompanionAsk)
    participant Route as Hono Route (routes/books.ts)
    participant StreamEngine as aiStreamSSE / companion-stream.ts
    participant LLM as Provider Waterfall (Groq / Gemini / Cerebras)

    rect rgb(240, 248, 255)
    note over Client, LLM: ARCHETYPE 1: PURE PROSE STREAMING (e.g. GET /prompt)
    Route->>StreamEngine: aiStreamSSE(userPrompt)
    loop Token Generation
        LLM-->>StreamEngine: Token delta
        StreamEngine-->>Route: Uint8Array: event: chunk\ndata: {"type":"chunk","content":"..."}\n\n
        Route-->>Client: stream.write(chunk) (Direct pass-through)
    end
    StreamEngine-->>Route: event: end\ndata: {"type":"end",...}\n\n
    Route-->>Client: stream.write(chunk)
    end

    rect rgb(255, 245, 238)
    note over Client, LLM: ARCHETYPE 2: STRUCTURED JSON EXTRACTION (e.g. POST /companion/ask/stream)
    Route->>StreamEngine: streamCompanionAnswerSSE({ userPrompt, onChunk })
    loop Structured JSON Streaming
        LLM-->>StreamEngine: JSON delta tokens: '{"answer": "He went to...'
        StreamEngine->>StreamEngine: StreamingJsonAnswerExtractor decodes prose delta
        StreamEngine-->>Route: onChunk("He went to...")
        Route-->>Client: stream.writeSSE({ event: "chunk", data: {"content": "He went to..."} })
    end
    StreamEngine-->>Route: Parsed { answer, sources, suggestedFollowUps }
    Route-->>Client: stream.writeSSE({ event: "done", data: { sessionId, answer, sources, ... } })
    end
```

---

## 3. SSE Wire Protocol Specification

Every SSE stream from Twistloom conforms to the W3C Server-Sent Events standard over HTTP/1.1 or HTTP/2.

### 3.1 Standard Response Headers
```http
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

### 3.2 Event Types & Payloads

#### 1. `event: start`
Emitted at the onset of AI provider connection:
```text
event: start
data: {"type":"start","provider":"gemini","model":"gemini-2.5-flash"}

```

#### 2. `event: chunk`
Emitted for every generated prose text chunk:
```text
event: chunk
data: {"type":"chunk","content":"In the shadowy corridors of the manor,","done":false}

```

#### 3. `event: done` (Structured Completion)
Emitted by structured extraction streams (Companion Q&A) carrying full metadata:
```text
event: done
data: {"sessionId":"01918a3b-...","answer":"In the shadowy corridors...","sources":["Page 4: Event"],"suggestedFollowUps":["Why did he enter?"],"cached":false}

```

#### 4. `event: end` (Provider Stream End)
Emitted by raw text streams when generation finishes:
```text
event: end
data: {"type":"end","provider":"gemini","model":"gemini-2.5-flash"}

```

#### 5. `event: error`
Emitted upon unrecoverable runtime or provider errors:
```text
event: error
data: {"message":"Connection to model provider timed out."}

```

---

## 4. The Canonical Streaming Toolset (Helper Functions)

All SSE streaming must use these established, tested utilities located in [`src/utils/`](file:///d:/Projects/Twistloom/Twistloom-backend/src/utils/):

### 4.1 `aiStreamSSE` — Multi-Provider Orchestrator
**Location:** [`Twistloom-backend/src/utils/ai-chat-stream.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/utils/ai-chat-stream.ts)

Orchestrates automatic fallback across 7 AI providers (Cerebras $\to$ Groq $\to$ Gemini $\to$ Mistral $\to$ Cohere $\to$ GitHub $\to$ NVIDIA) and yields a `ReadableStream<Uint8Array>` of pre-formatted SSE byte chunks.

```typescript
const { stream, provider } = await aiStreamSSE(
  userPrompt,
  {
    modelSelection: AI_CHAT_MODELS_THEME,
    systemPrompt: "You are a thriller author...",
  },
  c.req.raw.signal // Always pass the request AbortSignal!
);
```

> [!IMPORTANT]
> **Stream Output Format**: `aiStreamSSE` yields raw binary bytes representing **SSE wire protocol lines**. It does NOT yield raw plain text strings.

---

### 4.2 `pipeSSEStreamAndExtractText` — Live Piping & Text Extraction
**Location:** [`Twistloom-backend/src/utils/ai-chat-stream.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/utils/ai-chat-stream.ts)

Pipes binary SSE chunks from `aiStreamSSE` to the open client HTTP response in real time while simultaneously extracting, decoding, and accumulating the clean prose text from `data.content`.

```typescript
// Twistloom-backend/src/routes/books.ts (GET /prompt)
promptContent = await pipeSSEStreamAndExtractText(
  aiStream, 
  (chunk) => stream.write(chunk)
);

// promptContent is guaranteed to be clean plain text, ready for database caching!
await savePromptToCache({ content: promptContent, userId, language });
```

---

### 4.3 `parseSSEStreamContent` — SSE Stream Decoder
**Location:** [`Twistloom-backend/src/utils/ai-chat-stream.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/utils/ai-chat-stream.ts)

Consumes an SSE stream and decodes all `data.content` fields into a single concatenated text string when live client piping is not required.

```typescript
const fullText = await parseSSEStreamContent(stream);
```

---

### 4.4 `streamCompanionAnswerSSE` & `StreamingJsonAnswerExtractor` — Live JSON Unwrapping
**Location:** [`Twistloom-backend/src/utils/companion-stream.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/utils/companion-stream.ts)

When models are instructed to output structured JSON (`outputJsonStructure`), the model streams raw JSON syntax (e.g. `{"answer": "He escaped...`). The `StreamingJsonAnswerExtractor` state machine intercepts the JSON tokens in flight, cleanly unwraps and decodes the `"answer"` string, and emits clean prose tokens to `onChunk(delta)` without ever leaking `{`, `"`, or JSON syntax to the reader.

```typescript
const { result, aiUsed } = await streamCompanionAnswerSSE({
  userPrompt,
  signal: c.req.raw.signal,
  onChunk: async (cleanChunk) => {
    // Sends clean prose words to chat bubble live
    await stream.writeSSE({
      event: "chunk",
      data: JSON.stringify({ content: cleanChunk }),
    });
  },
});

// result is fully typed: { answer: string, sources: string[], suggestedFollowUps: string[] }
```

---

### 4.5 `streamCachedPrompt` — Adaptive Typing Replay
**Location:** [`Twistloom-backend/src/utils/prompt-stream.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/utils/prompt-stream.ts)

Replays cached prompts with an organic, 3-stage human typing velocity formula:
1. **First 10% (Thinking / Hesitation)**: Chunk size: 5 chars, Delay: 40ms
2. **Middle 70% (Flow State)**: Chunk size: 15 chars, Delay: 20ms
3. **Final 20% (Finishing Touches)**: Chunk size: 8 chars, Delay: 30ms

```typescript
const cacheStream = await streamCachedPrompt(cachedPromptContent);
for await (const chunk of cacheStream) {
  await stream.write(chunk);
}
```

---

## 5. Critical Anti-Patterns & Past Pitfalls (DO NOT REPEAT)

```
                                  COMMON STREAMING PITFALLS MATRIX
┌───────────────────────────────────────────────┬───────────────────────────────────────────────┐
│ ❌ ANTI-PATTERN                                │ ✅ CORRECT IMPLEMENTATION                     │
├───────────────────────────────────────────────┼───────────────────────────────────────────────┤
│ Concatenating raw Uint8Array and TextDecoding │ Use pipeSSEStreamAndExtractText to extract    │
│ the buffer for DB caching (captures SSE lines)│ pure data.content text in real-time.          │
├───────────────────────────────────────────────┼───────────────────────────────────────────────┤
│ Double-wrapping cached prompts with SSE lines │ Ensure DB cache stores plain prose; replay via│
│ because DB contained raw wire envelopes.      │ streamCachedPrompt cleanly.                   │
├───────────────────────────────────────────────┼───────────────────────────────────────────────┤
│ Streaming raw structured JSON tokens directly │ Use StreamingJsonAnswerExtractor to unwrap    │
│ to user chat bubbles (shows raw JSON brackets)│ the "answer" property in flight.              │
├───────────────────────────────────────────────┼───────────────────────────────────────────────┤
│ Forgetting to pass c.req.raw.signal to AI     │ Always propagate signal so client aborts stop │
│ streaming calls (orphans expensive AI compute)│ upstream AI provider streams immediately.     │
├───────────────────────────────────────────────┼───────────────────────────────────────────────┤
│ Manual stream.write(encoder.encode("event.."))│ Use Hono's typed helper:                      │
│ for errors, risking malformed line breaks.    │ await stream.writeSSE({ event, data })        │
└───────────────────────────────────────────────┴───────────────────────────────────────────────┘
```

### Pitfall 1: The Raw Uint8Array TextDecoder Concatenation Trap
- **The Bug**: `aiStreamSSE` yields `Uint8Array` bytes containing `event: chunk\ndata: {"type":"chunk","content":"..."}\n\n`. If you concatenate these chunks into a single `Uint8Array` and decode with `TextDecoder`, you store the **entire raw wire protocol text** in your database cache.
- **The Fix**: Use [`pipeSSEStreamAndExtractText`](file:///d:/Projects/Twistloom/Twistloom-backend/src/utils/ai-chat-stream.ts) to parse JSON `data.content` while streaming.

### Pitfall 2: Double SSE Protocol Wrapping on Cache Hits
- **The Bug**: When a prompt cached with raw SSE envelopes is passed to `streamCachedPrompt(content)`, `streamCachedPrompt` wraps each slice inside another `event: chunk\ndata: ...`, corrupting the client's output with nested metadata strings.
- **The Fix**: Ensure the cache layer strictly stores pure strings without protocol tags.

### Pitfall 3: Raw JSON Syntax Leaking into Chat Bubbles
- **The Bug**: Piping JSON-structured AI models (`outputJsonStructure`) directly to the client causes the user to see `{"answer": "` typed on their screen before the text appears.
- **The Fix**: Use [`streamCompanionAnswerSSE`](file:///d:/Projects/Twistloom/Twistloom-backend/src/utils/companion-stream.ts) to extract prose characters live via state-machine parsing.

### Pitfall 4: Orphaned Provider Streams from Missing AbortSignal
- **The Bug**: Omitting `signal: c.req.raw.signal` leaves the upstream LLM connection streaming tokens indefinitely on the provider side even after the user cancels or closes the browser tab.
- **The Fix**: Always pass `signal: c.req.raw.signal` into any streaming call.

### Pitfall 5: Manual Wire Formatting Instead of `stream.writeSSE`
- **The Bug**: Hand-crafting string templates (`stream.write(new TextEncoder().encode(...))`) easily leads to missing `\n\n` delimiters or improper JSON escaping on special characters.
- **The Fix**: Use `await stream.writeSSE({ event, data })` from Hono's `streamSSE`.

---

## 6. Standard Implementation Recipes

### Recipe 1: Pure Prose Text Stream (`GET /prompt`)

```typescript
// Standard Pure Prose Streaming Endpoint
router.get("/prompt", optionalAuth, async (c) => {
  return streamSSE(c, async (stream) => {
    try {
      const { stream: aiStream, provider } = await generateBookCreationPromptStream({
        signal: c.req.raw.signal,
        language: c.req.query("language") || "en",
      });

      // 1. Pipe tokens live to browser while extracting clean text
      const cleanText = await pipeSSEStreamAndExtractText(aiStream, (chunk) => stream.write(chunk));

      // 2. Persist pristine text to cache
      if (cleanText) {
        await savePromptToCache({ content: cleanText, userId: c.get("userId") });
      }
    } catch (error) {
      const message = getErrorMessage(error, "Failed to stream prompt");
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message }),
      });
    }
  });
});
```

---

### Recipe 2: Credit-Gated Structured JSON Stream (`POST .../companion/ask/stream`)

```typescript
// Standard Credit-Gated Structured Q&A Stream
router.post("/:identifier/:pageId/companion/ask/stream", requireAuth, async (c) => {
  const userId = c.get("userId")!;
  const { pageId } = c.req.param();
  const { question } = await c.req.json();

  return streamSSE(c, async (stream) => {
    try {
      // Execute atomically within credit gate
      const { result } = await executeWithCredits(
        userId,
        "COMPANION_ASK",
        async () => {
          const { result: companionResult } = await streamCompanionAnswerSSE({
            userPrompt: buildPrompt(question),
            signal: c.req.raw.signal,
            onChunk: async (proseChunk) => {
              // Stream prose tokens live without raw JSON brackets
              await stream.writeSSE({
                event: "chunk",
                data: JSON.stringify({ content: proseChunk }),
              });
            },
          });
          return companionResult;
        },
        { context: "companion_ask", metadata: { pageId } }
      );

      const { answer, sources, suggestedFollowUps } = result;

      // Persist turn and invalidate suggestions cache
      await dbWrite.insert(companionAnswers).values({ ... });
      await invalidateSuggestionsCache(bookId, pageId);

      // Emit complete structured payload
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({ answer, sources, suggestedFollowUps, cached: false }),
      });
    } catch (streamErr) {
      const message = getErrorMessage(streamErr);
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message }),
      });
    }
  });
});
```

---

### Recipe 3: Adaptive Cached Stream Replay

```typescript
// Replaying Cached Content with Human Typing Cadence
const cached = await getCachedContent();
if (cached) {
  const cacheStream = await streamCachedPrompt(cached.content);
  for await (const chunk of cacheStream) {
    await stream.write(chunk);
  }
  return;
}
```

---

## 7. File Reference Map

| Component / Layer | File Path | Primary Responsibility |
|---|---|---|
| **Multi-Provider SSE Engine** | [`Twistloom-backend/src/utils/ai-chat-stream.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/utils/ai-chat-stream.ts) | Core `aiStreamSSE`, `pipeSSEStreamAndExtractText`, and `parseSSEStreamContent` |
| **Structured JSON SSE Stream** | [`Twistloom-backend/src/utils/companion-stream.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/utils/companion-stream.ts) | `streamCompanionAnswerSSE` & `StreamingJsonAnswerExtractor` |
| **Cached Stream Replay** | [`Twistloom-backend/src/utils/prompt-stream.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/utils/prompt-stream.ts) | `streamCachedPrompt` with 3-stage adaptive typing velocity |
| **SSE Route Implementations** | [`Twistloom-backend/src/routes/books.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/routes/books.ts) | Spark prompt streaming & Companion Ask streaming route handlers |
| **Credit Transaction Gate** | [`Twistloom-backend/src/services/credits.ts`](file:///d:/Projects/Twistloom/Twistloom-backend/src/services/credits.ts) | `executeWithCredits` transactional deduction & rollback |
| **Frontend SSE Stream Engine** | [`Twistloom-web/src/lib/utils/sse.ts`](file:///d:/Projects/Twistloom/Twistloom-web/src/lib/utils/sse.ts) | Client-side `fetchSSEStream` & `fetchSSEContent` stream parsers |
