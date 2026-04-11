import type { GenerateImagesConfig } from "@google/genai";

/**
 * Represents image data for processing and saving
 */
export interface AIImageData {
  /** Base64 encoded image data */
  imageData: string;
  /** MIME type of the image (optional, defaults to image/jpeg) */
  mimeType?: string;
  /** Index of the image (for filename generation) */
  index: number;
}

/**
 * Result from AI image generation supporting both file paths and direct buffers
 */
export interface AIImageResult {
  /** File paths (only available when outputDir is provided) */
  filePaths?: string[];
  /** Image buffers (always available) */
  buffers: Buffer[];
  /** MIME types for each image */
  mimeTypes: string[];
}

export type AIImageGenerationOptions = GenerateImagesConfig & {
  outputDir?: string;
  filename?: string;
  models?: string[];
}