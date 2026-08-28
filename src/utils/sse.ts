/**
 * Server-Sent Events (SSE) utilities for streaming AI responses
 * 
 * This module provides utilities for implementing SSE in a serverless environment,
 * allowing real-time streaming of AI-generated content to clients. It includes:
 * 
 * - SSE event formatting according to the W3C SSE specification
 * - Helper functions for creating common SSE event types (chunks, errors, start/end)
 * - Stream transformation utilities for converting text streams to SSE-formatted streams
 * - Backpressure handling and cancellation support via AbortSignal
 * - Optimized headers for serverless and proxy environments
 * - Hono-native SSE helpers via `hono/streaming` (streamSSE / SSEStreamingApi)
 * 
 * @module sse
 * @example
 * ```typescript
 * import { transformToSSEStream, SSE_HEADERS } from './utils/sse.js';
 * 
 * const textStream = getAIResponseStream();
 * const sseStream = transformToSSEStream(textStream);
 * 
 * return new Response(sseStream, { headers: SSE_HEADERS });
 * ```
 */

import type { SSEStreamingApi } from 'hono/streaming';
import type { BookCreationProgressEvent } from '../types/sse.js';
import { getErrorMessage } from './error.js';

/**
 * SSE event interface representing a single Server-Sent Event
 * 
 * This interface follows the W3C SSE specification for event fields.
 * All fields are optional except for `data` which is required.
 * 
 * @example
 * ```typescript
 * const event: SSEEvent = {
 *   id: 'event-123',
 *   event: 'message',
 *   data: 'Hello world',
 * };
 * ```
 */
export interface SSEEvent {
  /** Optional event ID for reconnection */
  id?: string;
  /** Optional event type for custom event handling */
  event?: string;
  /** Optional retry delay in milliseconds for reconnection */
  retry?: number;
  /** Event data content (required) */
  data: string;
}

/**
 * Handle backpressure by yielding to the event loop when the stream buffer is full or overfull
 * 
 * This function checks if the stream's internal buffer is full or overfull (desiredSize <= 0) and
 * yields to the event loop to allow the consumer to drain the buffer before continuing.
 * 
 * Rationale: Using setTimeout(resolve, 0) yields to the event loop, allowing the consumer
 * to drain the buffer before continuing. This is a simple but effective approach for
 * serverless environments where:
 * - Requests are short-lived (typically seconds)
 * - Memory constraints are managed by the platform
 * - Complex backpressure strategies add unnecessary complexity
 * - The event loop yield is sufficient for most use cases
 * 
 * Trade-off: This doesn't guarantee the buffer is fully drained, but prevents
 * uncontrolled memory growth while maintaining code simplicity.
 * 
 * @param controller - The ReadableStream controller to check for backpressure
 * 
 * @example
 * ```typescript
 * const controller = new ReadableStream({}).getReader();
 * await handleBackpressure(controller);
 * ```
 */
export async function handleBackpressure(controller: ReadableStreamDefaultController<any>): Promise<void> {
  if (controller.desiredSize !== null && controller.desiredSize <= 0) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/**
 * Format an SSE event according to the SSE specification
 * 
 * Converts an SSEEvent object into a properly formatted SSE string.
 * Handles multi-line data by splitting it into multiple `data:` lines per the spec.
 * The resulting string ends with two newlines to separate events.
 * 
 * @param event - The SSE event to format
 * @returns Formatted SSE event string with proper line endings
 * 
 * @example
 * ```typescript
 * // Basic event
 * const event = formatSSEEvent({ data: 'Hello', event: 'message' });
 * // Returns: "event: message\ndata: Hello\n\n"
 * 
 * // Multi-line data
 * const multiline = formatSSEEvent({ data: 'Line 1\nLine 2' });
 * // Returns: "data: Line 1\ndata: Line 2\n\n"
 * 
 * // Full event with all fields
 * const full = formatSSEEvent({
 *   id: '123',
 *   event: 'update',
 *   retry: 5000,
 *   data: 'Content'
 * });
 * ```
 */
export function formatSSEEvent(event: SSEEvent): string {
  const lines: string[] = [];
  
  if (event.id) lines.push(`id: ${event.id}`);
  if (event.event) lines.push(`event: ${event.event}`);
  if (event.retry) lines.push(`retry: ${event.retry}`);
  
  // Normalize line endings to \n, then split multi-line data into multiple data: lines per SSE spec
  const normalizedData = event.data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const dataLines = normalizedData.split('\n');
  for (const line of dataLines) {
    lines.push(`data: ${line}`);
  }
  
  return lines.join('\n') + '\n\n';
}

/**
 * Create an SSE event for a text chunk
 * 
 * Wraps a text chunk in a structured JSON payload with type information.
 * This is the standard format for streaming AI-generated content chunks.
 * 
 * @param chunk - The text chunk to send to the client
 * @param isComplete - Whether this is the final chunk (default: false)
 * @returns Formatted SSE event string with JSON payload
 * 
 * @example
 * ```typescript
 * // Streaming text chunks
 * createTextChunkEvent('Hello ', false);  // { type: 'chunk', content: 'Hello ', done: false }
 * createTextChunkEvent('world!', true);   // { type: 'chunk', content: 'world!', done: true }
 * ```
 */
export function createTextChunkEvent(chunk: string, isComplete = false): string {
  return formatSSEEvent({
    data: JSON.stringify({
      type: 'chunk',
      content: chunk,
      done: isComplete
    })
  });
}

/**
 * Create an SSE event for an error
 * 
 * Formats an error message as an SSE event with the `error` event type.
 * Clients can listen for the `error` event type to handle failures gracefully.
 * 
 * @param error - The error message to send to the client
 * @returns Formatted SSE event string with error type
 * 
 * @example
 * ```typescript
 * // Send error to client
 * const errorEvent = createErrorEvent('API rate limit exceeded');
 * // Client receives: event: error\ndata: {"type":"error","message":"API rate limit exceeded"}\n\n"
 * ```
 */
export function createErrorEvent(error: string): string {
  return formatSSEEvent({
    event: 'error',
    data: JSON.stringify({
      type: 'error',
      message: error
    })
  });
}

/**
 * Create a **non-terminal** SSE error event emitted when a provider/model fails
 * and the orchestrator falls back to the next candidate. Clients MUST treat this
 * as a *recoverable* signal: discard any partial text streamed so far and keep
 * reading — the next provider re-streams the full output from scratch.
 *
 * This is deliberately distinct from {@link createErrorEvent} (`event: error`),
 * which is reserved for terminal failures where no further output will follow.
 * Separating the two prevents clients from aborting the stream mid-fallback
 * (the exact anti-pattern flagged in AGENTS.md, where a naive `event: error`
 * handler would cancel on every provider retry and surface a false failure).
 *
 * @param message - Human-readable description of the failed attempt
 * @returns Formatted SSE event string with `provider_error` type
 */
export function createProviderErrorEvent(message: string): string {
  return formatSSEEvent({
    event: 'provider_error',
    data: JSON.stringify({
      type: 'provider_error',
      message,
    }),
  });
}

/**
 * Create an SSE event for the start of a stream
 * 
 * Signals to the client that the stream is starting and provides metadata
 * about the AI provider and model being used. This allows clients to
 * display context information to users.
 * 
 * @param provider - The AI provider being used (e.g., 'openai', 'anthropic')
 * @param model - The model being used (e.g., 'gpt-4', 'claude-3-opus')
 * @returns Formatted SSE event string with start type
 * 
 * @example
 * ```typescript
 * const start = createStartEvent('openai', 'gpt-4');
 * // Client receives: event: start\ndata: {"type":"start","provider":"openai","model":"gpt-4"}\n\n"
 * ```
 */
export function createStartEvent(provider: string, model: string): string {
  return formatSSEEvent({
    event: 'start',
    data: JSON.stringify({
      type: 'start',
      provider,
      model
    })
  });
}

/**
 * Create an SSE event for the end of a stream
 * 
 * Signals to the client that the stream has completed and provides
 * information about why it ended. Common finish reasons include 'stop',
 * 'length', 'content_filter', etc.
 * 
 * @param provider - The AI provider that was used
 * @param model - The model that was used
 * @param finishReason - The reason the stream ended (e.g., 'stop', 'length', 'content_filter')
 * @returns Formatted SSE event string with end type
 * 
 * @example
 * ```typescript
 * const end = createEndEvent('openai', 'gpt-4', 'stop');
 * // Client receives: event: end\ndata: {"type":"end","provider":"openai","model":"gpt-4","finishReason":"stop"}\n\n"
 * ```
 */
export function createEndEvent(provider: string, model: string, finishReason?: string): string {
  return formatSSEEvent({
    event: 'end',
    data: JSON.stringify({
      type: 'end',
      provider,
      model,
      finishReason
    })
  });
}

/**
 * SSE response headers for serverless environments
 * 
 * These headers are optimized for SSE streaming in serverless environments
 * and work well with various proxies and load balancers.
 * 
 * @constant
 * @example
 * ```typescript
 * return new Response(stream, { headers: SSE_HEADERS });
 * ```
 */
export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no', // Disable nginx buffering
  'X-Content-Type-Options': 'nosniff', // Security: prevent MIME type sniffing
  'Content-Encoding': 'identity', // Prevent compression issues in proxies
} as const;

/**
 * Transform a ReadableStream of text chunks into SSE-formatted stream
 * 
 * Converts a stream of plain text chunks into an SSE-formatted stream
 * with proper event formatting. Handles backpressure to prevent memory
 * issues and supports cancellation via AbortSignal.
 * 
 * The function automatically sends a final 'done' event when the stream
 * completes, and sends error events if any errors occur during processing.
 * 
 * @param chunkStream - The stream of text chunks to transform
 * @param signal - Optional AbortSignal for cancellation (allows client to abort the stream)
 * @returns SSE-formatted stream of Uint8Array ready for HTTP response
 * 
 * @example
 * ```typescript
 * const textStream = getAIResponseStream();
 * const abortController = new AbortController();
 * 
 * const sseStream = transformToSSEStream(textStream, abortController.signal);
 * 
 * // Later, to cancel:
 * abortController.abort();
 * ```
 */
export function transformToSSEStream(
  chunkStream: ReadableStream<string>,
  signal?: AbortSignal
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  
  return new ReadableStream({
    async start(controller) {
      let abortHandler: (() => void) | null = null;
      
      // Handle abort signal
      if (signal) {
        abortHandler = () => {
          controller.close();
        };
        signal.addEventListener('abort', abortHandler);
      }
      
      try {
        for await (const chunk of chunkStream) {
          // Check if aborted
          if (signal?.aborted) {
            controller.close();
            return;
          }
          
          // Handle backpressure
          await handleBackpressure(controller);
          
          const sseEvent = createTextChunkEvent(chunk);
          controller.enqueue(encoder.encode(sseEvent));
        }
        
        // Send final event
        const endEvent = formatSSEEvent({
          data: JSON.stringify({ type: 'done' })
        });
        controller.enqueue(encoder.encode(endEvent));
        
        controller.close();
      } catch (error) {
        const errorEvent = createErrorEvent(getErrorMessage(error));
        controller.enqueue(encoder.encode(errorEvent));
        controller.close();
      } finally {
        // Clean up event listener to prevent memory leak
        if (abortHandler && signal) {
          signal.removeEventListener('abort', abortHandler);
        }
      }
    }
  });
}

/**
 * Create a readable stream from an async generator
 * 
 * Wraps an async generator in a ReadableStream with proper backpressure
 * handling and cancellation support. This is useful for converting
 * generator-based APIs to standard Web Streams.
 * 
 * The stream respects backpressure by checking desiredSize before
 * enqueuing chunks, and can be cancelled via AbortSignal.
 * 
 * @param generator - The async generator yielding strings
 * @param signal - Optional AbortSignal for cancellation
 * @returns ReadableStream of strings
 * 
 * @example
 * ```typescript
 * async function* textGenerator() {
 *   yield 'Hello';
 *   yield ' ';
 *   yield 'world';
 * }
 * 
 * const stream = streamFromGenerator(textGenerator());
 * const reader = stream.getReader();
 * 
 * const { value, done } = await reader.read(); // 'Hello'
 * ```
 */
export function streamFromGenerator(
  generator: AsyncGenerator<string>,
  signal?: AbortSignal
): ReadableStream<string> {
  return new ReadableStream({
    async start(controller) {
      let abortHandler: (() => void) | null = null;
      
      // Handle abort signal
      if (signal) {
        abortHandler = () => {
          controller.close();
        };
        signal.addEventListener('abort', abortHandler);
      }
      
      try {
        for await (const chunk of generator) {
          // Check if aborted
          if (signal?.aborted) {
            controller.close();
            return;
          }
          
          // Handle backpressure
          await handleBackpressure(controller);
          
          controller.enqueue(chunk);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        // Clean up event listener to prevent memory leak
        if (abortHandler && signal) {
          signal.removeEventListener('abort', abortHandler);
        }
      }
    }
  });
}

/**
 * Writes a book-creation progress event to a Hono SSE stream
 * 
 * Maps a `BookCreationProgressEvent` to Hono's `SSEStreamingApi.writeSSE`
 * call, using the event `type` as the SSE event name and the remaining
 * fields as the JSON-encoded data payload.
 * 
 * This is the Hono-native replacement for the former Express `sendSSEEvent`.
 * Hono's `streamSSE` sets the SSE headers automatically, so no manual
 * header initialization is required.
 * 
 * @param stream - Hono SSE stream obtained from `streamSSE(c, async (stream) => {...})`
 * @param event - Progress event to send to the client
 * @returns Promise that resolves once the event has been written
 * 
 * @example
 * ```typescript
 * return streamSSE(c, async (stream) => {
 *   await writeSSEEvent(stream, { type: 'theme_validation_start' });
 *   await writeSSEEvent(stream, { type: 'complete', data: result });
 * });
 * ```
 */
export async function writeSSEEvent(
  stream: SSEStreamingApi,
  event: BookCreationProgressEvent
): Promise<void> {
  const { type, ...data } = event;
  await stream.writeSSE({ event: type, data: JSON.stringify(data) });
}

/**
 * Backward-compatible alias for {@link writeSSEEvent}.
 * 
 * Kept so existing callers referencing `sendSSEEvent` continue to compile
 * while the codebase migrates to Hono. Both names accept a Hono
 * `SSEStreamingApi` and a `BookCreationProgressEvent`.
 * 
 * @param stream - Hono SSE stream obtained from `streamSSE`
 * @param event - Progress event to send to the client
 * @returns Promise that resolves once the event has been written
 */
export async function sendSSEEvent(
  stream: SSEStreamingApi,
  event: BookCreationProgressEvent
): Promise<void> {
  return writeSSEEvent(stream, event);
}

/**
 * Detects if an error is a transient network error
 *
 * Network errors should be retried with backoff, while permanent errors
 * should fail fast.
 */
function isNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return message.includes('network') ||
           message.includes('timeout') ||
           message.includes('econnrefused') ||
           message.includes('enotfound') ||
           message.includes('etimedout') ||
           message.includes('fetch failed') ||
           message.includes('connection reset') ||
           message.includes('connection refused');
  }
  return false;
}

/**
 * Configuration for SSE polling behavior
 */
export interface SSEPollingConfig {
  /** Initial interval between polls in milliseconds */
  pollIntervalMs: number;
  /** Maximum number of polling attempts */
  maxAttempts: number;
  /** Interval for sending progress updates (every N polls) */
  progressInterval: number;
  /** Maximum backoff interval in milliseconds (default: 10000) */
  maxBackoffMs?: number;
  /** Whether to use exponential backoff (default: true) */
  exponentialBackoff?: boolean;
}

/**
 * Options for polling for candidate generation completion
 */
export interface PollCandidateGenerationOptions {
  /** Page ID to poll for */
  pageId: string;
  /** User ID for mapping page data */
  userId: string;
  /** Hono SSE stream obtained from `streamSSE(c, async (stream) => {...})` */
  stream: SSEStreamingApi;
  /** Initial message to send before polling starts */
  initialMessage: string;
  /** Function to fetch page from database */
  getPageFromDB: (pageId: string) => Promise<any>;
  /** Function to map page to user story page */
  mapToUserStoryPage: (page: any, userId: string) => Promise<any>;
  /** Function to get action progress events */
  getActionProgressEvents?: (pageId: string) => Promise<any[]>;
  /** Function to clear action progress events */
  clearActionProgressEvents?: (pageId: string) => Promise<void>;
  /** Polling configuration */
  config: SSEPollingConfig;
  /** AbortSignal for client disconnect / cancellation (e.g. `c.req.signal`) */
  signal?: AbortSignal;
}

/**
 * Polls for candidate generation completion via SSE
 * 
 * This function handles the common polling logic for candidate generation,
 * eliminating duplicate code in route handlers. It polls the database at
 * regular intervals to check if generation is complete, sends progress updates,
 * and handles client disconnections gracefully.
 * 
 * @param options - Polling options and configuration
 * @returns Promise that resolves when polling completes or client disconnects
 * 
 * @example
 * ```typescript
 * return streamSSE(c, async (stream) => {
 *   await pollForCandidateGeneration({
 *     pageId,
 *     userId,
 *     stream,
 *     signal: c.req.signal,
 *     initialMessage: 'Candidate generation in progress...',
 *     getPageFromDB,
 *     mapToUserStoryPage,
 *     getActionProgressEvents,
 *     config: {
 *       pollIntervalMs: 2000,
 *       maxAttempts: 150,
 *       progressInterval: 5
 *     }
 *   });
 * });
 * ```
 */
export async function pollForCandidateGeneration(
  options: PollCandidateGenerationOptions
): Promise<void> {
  const {
    pageId,
    userId,
    stream,
    initialMessage,
    getPageFromDB,
    mapToUserStoryPage,
    getActionProgressEvents,
    clearActionProgressEvents,
    config,
    signal
  } = options;

  const { pollIntervalMs: initialPollIntervalMs, maxAttempts, progressInterval, maxBackoffMs = 10000, exponentialBackoff = true } = config;

  let attempts = 0;
  let backoffMs = initialPollIntervalMs;
  const startTime = Date.now();

  // Send initial message
  await stream.writeSSE({
    event: 'progress',
    data: JSON.stringify({ status: 'waiting', message: initialMessage })
  });

  const abort = () => {
    console.log(`[SSE Polling] 🛑 Polling aborted via signal for page ${pageId}`);
    throw new DOMException('Polling aborted', 'AbortError');
  };

  // Listen for client disconnect / cancellation via the provided signal
  if (signal) {
    if (signal.aborted) {
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  }

  try {
    while (attempts < maxAttempts) {
      // Check for abort signal
      if (signal?.aborted) {
        abort();
      }

      await new Promise(resolve => setTimeout(resolve, backoffMs));
      attempts++;

      // Exponential backoff: 2s → 4s → 8s → max configured
      if (exponentialBackoff) {
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      }

      // Refresh page from database with network error handling
      let freshPage;
      try {
        freshPage = await getPageFromDB(pageId);
      } catch (dbError) {
        // Distinguish between network errors and permanent errors
        if (isNetworkError(dbError)) {
          console.warn(`[SSE Polling] ⚠️ Network error, will retry (attempt ${attempts}):`, dbError);
          // Continue to next iteration with backoff
          continue;
        }

        // Permanent error - fail fast
        console.error(`[SSE Polling] ❌ Permanent error, failing:`, dbError);
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: 'Database error during polling' })
        });
        return;
      }

      if (!freshPage) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: 'Page not found during polling' })
        });
        return;
      }

      // Check if generation is complete (timestamp cleared)
      if (!freshPage.isGeneratingStartedAt) {
        console.log(`[SSE Polling] Generation completed for page ${pageId} after ${attempts} polls`);
        try {
          const userPage = await mapToUserStoryPage(freshPage, userId);
          await stream.writeSSE({ event: 'complete', data: JSON.stringify(userPage) });
        } catch {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ error: 'Failed to process page data' })
          });
        } finally {
          // Clear progress events after generation completes
          await clearActionProgressEvents?.(pageId);
        }
        return;
      }

      // Check for action progress events in database or cache
      if (getActionProgressEvents) {
        const progressEvents = await getActionProgressEvents(pageId);
        if (progressEvents && progressEvents.length > 0) {
          for (const event of progressEvents) {
            if (signal?.aborted) {
              return;
            }
            await stream.writeSSE({ event: 'action_progress', data: JSON.stringify(event) });
          }
        }
      }

      // Send progress update periodically
      if (attempts % progressInterval === 0) {
        const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
        await stream.writeSSE({
          event: 'progress',
          data: JSON.stringify({ status: 'waiting', message: `Still generating... (${elapsedSeconds}s elapsed)` })
        });
      }
    }

    // Timeout - fetch freshest state and return it
    console.log(`[SSE Polling] Timeout waiting for generation of page ${pageId}`);
    try {
      const freshAfterTimeout = await getPageFromDB(pageId);
      const userPage = await mapToUserStoryPage(freshAfterTimeout, userId);
      await stream.writeSSE({
        event: 'timeout',
        data: JSON.stringify({ ...userPage, warning: 'Generation timeout, returning current state' })
      });
    } catch {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ error: 'Failed to process page data' })
      });
    }
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
