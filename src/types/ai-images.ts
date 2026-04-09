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

export type AIImageGenerationOptions = GenerateImagesConfig & {
  outputDir?: string;
  filename?: string;
  models?: string[];
}