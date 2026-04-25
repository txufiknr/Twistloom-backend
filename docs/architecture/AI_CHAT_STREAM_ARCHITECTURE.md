# AI Chat Stream Architecture

## Overview

The AI chat stream implementation (`src/utils/ai-chat-stream.ts`) provides real-time streaming of AI responses using Server-Sent Events (SSE). This architecture is designed for serverless environments where responses must be streamed as they arrive, rather than accumulated and returned all at once.

The implementation supports 7 AI providers (GitHub, Gemini, Groq, Cohere, Cerebras, Mistral, NVIDIA) with automatic fallback at both the provider and model levels.

## Architecture Approach: Orchestrator-Level Fallback

This implementation uses an **orchestrator-level fallback strategy** where all fallback logic is centralized in the `aiStreamSSE` function rather than distributed across individual provider generators.

### Key Design Principles

1. **Centralized Fallback Logic** - Model and provider fallback are handled at the orchestrator level
2. **Single-Model Generators** - Each provider generator receives a single model to attempt
3. **Centralized Error Handling** - Error events are sent uniformly from a single location
4. **Efficient Rate Limiting** - Applied once per provider, not per model
5. **DRY Principle** - No duplicated fallback logic across 7 different provider generators

## Component Overview

### Core Function: `aiStreamSSE`

The main orchestrator function that:
- Iterates through providers in priority order
- For each provider, iterates through models in priority order
- Applies rate limiting once per provider
- Sends SSE events (start, text chunks, end, error)
- Handles cancellation via AbortSignal
- Implements backpressure handling
- Logs success/failure and increments usage counters

### Provider Generators

Each provider has its own async generator function:
- `githubStreamGenerator` - GitHub Models (OpenAI-compatible)
- `geminiStreamGenerator` - Google Gemini
- `groqStreamGenerator` - Groq
- `cohereStreamGenerator` - Cohere
- `cerebrasStreamGenerator` - Cerebras
- `mistralStreamGenerator` - Mistral AI
- `nvidiaStreamGenerator` - NVIDIA NIM

Each generator:
- Accepts a prompt and options
- Receives a single model to attempt (not the full array)
- Yields text chunks as they arrive
- Supports cancellation via AbortSignal
- Handles provider-specific response formats

## SSE Event Format

The implementation uses Server-Sent Events with the following event types:

### Start Event
```typescript
{
  type: 'start',
  provider: 'github' | 'gemini' | ...,
  model: 'gpt-4o' | 'gemini-2.5-flash' | ...
}
```

### Text Chunk Event
```typescript
{
  type: 'chunk',
  content: string
}
```

### End Event
```typescript
{
  type: 'end',
  provider: string,
  model: string
}
```

### Error Event
```typescript
{
  type: 'error',
  message: string
}
```

Events are formatted using the SSE utility functions from `src/utils/sse.ts`.

## Error Handling Strategy

### Three-Level Error Handling

1. **Provider-Level Errors** (outer try-catch)
   - Caught when provider setup fails entirely
   - Sends error event with provider name
   - Triggers fallback to next provider

2. **Model-Level Errors** (inner try-catch)
   - Caught when a specific model fails
   - Sends error event with model name
   - Triggers fallback to next model in the same provider

3. **Streaming Errors** (stream loop try-catch)
   - Caught during chunk iteration
   - Sends error event with error details
   - Triggers fallback to next model

### Error Event Format

Error events include context about which provider/model failed:
- Provider failures: "SSE Provider failed: [error message]"
- Model failures: "Model [model-name] failed: [error message]"
- Streaming errors: "Model [model-name] streaming error: [error message]"

## Cancellation Support

### AbortSignal Integration

The implementation supports cancellation via `AbortSignal` at multiple levels:

1. **Function Parameter** - `aiStreamSSE` accepts optional `signal` parameter
2. **Signal Propagation** - Signal is passed to all provider generators via options
3. **Provider-Level Check** - Before starting each provider
4. **Model-Level Check** - Before trying each model
5. **Streaming Check** - During chunk iteration in each generator

### NVIDIA Timeout

NVIDIA generator includes a 60-second timeout using `AbortSignal.timeout()`:
```typescript
const timeoutSignal = AbortSignal.timeout(60000);
const combinedSignal = signal ? 
  AbortSignal.any([signal, timeoutSignal]) : 
  timeoutSignal;
```

## Backpressure Handling

### Implementation

Backpressure is handled in the streaming loop using `controller.desiredSize`:

```typescript
if (controller.desiredSize !== null && controller.desiredSize <= 0) {
  await new Promise(resolve => setTimeout(resolve, 0));
}
```

### Purpose

- Prevents memory issues in serverless environments
- Allows the consumer to control the stream pace
- Yields to the event loop when the stream buffer is full

## Rate Limiting

### Implementation

Rate limiting is applied once per provider using the centralized rate limiter:

```typescript
await getRateLimiter(provider).throttle();
```

### Efficiency

- Applied once per provider, not per model
- Uses the existing rate limiter infrastructure from `src/utils/ai-limiters.ts`
- Consistent with non-streaming AI functions

## Model Fallback Mechanism

### Nested Loop Structure

```
for (provider of providers) {
  await getRateLimiter(provider).throttle();
  
  for (model of models[provider]) {
    try {
      // Attempt streaming with this model
      // If successful, break out of both loops
    } catch (error) {
      // Log error, try next model
    }
  }
}
```

### Fallback Behavior

1. **Provider Priority** - Providers tried in order defined in `modelSelection`
2. **Model Priority** - Models tried in order within each provider's array
3. **Success Break** - On success, break out of both loops
4. **Failure Continue** - On failure, continue to next model/provider
5. **All Failed** - If all providers fail, send "All providers failed" error

### Observability

Each model attempt sends:
- Start event with provider and model
- End event on success
- Error event on failure

This gives the client visibility into which model is being tried.

## Benefits of This Approach

### 1. Centralized Fallback Logic

All fallback logic lives in one place (`aiStreamSSE`), making it:
- Easier to maintain and debug
- Consistent across all providers
- Simpler to modify behavior

### 2. Consistent Error Handling

Error events are sent uniformly for all providers from a single location:
- Standardized error message format
- Consistent error event structure
- Predictable client-side error handling

### 3. Simpler Generators

Individual provider generators remain simple:
- No fallback complexity
- Single responsibility: stream from a specific model
- Easier to test and maintain

### 4. Better Observability

Start/end events are sent per model attempt:
- Client knows which provider/model is being tried
- Easier to debug fallback behavior
- Better monitoring and logging

### 5. Rate Limiting Efficiency

Applied once per provider:
- Avoids redundant rate limit checks across models
- More efficient API usage
- Consistent with rate limiter design

### 6. DRY Principle

No duplicated fallback logic across 7 generators:
- Less code to maintain
- Consistent behavior across providers
- Easier to add new providers

### 7. Easier Debugging

Single location for fallback logging/monitoring:
- Add logging in one place
- Monitor fallback behavior centrally
- Easier to trace issues

## Trade-offs

### 1. More Complex Orchestrator

The orchestrator function has nested loops:
- Provider loop (outer)
- Model loop (inner)

This adds complexity to the main function, but:
- Complexity is isolated to one place
- Well-documented and structured
- Trade-off is worth the benefits

### 2. Less Encapsulated Fallback Logic

Fallback logic is not self-contained within each provider generator:
- Generators depend on orchestrator for fallback
- Less modular from a pure OOP perspective

However:
- Fallback is cross-cutting concern
- Centralized control is more important
- Generators remain simple and testable

## Implementation Details

### Provider-Specific Considerations

#### GitHub (OpenAI-compatible)
- Uses standard OpenAI SDK
- Supports JSON schema validation
- Includes response format for structured output

#### Gemini
- Uses Google GenAI SDK
- Requires schema conversion to Gemini format
- Recursive schema conversion for nested structures

#### Groq
- Uses Groq SDK
- OpenAI-compatible API
- Supports JSON schema validation

#### Cohere
- Uses Cohere SDK
- Different API structure (V2)
- Supports document-based RAG

#### Cerebras
- Uses Cerebras SDK
- OpenAI-compatible API
- Special handling for error chunks (non-terminating)

#### Mistral
- Uses Mistral SDK
- Different response structure
- Supports JSON schema validation

#### NVIDIA
- Manual fetch implementation (no SDK)
- Custom SSE parsing with buffer handling
- Includes timeout (60 seconds)
- Proper reader cleanup with releaseLock()

### JSON Schema Validation

#### Gemini Schema Conversion

Gemini requires a specific schema format. The implementation includes a recursive helper function to convert standard JSON schema to Gemini schema:

```typescript
const convertToGeminiSchema = (jsonSchema: any): Schema => {
  if (jsonSchema.type === 'array' && jsonSchema.items) {
    return {
      type: Type.ARRAY,
      items: convertToGeminiSchema(jsonSchema.items),
    };
  } else if (jsonSchema.type === 'object' && jsonSchema.properties) {
    return {
      type: Type.OBJECT,
      properties: Object.entries(jsonSchema.properties).reduce((acc, [k, v]) => {
        acc[k] = convertToGeminiSchema(v);
        return acc;
      }, {} as Record<string, Schema>),
    };
  } else {
    return {
      type: jsonSchema.type as Type,
    };
  }
};
```

This handles nested objects and arrays recursively.

### NVIDIA SSE Parsing

NVIDIA uses manual SSE parsing with proper buffer handling:

```typescript
let buffer = '';

while (true) {
  if (signal?.aborted) return;
  const { done, value } = await reader.read();
  if (done) break;
  
  buffer += decoder.decode(value, { stream: true });
  
  // Split by double newline to get complete SSE events
  const events = buffer.split('\n\n');
  buffer = events.pop() || ''; // Keep incomplete event in buffer
  
  for (const event of events) {
    const lines = event.split('\n').filter(line => line.trim().startsWith('data:'));
    // Process lines...
  }
}
```

This handles:
- Accumulated chunks across read boundaries
- Incomplete events (kept in buffer)
- Proper event boundary detection (double newline)
- Multi-line data fields

## Usage Examples

### Basic Usage

```typescript
import { aiStreamSSE } from './utils/ai-chat-stream.js';
import { AI_CHAT_MODELS_WRITING } from './config/ai-chat.js';

const stream = await aiStreamSSE('Tell me a story', {
  modelSelection: AI_CHAT_MODELS_WRITING,
});

// In an Express route:
res.setHeader('Content-Type', 'text/event-stream');
for await (const chunk of stream) {
  res.write(chunk);
}
```

### With Cancellation

```typescript
const abortController = new AbortController();

const stream = await aiStreamSSE('Tell me a story', {
  modelSelection: AI_CHAT_MODELS_WRITING,
}, abortController.signal);

// Cancel after 5 seconds:
setTimeout(() => abortController.abort(), 5000);
```

### With Custom Model Selection

```typescript
const stream = await aiStreamSSE('Tell me a story', {
  modelSelection: {
    github: ['gpt-4o', 'gpt-4o-mini'],
    gemini: ['gemini-2.5-flash', 'gemini-2.0-flash'],
    groq: ['llama-3.3-70b-versatile'],
  },
});
```

This will:
1. Try GitHub with gpt-4o
2. If fails, try GitHub with gpt-4o-mini
3. If fails, try Gemini with gemini-2.5-flash
4. If fails, try Gemini with gemini-2.0-flash
5. If fails, try Groq with llama-3.3-70b-versatile

## Type Definitions

### AIPromptOptions

```typescript
interface AIPromptOptions {
  modelSelection?: AIChatModelSelection;
  config?: AIChatConfig;
  systemPrompt?: string;
  context?: string;
  documents?: AIDocument[];
  logPrompts?: boolean;
  logEvaluationResult?: boolean;
}
```

### PromptWithFallbackOptions

Extends `AIPromptOptions` with:
```typescript
{
  models?: string[];
  signal?: AbortSignal;
}
```

### AIChatModelSelection

```typescript
type AIChatModelSelection = {
  [provider in AIChatProvider]?: string[];
};
```

## Performance Considerations

### Serverless Optimization

- **Minimal Bundle Size** - Only import what's needed from provider SDKs
- **Fast Initialization** - Generators are created on-demand
- **Efficient Streaming** - Chunks are yielded immediately, not accumulated
- **Backpressure Handling** - Prevents memory issues in constrained environments

### Cold Start Mitigation

- Lazy initialization of provider clients
- Rate limiting applied once per provider
- Minimal setup before streaming starts

### Memory Management

- NVIDIA reader cleanup with `releaseLock()`
- Buffer management for SSE parsing
- Backpressure handling to prevent buffer overflow

## Security Considerations

### API Keys

- API keys are loaded via `requireEnv()` helper
- Keys are not logged or exposed in error messages
- NVIDIA API key is loaded at runtime

### AbortSignal Safety

- Signal checks before each operation
- Combined signal with timeout for NVIDIA
- Proper cleanup on abort

### Error Messages

- Error messages don't expose sensitive information
- API keys are not included in error events
- Stack traces are not sent to clients

## Monitoring and Observability

### Logging

- Provider/model attempts are logged
- Success/failure is logged with context
- Streaming errors are logged with details

### Metrics

- Daily usage counters incremented per provider
- Success/failure tracking via AI logger
- Context tracking for usage analytics

### Error Events

- Each error includes provider/model context
- Error types are distinguishable (setup vs streaming)
- Client can track fallback behavior

## Future Improvements

### Potential Enhancements

1. **Retry Logic** - Add retry for transient errors (network timeouts)
2. **Circuit Breaker** - Temporarily disable failing providers/models
3. **Metrics Export** - Export Prometheus metrics for monitoring
4. **Streaming Metrics** - Track time to first byte, chunk latency
5. **Adaptive Fallback** - Learn from historical success rates
6. **Parallel Attempts** - Try multiple providers in parallel (race)
7. **Cost Optimization** - Prefer cheaper models when appropriate
8. **Quality Scoring** - Score responses and prefer higher-quality providers

### Known Limitations

1. **No Retry** - Transient errors trigger fallback immediately
2. **No Circuit Breaker** - Failing providers are retried on next request
3. **No Parallel Attempts** - Sequential fallback only (slower)
4. **No Cost Awareness** - Doesn't consider model pricing
5. **No Quality Scoring** - Doesn't evaluate response quality

## Related Documentation

- [SSE Utilities](../src/utils/sse.ts) - SSE event formatting and stream utilities
- [AI Chat](../src/utils/ai-chat.ts) - Non-streaming AI chat with fallback
- [AI Limiters](../src/utils/ai-limiters.ts) - Rate limiting implementation
- [AI Types](../src/types/ai-chat.ts) - Type definitions for AI chat
- [AI Config](../src/config/ai-chat.ts) - Default configurations and model selections
