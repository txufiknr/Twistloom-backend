import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions.js';

/**
 * AI Provider types for rate limiting and configuration
 * 
 * These providers represent the supported AI services that can be used
 * for chat completions and text generation tasks.
 * 
 * Only Cohere V2 API has Built-in RAG Support.
 */
export type AIChatProvider =
  // @see https://docs.github.com/en/rest/models/inference
  | 'github'
  // @see https://ai.google.dev/gemini-api/docs/file-search
  // @see https://ai.google.dev/api/generate-content
  | 'gemini'
  | 'cohere'
  // @see https://docs.mistral.ai/api/endpoint/chat
  | 'mistral'
  // @see https://console.groq.com/docs/api-reference
  | 'groq'
  // @see https://docs.cerebras.ai/en/latest/cerebras-basics/api-endpoints.html
  // @see https://inference-docs.cerebras.ai/api-reference/chat-completions
  | 'cerebras'
  // @see https://docs.nvidia.com/ai-enterprise/nim-llm/1.0/api-reference.html
  // @see https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html
  // @see https://docs.nvidia.com/nim/large-language-models/latest/system-example.html
  | 'nvidia'
  | 'openrouter'
  | 'cloudflare'
  // Embeddings only (jina-embeddings-v5-text-small) — not a chat/completion
  // provider. Included here because rate limiting (RateLimiter, AI_RATE_LIMITS)
  // is shared infrastructure across both chat and embedding providers.
  // @see https://jina.ai/embeddings/
  | 'jina';

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
  /** Which AI provider evaluate the response */
  evalProvider?: AIChatProvider | 'none';
  /** Specific model used to evaluate the response (e.g., 'gpt-4o', 'gemini-2.5-flash') */
  evalModel?: string;
  /** The generated text content from the AI */
  output: string;
  /** The parsed content into expected type */
  result?: T;
  /** Token usage statistics for billing and monitoring (varies by provider) */
  usage?: object;
  /** Wall-clock request duration in milliseconds */
  durationMs?: number;
  /** Reason why the generation stopped (e.g., 'stop', 'length', 'content_filter') */
  finishReason?: string;
}

export type AIResponseProvider = Pick<AIResponse<unknown>, 'model' | 'provider' | 'evalModel' | 'evalProvider'>;

export type AIModelSelection = Partial<Record<AIChatProvider, string[]>>;

/**
 * Configuration options for AI prompt requests
 * 
 * These options control how prompts are processed and which providers
 * are available for fallback scenarios.
 */
export type AIPromptOptions = Partial<AIPromptDocuments> & {
  /** Object of providers and their respective models to include in the fallback chain */
  modelSelection?: AIModelSelection;
  /** Custom system prompt to override default behavior (must be static) */
  systemPrompt?: string;
  /** Provide JSON output format here. Logic will determine if this needed to be included in system prompt. */
  outputFormat?: string;
  /** Usage context string for logging and rate limiting (e.g., 'story-page') */
  context?: string;
  /** Additional configuration for the AI model */
  config?: AIChatConfig;
  /** Whether to parse the output as JSON */
  outputAsJson?: boolean;
  /** JSON structure to use for parsing */
  outputJsonStructure?: Record<string, AIJsonProperty>;
  /** Keys that must exist in the parsed JSON output */
  outputJsonRequired?: string[];
  /** Key to use when JSON parsing fails entirely (string value) */
  outputJsonFallbackField?: string;
  /** Whether to log the generated prompts */
  logPrompts?: boolean;
  /** Whether to log the evaluation result */
  logEvaluationResult?: boolean;
  /** Maximum number of model failures across all providers before giving up (undefined = no limit) */
  fallbackLimit?: number;
  /** Additional metadata */
  meta?: {
    bookId?: string;
  };
};

export type AIPromptDocuments = {
  /** Documents to provide as context to the AI model */
  documents: AIDocument[];
  /** Gemini context cache identifier (unique per documents) */
  cachedContentId: string;
};

export type AIBaseTypeOptions = Omit<AIPromptOptions,
  'outputAsJson' |
  'outputJsonStructure' |
  'outputJsonRequired' |
  'outputJsonFallbackField'
>;

export type AIPromptForJson<T> = {
  schema: { [K in keyof T]: AIJsonProperty },
  requiredFields: (keyof T)[],
  fallbackField: keyof T,
  baseOptions?: AIBaseTypeOptions,
}

export type AIPromptForJsonParams<T> = {
  prompt: string;
  configs: AIPromptForJson<T>;
  jsonStructure: string;
  fieldInstructions?: string;
  reviewChecklist?: string;
  evaluatorPrompt?: string;
}

export type AIJsonProperty = {
  type: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean';
  items?: AIJsonProperty;
  properties?: Record<string, AIJsonProperty>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: string[];
  description?: string;
};

/**
 * Evaluation result for AI-generated JSON content with scoring and feedback
 * 
 * This type represents the comprehensive evaluation of AI-generated content,
 * including before/after scoring, detailed feedback, and integrity checks.
 * It's used by the AI evaluation system to ensure quality and consistency
 * of generated story content and book initialization data.
 * 
 * @template T - The type of the evaluated output (e.g., StoryGeneration or BookCreationResponse)
 * 
 * @example
 * ```typescript
 * const evaluation: AIJsonEvaluation<StoryGeneration> = {
 *   output: generatedStory,
 *   scoreBefore: {
 *     total: 72,
 *     tension: 16,
 *     coherence: 14,
 *     style: 12,
 *     progression: 13,
 *     illusion: 6,
 *     consistency: 6,
 *     passed: false,
 *     issues: [
 *       { dimension: "tension", issue: "Escalation too linear", suggestion: "Add false calm moment" }
 *     ]
 *   },
 *   scoreAfter: {
 *     total: 78,
 *     tension: 19,
 *     coherence: 16,
 *     style: 13,
 *     progression: 14,
 *     illusion: 8,
 *     consistency: 8,
 *     passed: true,
 *     fixes: [
 *       { dimension: "tension", change: "Added moment of false relief before final escalation" }
 *     ]
 *   },
 *   actionFlags: [
 *     { actionIndex: 1, issue: "Choice appears too safe on surface" }
 *   ],
 *   integrityFlags: []
 * };
 * ```
 */
export type AIJsonEvaluation<T> = {
  /** The final evaluated and potentially corrected output content */
  output: T;
  
  /** 
   * Scoring evaluation of the original content before any corrections
   * 
   * This captures the initial quality assessment to show what needed improvement
   * and provides transparency about the evaluation process.
   */
  scoreBefore: AIJsonScoreBefore;
  
  /**
   * Scoring evaluation of the content after corrections were applied
   * 
   * This shows the final quality state and documents what improvements were made.
   * If no corrections were needed, this should match scoreBefore exactly.
   */
  scoreAfter: AIJsonScoreAfter;
  
  /**
   * Quality flags for action choices (not scored, but flagged for issues)
   * 
   * These identify problems with user choice options that don't affect the
   * main content score but need attention for good user experience.
   */
  actionFlags: AIJsonActionFlag[];
  
  /**
   * Integrity flags for JSON structure and data validation
   * 
   * These identify structural problems, type mismatches, or constraint violations
   * that need to be fixed for the content to be technically valid.
   */
  integrityFlags: AIJsonIntegrityFlag[];
};

export type AIJsonActionFlag = {
  /** Index of the action in the actions array (0-based) */
  actionIndex: number;
  /** Description of the issue with this action choice */
  issue: string;
};

export type AIJsonIntegrityFlag = {
  /** Which field or property has the integrity issue */
  field: string;
  /** Description of the specific integrity problem */
  issue: string;
};

export type AIJsonScoreBefore = {
  /** Total score across all dimensions (0-100) */
  total: number;
  /** Detailed breakdown of scores by dimension */
  breakdown: AIJsonScoreBreakdown[],
  /** Whether the content passed minimum quality thresholds */
  passed: boolean;
  /** List of identified issues with suggested improvements */
  issues: AIJsonEvaluationIssue[];
};

export type AIJsonScoreAfter = {
  /** Total score across all dimensions (0-100) */
  total: number;
  /** Detailed breakdown of scores by dimension */
  breakdown: AIJsonScoreBreakdown[],
  /** Whether the corrected content passed minimum quality thresholds */
  passed: boolean;
  /** List of actual changes made during correction */
  fixes: AIJsonEvaluationFix[];
};

export type AIJsonScoreBreakdown = {
  dimension: string;
  score: number;
};

export type AIJsonEvaluationIssue = {
  /** Which scoring dimension this issue affects */
  dimension: string;
  /** Description of the specific problem identified */
  issue: string;
  /** Suggested fix or improvement approach */
  suggestion: string;
};

export type AIJsonEvaluationFix = {
  /** Which scoring dimension this fix affected */
  dimension: string;
  /** Description of the specific change made */
  change: string;
};

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
  /** Frequency penalty to reduce repetition of tokens (0.0 = no penalty) */
  frequencyPenalty?: number;
  /** Optional seed for reproducibility */
  seed?: number;
};

export type AIChatConfigCaps = {
  maxTemperature?: number;
  maxTopP?: number;
  maxTopK?: number;
}

/**
 * Document structure for document-based AI processing
 * 
 * Used when providing context documents to AI models that support
 * retrieval-augmented generation (RAG) or document analysis.
 */
export type AIDocument = { 
  /** Optional document title for context */
  title?: string; 
  /** Main document content snippet */
  snippet: string;
};

/**
 * Advanced options for prompt processing with fallback support
 * 
 * Extends basic prompt options with additional parameters for fine-tuned
 * control over AI model behavior and output formatting.
 */
export type PromptWithFallbackOptions = Omit<AIPromptOptions, 'modelSelection'> & {
  /** Array of model names to use for fallback attempts */
  models?: string[];
  /**
   * Optional AbortSignal for cancellation
   * 
   * Note: This parameter is currently only used by streaming functions (aiStreamSSE).
   * Non-streaming functions (githubPrompt, geminiPrompt, etc.) do not support cancellation
   * via AbortSignal. This is an intentional trade-off since non-streaming requests typically
   * complete quickly and the benefit of cancellation is minimal.
   */
  signal?: AbortSignal;
  /**
   * @internal Shared mutable counter for cross-provider fallback limiting.
   * Initialized once in aiPrompt and passed by reference through every
   * promptWithFallback call. Never set this from user code.
   */
  _fallbackCounter?: { count: number };
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
  /** Tokens that were served from provider-side cache */
  cachedTokens?: number;
  /** Fraction of prompt tokens that were cache hits (0–1). Undefined if not reported. */
  cacheHitRate?: number;
}

/**
 * Optional usage data a provider generator can report on completion.
 * Returned as the generator's return value (not yielded) — see
 * `AIStreamGenerator` below. Providers that don't expose mid-stream
 * usage simply don't return anything (`undefined`, i.e. `void`).
 */
export interface StreamUsage {
  /** Total prompt tokens for this request, as reported by the provider. */
  promptTokens?: number;
  /** Of `promptTokens`, how many were served from a provider-side cache. */
  cachedTokens?: number;
}

/**
 * A streaming text generator that may optionally report `StreamUsage`
 * as its return value once exhausted. All provider generators share
 * this type so the orchestrator can read usage uniformly via `.next()`.
 */
export type AIStreamGenerator = AsyncGenerator<string, StreamUsage | void, unknown>;

export type AIProviderRateLimit = {
  /** Requests per minute — used by RateLimiter.throttle() for inter-call spacing */
  rpm: number;
  /**
   * Requests per day — used by canUseAIToday() for daily gate.
   * Where multiple models share a provider entry, this reflects the ceiling
   * across all models you'd realistically call; individual models may be lower.
   * The waterfall's 429 handling covers the gap.
   */
  rpd?: number;
  /**
   * Requests per month — used by canUseAIToday() for monthly gate.
   * Mutually exclusive with rpd in practice: set one or the other,
   * not both, unless the provider genuinely enforces separate daily AND monthly caps.
   */
  rpmo?: number;
};

// Extend the standard OpenAI type to support OpenRouter features
export interface OpenRouterCreateParams extends ChatCompletionCreateParamsNonStreaming {
  plugins?: Array<{
    id: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any; // Allows for any plugin-specific configurations
  }>;
}