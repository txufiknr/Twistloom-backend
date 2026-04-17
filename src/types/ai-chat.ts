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
  'github' |
  // @see https://ai.google.dev/gemini-api/docs/file-search
  // @see https://ai.google.dev/api/generate-content
  'gemini' |
  'cohere' |
  // @see https://docs.mistral.ai/api/endpoint/chat
  'mistral' |
  // @see https://console.groq.com/docs/api-reference
  'groq' |
  // @see https://docs.cerebras.ai/en/latest/cerebras-basics/api-endpoints.html
  // @see https://inference-docs.cerebras.ai/api-reference/chat-completions
  'cerebras' |
  // @see https://docs.nvidia.com/ai-enterprise/nim-llm/1.0/api-reference.html
  // @see https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html
  // @see https://docs.nvidia.com/nim/large-language-models/latest/system-example.html
  'nvidia';

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
  /** Custom system prompt to override default behavior */
  systemPrompt?: string;
  /** Usage context string for logging and rate limiting (e.g., 'story-page') */
  context?: string;
  /** Additional configuration for the AI model */
  config?: AIChatConfig;
  /** Documents to provide as context to the AI model */
  documents?: AIDocument[];
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
  /** Whether to log the evaluation result from the AI generated JSON content with scoring and feedback. */
  logEvaluationResult?: boolean;
}

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
  thinkThenOutput?: string;
  evaluatorPrompt?: string;
}

export type AIJsonProperty = {
  type: string;
  items?: { type: string };
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
  actionFlags: Array<{
    /** Index of the action in the actions array (0-based) */
    actionIndex: number;
    /** Description of the issue with this action choice */
    issue: string;
  }>;
  
  /**
   * Integrity flags for JSON structure and data validation
   * 
   * These identify structural problems, type mismatches, or constraint violations
   * that need to be fixed for the content to be technically valid.
   */
  integrityFlags: Array<{
    /** Which field or property has the integrity issue */
    field: string;
    /** Description of the specific integrity problem */
    issue: string;
  }>;
};

export type AIJsonScoreBefore = {
  /** Total score across all dimensions (0-100) */
  total: number;
  /** Detailed breakdown of scores by dimension */
  breakdown: Record<string, number>,
  /** Whether the content passed minimum quality thresholds */
  passed: boolean;
  /** List of identified issues with suggested improvements */
  issues: Array<{
    /** Which scoring dimension this issue affects */
    dimension: string;
    /** Description of the specific problem identified */
    issue: string;
    /** Suggested fix or improvement approach */
    suggestion: string;
  }>;
}

export type AIJsonScoreAfter = {
  /** Total score across all dimensions (0-100) */
  total: number;
  /** Detailed breakdown of scores by dimension */
  breakdown: Record<string, number>,
  /** Whether the corrected content passed minimum quality thresholds */
  passed: boolean;
  /** List of actual changes made during correction */
  fixes: Array<{
    /** Which scoring dimension this fix affected */
    dimension: string;
    /** Description of the specific change made */
    change: string;
  }>;
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