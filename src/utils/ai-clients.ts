import { GoogleGenAI } from "@google/genai";
import { CohereClientV2 } from 'cohere-ai';
import { requireEnv } from './env.js';
import Groq from 'groq-sdk';
import OpenAI from "openai";
import Cerebras from "@cerebras/cerebras_cloud_sdk";
import { Mistral } from "@mistralai/mistralai";
import type { AIChatProvider } from "../types/ai-chat.js";

/** AI client singleton instances to reuse connections across requests */
let geminiClient: GoogleGenAI | null = null;
let cohereClient: CohereClientV2 | null = null;
let mistralClient: Mistral | null = null;
let groqClient: Groq | null = null;
let cerebrasClient: Cerebras | null = null;
let openrouterClient: OpenAI | null = null;
let cloudflareClient: OpenAI | null = null;
let inceptionClient: OpenAI | null = null;

/** Mapping of AI providers to their API key environment variable names */
export const AI_PROVIDER_API_KEYS: Record<AIChatProvider, string> = {
  gemini: 'GEMINI_API_KEY',
  cohere: 'COHERE_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  cloudflare: 'CLOUDFLARE_API_TOKEN',
  jina: 'JINA_API_KEY',
  ovhcloud: 'OVHCLOUD_API_KEY',
  sambanova: 'SAMBANOVA_API_KEY',
  ollama: 'OLLAMA_API_KEY',
  modelscope: 'MODELSCOPE_API_KEY',
  zai: 'ZAI_API_KEY',
  siliconflow: 'SILICONFLOW_API_KEY',
  aionlabs: 'AIONLABS_API_KEY',
  chutes: 'CHUTES_API_KEY',
  llm7: 'LLM7_API_KEY',
  inception: 'INCEPTION_API_KEY',
};

// Gemini client singleton
export function getGeminiClient(): GoogleGenAI {
  if (geminiClient) return geminiClient;

  geminiClient = new GoogleGenAI({ apiKey: requireEnv('GEMINI_API_KEY') });
  return geminiClient;
}

// Cohere client singleton
export function getCohereClient(): CohereClientV2 {
  if (cohereClient) return cohereClient;

  cohereClient = new CohereClientV2({ token: requireEnv('COHERE_API_KEY') });
  return cohereClient;
}

// Mistral client singleton
export function getMistralClient(): Mistral {
  if (mistralClient) return mistralClient;

  mistralClient = new Mistral({
    apiKey: requireEnv('MISTRAL_API_KEY'),
    timeoutMs: 60000,
    retryConfig: {
      strategy: "backoff",
      backoff: {
        initialInterval: 500,  // Milliseconds to wait before the 1st retry
        maxInterval: 10000,    // Maximum delay between any two retries
        exponent: 1.5,         // Multiplier applied to the interval each step
        maxElapsedTime: 60000, // Max total time across all retry attempts (1 minute)
      },
      retryConnectionErrors: true, // Retry on network drops or DNS failures
    },
  });
  return mistralClient;
}

// Groq client singleton
export function getGroqClient(): Groq {
  if (groqClient) return groqClient;

  groqClient = new Groq({ apiKey: requireEnv('GROQ_API_KEY') });
  return groqClient;
}

// Cerebras client singleton
export function getCerebrasClient(): Cerebras {
  if (cerebrasClient) return cerebrasClient;

  cerebrasClient = new Cerebras({ apiKey: requireEnv('CEREBRAS_API_KEY') });
  return cerebrasClient;
}

export function getOpenRouterClient(): OpenAI {
  if (openrouterClient) return openrouterClient;

  openrouterClient = new OpenAI({
    apiKey: requireEnv('OPENROUTER_API_KEY'),
    baseURL: 'https://openrouter.ai/api/v1',
  });
  return openrouterClient;
}

export function getCloudflareClient(): OpenAI {
  if (cloudflareClient) return cloudflareClient;

  cloudflareClient = new OpenAI({
    apiKey: requireEnv('CLOUDFLARE_API_TOKEN'),
    baseURL: `https://api.cloudflare.com/client/v4/accounts/${requireEnv('CLOUDFLARE_ACCOUNT_ID')}/ai/v1`,
  });
  return cloudflareClient;
}

// Inception client singleton (OpenAI-compatible with custom baseURL)
// Diffusion LLM (Mercury) — base URL confirmed from https://inceptionlabs.ai/platform
export function getInceptionClient(): OpenAI {
  if (inceptionClient) return inceptionClient;

  inceptionClient = new OpenAI({
    apiKey: requireEnv('INCEPTION_API_KEY'),
    baseURL: 'https://api.inceptionlabs.ai/v1',
  });
  return inceptionClient;
}

/**
 * Pre-warms all AI provider SDKs so the first real request doesn't pay
 * the cold-start penalty of initialising every client.
 *
 * Safe to call at any time — each get*Client() lazy-initialises once
 * and returns the cached singleton on subsequent calls.
 *
 * Called by the /health endpoint (see src/app.ts) which Vercel's
 * monitor pings every 5 minutes, keeping the function warm.
 */
export function warmAIProviders(): void {
  getGeminiClient();
  getMistralClient();
  getGroqClient();
  getCerebrasClient();
  getOpenRouterClient();
  getCloudflareClient();
}