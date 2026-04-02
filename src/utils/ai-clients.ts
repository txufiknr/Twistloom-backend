import { GoogleGenAI } from "@google/genai";
import { CohereClientV2 } from 'cohere-ai';
import { requireEnv } from './env.js';
import Groq from 'groq-sdk';
import OpenAI from "openai";
import Cerebras from "@cerebras/cerebras_cloud_sdk";
import { Mistral } from "@mistralai/mistralai";
import { AIChatProvider } from "../types/ai-chat.js";

/** AI client singleton instances to reuse connections across requests */
let githubClient: OpenAI | null = null;
let geminiClient: GoogleGenAI | null = null;
let cohereClient: CohereClientV2 | null = null;
let mistralClient: Mistral | null = null;
let groqClient: Groq | null = null;
let cerebrasClient: Cerebras | null = null;

/** Mapping of AI providers to their API key environment variable names */
export const AI_PROVIDER_API_KEYS: Record<AIChatProvider, string> = {
  github: 'GITHUB_API_KEY',
  gemini: 'GEMINI_API_KEY',
  cohere: 'COHERE_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
};

// GitHub client singleton
export function getGitHubClient(): OpenAI {
  if (githubClient) return githubClient;

  const apiKey = requireEnv('GITHUB_API_KEY');

  githubClient = new OpenAI({
    apiKey,
    baseURL: "https://models.github.ai/inference",
  });
  return githubClient;
}

// Gemini client singleton
export function getGeminiClient(): GoogleGenAI {
  if (geminiClient) return geminiClient;

  const apiKey = requireEnv('GEMINI_API_KEY');

  geminiClient = new GoogleGenAI({ apiKey });
  return geminiClient;
}

// Cohere client singleton
export function getCohereClient(): CohereClientV2 {
  if (cohereClient) return cohereClient;

  const apiKey = requireEnv('COHERE_API_KEY');

  cohereClient = new CohereClientV2({ token: apiKey });
  return cohereClient;
}

// Mistral client singleton
export function getMistralClient(): Mistral {
  if (mistralClient) return mistralClient;

  const apiKey = requireEnv('MISTRAL_API_KEY');

  mistralClient = new Mistral({ apiKey });
  return mistralClient;
}

// Groq client singleton
export function getGroqClient(): Groq {
  if (groqClient) return groqClient;

  const apiKey = requireEnv('GROQ_API_KEY');

  groqClient = new Groq({ apiKey });
  return groqClient;
}

// Cerebras client singleton
export function getCerebrasClient(): Cerebras {
  if (cerebrasClient) return cerebrasClient;

  const apiKey = requireEnv('CEREBRAS_API_KEY');

  cerebrasClient = new Cerebras({ apiKey });
  return cerebrasClient;
}