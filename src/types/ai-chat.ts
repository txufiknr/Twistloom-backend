/**
 * AI Provider types for rate limiting and configuration
 * 
 * These providers represent the supported AI services that can be used
 * for chat completions and text generation tasks.
 */
export type AIChatProvider = 'github' | 'gemini' | 'cohere' | 'mistral' | 'groq' | 'cerebras' | 'nvidia';

/**
 * AI response structure returned from chat completion APIs
 * 
 * This interface standardizes the response format across different AI providers
 * to enable consistent handling and processing of generated content.
 */
export interface AIResponse<T> {
  /** Which AI provider generated the response */
  provider: AIChatProvider | 'none';
  /** Specific model used to generate the response (e.g., 'gpt-4o', 'gemini-2.5-flash') */
  model?: string;
  /** The generated text content from the AI */
  output: string;
  /** The parsed content into expected type */
  result?: T;
  /** Token usage statistics for billing and monitoring (varies by provider) */
  usage?: object;
  /** Reason why the generation stopped (e.g., 'stop', 'length', 'content_filter') */
  finishReason?: string;
}

export type AIModelSelection = Partial<Record<AIChatProvider, string[]>>;

/**
 * Configuration options for AI prompt requests
 * 
 * These options control how prompts are processed and which providers
 * are available for fallback scenarios.
 */
export interface AIPromptOptions {
  /** Object of providers and their respective models to include in the fallback chain */
  modelSelection?: AIModelSelection;
  /** Usage context string for logging and rate limiting (e.g., 'story-page') */
  context?: string;
  /** Additional configuration for the AI model */
  config?: AIChatConfig;
  /** Whether to parse the output as JSON */
  outputAsJson?: boolean;
}

/**
 * AI chat configuration parameters
 * 
 * Defines the core parameters for AI model behavior including
 * creativity controls and sampling strategies.
 */
export type AIChatConfig = {
  /** Controls randomness: 0.0 = deterministic, 1.0 = maximum randomness */
  temperature: number;
  /** Nucleus sampling: 0.0 = all tokens, 1.0 = only most likely tokens */
  topP: number;
  /** Top-k sampling: considers top K most likely tokens */
  topK: number;
  /** Maximum number of tokens to generate in the response */
  maxOutputToken: number;
  /** Stop sequences to control output generation */
  stopSequences?: string[];
};

/**
 * Document structure for document-based AI processing
 * 
 * Used when providing context documents to AI models that support
 * retrieval-augmented generation (RAG) or document analysis.
 */
export type AIDocument = { 
  /** Optional document title for context */
  title?: string; 
  /** Main document text content */
  text: string;
};

/**
 * Advanced options for prompt processing with fallback support
 * 
 * Extends basic prompt options with additional parameters for fine-tuned
 * control over AI model behavior and output formatting.
 */
export interface PromptWithFallbackOptions {
  /** Custom system prompt to override default behavior */
  systemPrompt?: string;
  /** Array of model names to use for fallback attempts */
  models?: string[];
  /** Usage context string for logging and rate limiting */
  context?: string;
  /** Additional provider-specific options */
  config?: AIChatConfig;
  /** Documents to provide as context to the AI model */
  documents?: AIDocument[];
  // [key: string]: any;
}

// ============================================================================
// PROVIDER-SPECIFIC INTERFACES
// ============================================================================

/**
 * NVIDIA NIM chat completion response structure
 * 
 * Matches the OpenAI-compatible format used by NVIDIA's inference API
 * for Llama and other open models hosted on NVIDIA NIM.
 */
export interface NvidiaChatCompletionResponse {
  /** Unique identifier for the chat completion request */
  id: string;
  /** Response type identifier (always 'chat.completion') */
  object: 'chat.completion';
  /** Unix timestamp when the response was generated */
  created: number;
  /** Model name that generated the response */
  model: string;
  /** Array of generated response choices */
  choices: Array<{
    /** Index of this choice in the response array */
    index: number;
    /** Message content and role information */
    message: {
      /** Role of the message sender (always 'assistant' for completions) */
      role: 'assistant';
      /** The actual generated text content */
      content: string;
    };
    /** Reason why generation stopped */
    finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls';
  }>;
  /** Token usage information for the request */
  usage: {
    /** Number of tokens in the input prompt */
    prompt_tokens: number;
    /** Number of tokens in the generated response */
    completion_tokens: number;
    /** Total tokens used (prompt + completion) */
    total_tokens: number;
  };
}