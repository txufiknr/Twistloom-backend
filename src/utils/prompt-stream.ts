/**
 * @overview Prompt Streaming Utilities
 * 
 * Utilities for simulating AI-like streaming from cached prompt content.
 * Maintains the streaming user experience while serving from cache.
 */

import { PROMPT_CACHE_CONFIG } from "../config/prompt-cache.js";

/**
 * Gets adaptive chunk size based on content position
 * 
 * Smaller chunks at start (simulating AI thinking), larger in middle (flow state),
 * smaller at end (finishing touches).
 * 
 * @param position - Current position in content
 * @param totalLength - Total length of content
 * @returns Chunk size for current position
 * 
 * @example
 * ```typescript
 * const chunkSize = getAdaptiveChunkSize(50, 500);
 * console.log('Chunk size:', chunkSize);
 * ```
 */
export function getAdaptiveChunkSize(position: number, totalLength: number): number {
  // Smaller chunks at start (simulating AI thinking)
  if (position < totalLength * 0.1) return 5;
  // Larger chunks in middle (flow state)
  if (position < totalLength * 0.8) return 15;
  // Smaller chunks at end (finishing touches)
  return 8;
}

/**
 * Gets adaptive delay based on content position
 * 
 * Longer delays at start (thinking), shorter in middle (flow),
 * longer at end (finishing).
 * 
 * @param position - Current position in content
 * @param totalLength - Total length of content
 * @returns Delay in milliseconds
 * 
 * @example
 * ```typescript
 * const delay = getAdaptiveDelay(50, 500);
 * await new Promise(resolve => setTimeout(resolve, delay));
 * ```
 */
export function getAdaptiveDelay(position: number, totalLength: number): number {
  // Longer delays at start (thinking)
  if (position < totalLength * 0.1) return PROMPT_CACHE_CONFIG.streaming.delayMs * 2;
  // Shorter delays in middle (flow)
  if (position < totalLength * 0.8) return PROMPT_CACHE_CONFIG.streaming.delayMs;
  // Longer delays at end (finishing)
  return PROMPT_CACHE_CONFIG.streaming.delayMs * 1.5;
}

/**
 * Simulates SSE streaming from cached prompt content
 * 
 * Chunks the content and streams it with artificial delays to maintain
 * AI-like typing effect.
 * 
 * @param content - Full prompt content to stream
 * @param useAdaptiveChunking - Whether to use adaptive chunking (default: true)
 * @returns ReadableStream that yields SSE-formatted chunks
 * 
 * @example
 * ```typescript
 * const stream = await streamCachedPrompt(promptContent);
 * for await (const chunk of stream) {
 *   res.write(chunk);
 * }
 * ```
 */
export async function streamCachedPrompt(
  content: string,
  useAdaptiveChunking: boolean = true
): Promise<ReadableStream<Uint8Array>> {
  const chunks: { text: string; delay: number }[] = [];
  let position = 0;
  
  while (position < content.length) {
    const chunkSize = useAdaptiveChunking
      ? getAdaptiveChunkSize(position, content.length)
      : PROMPT_CACHE_CONFIG.streaming.chunkSize;
    
    const chunk = content.slice(position, position + chunkSize);
    const delay = useAdaptiveChunking
      ? getAdaptiveDelay(position, content.length)
      : PROMPT_CACHE_CONFIG.streaming.delayMs;
    
    chunks.push({ text: chunk, delay });
    position += chunkSize;
  }
  
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      
      try {
        for (const chunk of chunks) {
          // Simulate AI typing delay
          await new Promise(resolve => setTimeout(resolve, chunk.delay));
          
          const sseEvent = `event: chunk\ndata: ${JSON.stringify({
            type: 'chunk',
            content: chunk.text,
            done: false
          })}\n\n`;
          
          controller.enqueue(encoder.encode(sseEvent));
        }
        
        // Send end event
        const endEvent = `event: end\ndata: ${JSON.stringify({
          type: 'end',
          provider: 'cache',
          model: 'cached-prompt'
        })}\n\n`;
        
        controller.enqueue(encoder.encode(endEvent));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });
  
  return stream;
}

/**
 * Streams cached prompt as plain text (non-SSE)
 * 
 * Useful for non-streaming contexts where you still want
 * the cached content without AI generation.
 * 
 * @param content - Full prompt content to stream
 * @param useAdaptiveChunking - Whether to use adaptive chunking
 * @returns ReadableStream of text chunks
 * 
 * @example
 * ```typescript
 * const stream = await streamCachedPromptAsText(promptContent);
 * for await (const chunk of stream) {
 *   console.log(chunk);
 * }
 * ```
 */
export async function streamCachedPromptAsText(
  content: string,
  useAdaptiveChunking: boolean = true
): Promise<ReadableStream<string>> {
  const chunks: { text: string; delay: number }[] = [];
  let position = 0;
  
  while (position < content.length) {
    const chunkSize = useAdaptiveChunking
      ? getAdaptiveChunkSize(position, content.length)
      : PROMPT_CACHE_CONFIG.streaming.chunkSize;
    
    const chunk = content.slice(position, position + chunkSize);
    const delay = useAdaptiveChunking
      ? getAdaptiveDelay(position, content.length)
      : PROMPT_CACHE_CONFIG.streaming.delayMs;
    
    chunks.push({ text: chunk, delay });
    position += chunkSize;
  }
  
  const stream = new ReadableStream<string>({
    async start(controller) {
      try {
        for (const chunk of chunks) {
          await new Promise(resolve => setTimeout(resolve, chunk.delay));
          controller.enqueue(chunk.text);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });
  
  return stream;
}
