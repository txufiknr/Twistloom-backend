/**
 * Configuration for AI image generation settings
 */

import { PersonGeneration } from "@google/genai";
import type { AIImageGenerationOptions } from "../types/ai-images.js";

/** Default output directory for generated images */
export const AI_IMAGE_OUTPUT_DIR: string = "./generated-images";

/** Default image generation model (by priority)
 * @see https://ai.google.dev/gemini-api/docs/models/imagen
 */
export const AI_IMAGE_MODEL_IMAGEN: string[] = [
  "imagen-4.0-generate-001",
  "imagen-4.0-ultra-generate-001",
  "imagen-4.0-fast-generate-001",
];

/**
 * Default native image generation model (by priority)
 * @see https://ai.google.dev/gemini-api/docs/models#generative_media_models
 */
export const AI_IMAGE_MODEL_GEMINI: string[] = [
  "gemini-3.1-flash-image-preview", // Nano Banana 2
  "gemini-3-pro-image-preview", // Nano Banana Pro
  "gemini-2.5-flash-image", // Nano Banana
];

export const AI_IMAGE_CONFIG: AIImageGenerationOptions = {
  /** Default number of images to generate per request */
  numberOfImages: 1,
  /** Default aspect ratio for generated images */
  aspectRatio: "1:1",
  /** Default output MIME type for generated images */
  outputMimeType: "image/jpeg",
  /** Default compression quality for JPEG/WebP images (0-100) */
  outputCompressionQuality: 85,
  /** Whether to enhance prompts by default for casual/exploratory use */
  enhancePrompt: true,
  /** Whether the model is allowed to generate images of people */
  personGeneration: PersonGeneration.ALLOW_ALL,
  /** Default image size */
  imageSize: "1K",
};