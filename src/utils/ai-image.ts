/**
 * AI Image Generation Utilities
 * @overview AI image generation with automatic model fallback
 * 
 * This module provides comprehensive image generation capabilities using Google's AI models,
 * with automatic fallback mechanisms for maximum reliability and performance.
 * 
 * Imagen Models
 * - Purpose: Advanced image generation with superior quality and adherence
 * - Strengths: Better prompt following, aspect ratio control, negative prompts
 * - Use Cases: High-quality artwork, detailed illustrations, professional graphics
 * - Models: {@link AI_IMAGE_MODEL_IMAGEN}
 * 
 * Gemini Native Models  
 * - Purpose: High-efficiency generation optimized for speed and volume
 * - Strengths: Rapid processing, cost-effective, high throughput
 * - Use Cases: Quick prototypes, batch processing, real-time applications
 * - Models: {@link AI_IMAGE_MODEL_GEMINI}
 * 
 * Architecture
 * 1. Primary Function: `geminiGenerateImage()` - Smart fallback across providers
 * 2. Provider Functions: `geminiGenerateImageImagen()` and `geminiGenerateImageNative()`
 * 3. Core Helper: `generateImageWithFallback()` - Unified retry logic which iterates each model
 */

import * as fs from "fs";
import * as path from "path";
import { getGeminiClient } from "./ai-clients.js";
import { getGeminiLimiter } from "./ai-limiters.js";
import { AI_IMAGE_CONFIG, AI_IMAGE_MODEL_GEMINI, AI_IMAGE_MODEL_IMAGEN, AI_IMAGE_OUTPUT_DIR } from "../config/ai-images.js";
import type { AIImageGenerationOptions, AIImageData, AIImageResult } from "../types/ai-images.js";
import { getErrorMessage } from "./error.js";
import { sanitizeFilename } from "./formatter.js";

/**
 * Base function for AI image generation with model fallback
 * 
 * @param provider - Provider name for logging and rate limiting
 * @param models - Array of models to try in order (by priority)
 * @param prompt - Image generation prompt
 * @param options - Image generation options
 * @param apiCall - Function that makes the actual API call
 * @param extractImageData - Function that extracts image data from response
 * @returns AIImageResult with buffers and optional file paths, or null if all models fail
 */
async function generateImageWithFallback<T>(
  provider: string,
  models: string[],
  prompt: string,
  options: AIImageGenerationOptions,
  apiCall: (model: string, prompt: string, opts: AIImageGenerationOptions) => Promise<T>,
  extractImageData: (response: T) => AIImageData[]
): Promise<AIImageResult | null> {
  // 1️⃣ Early validation: Check if models array is provided
  if (!models || models.length === 0) {
    console.warn(`[${provider}] ⚠️ No models configured`);
    return null;
  }

  // 2️⃣ Model iteration: Try each model in order until one succeeds
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      // Rate limiting: Apply throttling before making API call
      await getGeminiLimiter().throttle();
      
      // API call: Execute the actual image generation request
      const response = await apiCall(model, prompt, options);
      
      // Response extraction: Get the image data from the response
      const imageDataArray = extractImageData(response);
      
      // Success handling: Process valid response and return result
      if (imageDataArray && imageDataArray.length > 0) {
        console.log(`[${provider}] ✅ Model ${model} generated ${imageDataArray.length} image(s)`);
        return processAndSaveImages(imageDataArray, options.outputDir, options.filename, provider);
      }

      // Empty response handling: Log when no images are generated
      console.warn(`[${provider}] ⚠️ Model ${model} generated no images`);
    } catch (error) {
      // Error handling: Classify error and decide on retry strategy
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (i < models.length - 1) {
        // Model fallback: Try next model if more are available
        console.warn(`[${provider}] 💥 Model ${model} failed, trying next model:`, errorMessage);
      } else {
        // Final failure: All models have been exhausted
        console.error(`[${provider}] ❌ All models failed:`, errorMessage);
      }
    }
  }

  // 4️⃣ Complete failure: Return null when all models fail
  return null;
}

/**
 * Processes and saves generated images to disk (optional)
 * 
 * @param imageDataArray - Array of image data to process
 * @param outputDir - Directory to save images to (optional, if not provided only returns buffers)
 * @param filename - Optional base filename (without extension)
 * @param context - Context for logging
 * @returns AIImageResult with buffers and optional file paths
 * 
 * @example
 * ```typescript
 * // Only buffers (no disk write)
 * const result = await processAndSaveImages(imageData, undefined, "my-image", "ai-image");
 * 
 * // Buffers + file paths
 * const result = await processAndSaveImages(imageData, "./output", "my-image", "ai-image");
 * ```
 */
function processAndSaveImages(
  imageDataArray: AIImageData[],
  outputDir: string | undefined,
  filename?: string,
  context: string = "ai-image"
): AIImageResult {
  const savedPaths: string[] = [];
  const buffers: Buffer[] = [];
  const mimeTypes: string[] = [];

  // Ensure output directory exists (only if outputDir is provided)
  if (outputDir && !fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (const imageData of imageDataArray) {
    if (!imageData.imageData) {
      console.warn(`[${context}] Image ${imageData.index + 1} has no data, skipping.`);
      continue;
    }

    // Determine file extension from MIME type
    const ext = imageData.mimeType === "image/jpeg" ? "jpg"
                : imageData.mimeType === "image/webp" ? "webp"
                : imageData.mimeType?.endsWith("png") ? "png"
                : "jpg"; // fallback to jpg if MIME type is unknown

    // Determine MIME type (default to jpeg if unknown)
    const mimeType = imageData.mimeType || "image/jpeg";

    // Always create buffer from base64 data
    const buffer = Buffer.from(imageData.imageData, "base64");
    buffers.push(buffer);
    mimeTypes.push(mimeType);

    // Save to disk only if outputDir is provided
    if (outputDir) {
      // Generate filename
      const baseName = filename
        ? sanitizeFilename(`${filename}${imageData.index > 0 ? `_${imageData.index}` : ""}`)
        : sanitizeFilename(`image_${Date.now()}_${imageData.index + 1}`);

      const filepath = path.join(outputDir, `${baseName}.${ext}`);
      
      // Save image to disk
      fs.writeFileSync(filepath, buffer);
      console.log(`[${context}] ✅ Saved: ${filepath}`);
      savedPaths.push(path.resolve(filepath));
    } else {
      console.log(`[${context}] 🖼️ Processed image ${imageData.index + 1} (memory only)`);
    }
  }

  return {
    filePaths: outputDir ? savedPaths : undefined,
    buffers,
    mimeTypes
  };
}

/**
 * Generates images using Google's Imagen models with automatic fallback support
 * 
 * This function uses the Imagen API to generate high-quality images from text prompts.
 * It supports automatic model fallback - if the primary model fails, it will
 * automatically try the next available model in the priority list.
 * 
 * @param prompt - Text description of the image to generate (high-quality, photorealistic, high-detail)
 * @param options - Configuration options for image generation ({@link AIImageGenerationOptions})
 * 
 * @returns Promise resolving to AIImageResult with buffers and optional file paths.
 * @throws {Error} When API key is missing or all models fail
 * 
 * @example
 * ```typescript
 * const result = await geminiGenerateImageImagen(
 *   "A futuristic cityscape at night with neon lights"
 * );
 * 
 * console.log("Generated images:", result.buffers.length);
 * ```
 * 
 * @see https://ai.google.dev/gemini-api/docs/imagen
 * @see https://ai.google.dev/gemini-api/docs/models/imagen
 */
export async function geminiGenerateImageImagen(prompt: string, options: AIImageGenerationOptions = AI_IMAGE_CONFIG): Promise<AIImageResult> {
  const {
    models = AI_IMAGE_MODEL_IMAGEN,
    outputDir = AI_IMAGE_OUTPUT_DIR,
    filename,
  } = options;

  // Use user-provided model if specified, otherwise use fallback array
  const finalOptions = { ...options, outputDir, filename };

  const result = await generateImageWithFallback(
    "imagen",
    models,
    prompt,
    finalOptions,
    async (model, prompt, opts) => {
      const {
        numberOfImages = AI_IMAGE_CONFIG.numberOfImages,
        aspectRatio = AI_IMAGE_CONFIG.aspectRatio,
        imageSize = AI_IMAGE_CONFIG.imageSize,
        outputMimeType = AI_IMAGE_CONFIG.outputMimeType,
        outputCompressionQuality = AI_IMAGE_CONFIG.outputCompressionQuality,
        // enhancePrompt = AI_IMAGE_CONFIG.enhancePrompt,
      } = opts;

      // Docs: https://ai.google.dev/gemini-api/docs/imagen
      return await getGeminiClient().models.generateImages({
        model,
        prompt,
        config: {
          numberOfImages,
          aspectRatio,
          imageSize,
          outputMimeType,
          outputCompressionQuality,
          // enhancePrompt,
        },
      });
    },
    (response) => {
      // Convert Imagen response to common format
      return (response.generatedImages?.length ?? 0) > 0 
        ? response.generatedImages!.map((image, index) => ({
            imageData: image.image?.imageBytes || "",
            mimeType: image.image?.imageBytes ? options.outputMimeType : undefined,
            index
          }))
        : [];
    }
  );
  
  return result || { buffers: [], mimeTypes: [] };
}


/**
 * Generates images using Google's Gemini native models with automatic fallback support
 * 
 * This function uses Gemini's native image generation models to create images from text prompts.
 * These models are optimized for speed and high-volume use cases, making them ideal for
 * applications requiring rapid image generation. Supports automatic model fallback for reliability.
 * 
 * @param prompt - Text description of the image to generate (high-quality, photorealistic, high-detail)
 * @param options - Configuration options for image generation ({@link AIImageGenerationOptions})
 * 
 * @returns Promise resolving to AIImageResult with buffers and optional file paths.
 * @throws {Error} When API key is missing or all models fail
 * 
 * @example
 * ```typescript
 * // Basic usage with defaults
 * const result = await geminiGenerateImageNative(
 *   "A futuristic cityscape at night with neon lights"
 * );
 * 
 * console.log("Generated images:", result.buffers.length);
 * ```
 * 
 * @see https://ai.google.dev/gemini-api/docs/models/gemini
 */
export async function geminiGenerateImageNative(prompt: string, options: AIImageGenerationOptions = AI_IMAGE_CONFIG): Promise<AIImageResult> {
  const {
    models = AI_IMAGE_MODEL_GEMINI,
    outputDir = AI_IMAGE_OUTPUT_DIR,
    filename,
  } = options;

  // Use user-provided model if specified, otherwise use fallback array
  const finalOptions = { ...options, outputDir, filename };

  const result = await generateImageWithFallback(
    "gemini",
    models,
    prompt,
    finalOptions,
    async (model, prompt, opts) => {
      const {
        imageSize = AI_IMAGE_CONFIG.imageSize,
        // personGeneration = AI_IMAGE_CONFIG.personGeneration,
        aspectRatio = AI_IMAGE_CONFIG.aspectRatio,
        outputMimeType = AI_IMAGE_CONFIG.outputMimeType,
        outputCompressionQuality = AI_IMAGE_CONFIG.outputCompressionQuality,
      } = opts;

      // Gemini native image models - different API!
      return await getGeminiClient().models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: {
            aspectRatio,
            imageSize,
            // personGeneration,
            outputMimeType,
            outputCompressionQuality,
          },
        },
      });
    },
    (response) => {
      // Convert Gemini native response to common format
      const parts = response.candidates?.[0]?.content?.parts ?? [];
      const imageDataArray: AIImageData[] = [];
      let imageIndex = 0;

      for (const part of parts) {
        if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("image/")) {
          imageDataArray.push({
            imageData: part.inlineData.data,
            mimeType: part.inlineData.mimeType,
            index: imageIndex++
          });
        }
      }

      return imageDataArray;
    }
  );
  
  return result || { buffers: [], mimeTypes: [] };
}

/**
 * Generates images using Google's AI models with automatic fallback across providers
 * 
 * This function provides the most reliable image generation by trying Imagen models first
 * (for highest quality) then falling back to Gemini native models (for speed).
 * This gives you the best of both worlds: quality when available, speed as backup.
 * 
 * @param prompt - Text description of image to generate (high-quality, photorealistic, high-detail)
 * @param options - Configuration options for image generation ({@link AIImageGenerationOptions})
 * 
 * @returns Promise resolving to AIImageResult with buffers and optional file paths.
 * @throws {Error} When API key is missing or all models fail
 * 
 * @example
 * ```typescript
 * // Basic usage with defaults (tries Imagen first, then Gemini)
 * const result = await geminiGenerateImage(
 *   "A futuristic cityscape at night with neon lights"
 * );
 * 
 * console.log("Generated images:", result.buffers.length);
 * ```
 * 
 * @see https://ai.google.dev/gemini-api/docs/models/imagen
 * @see https://ai.google.dev/gemini-api/docs/models/gemini
 */
export async function geminiGenerateImage(prompt: string, options: AIImageGenerationOptions = AI_IMAGE_CONFIG): Promise<AIImageResult> {
  // First attempt: Try Imagen first (highest quality)
  try {
    const imagenResult = await geminiGenerateImageImagen(prompt, options);
    if (imagenResult.buffers.length > 0) return imagenResult;
    console.warn(`[geminiGenerateImage] ⚠️ No result from Imagen, trying Gemini native`);
  } catch (error) {
    console.warn(`[geminiGenerateImage] ⚠️ No result from Imagen, trying Gemini native:`, getErrorMessage(error));
  }

  // Fallback: Gemini native models (Nano Banana)
  try {
    const geminiResult = await geminiGenerateImageNative(prompt, options);
    if (geminiResult.buffers.length > 0) return geminiResult;
    console.warn(`[geminiGenerateImage] ⚠️ No result from Nano Banana`);
  } catch (error) {
    console.warn(`[geminiGenerateImage] ⚠️ No result from Nano Banana:`, getErrorMessage(error));
  }
  
  // Complete failure: all models exhausted
  console.error(`[geminiGenerateImage] ❌ Both Imagen and Nano Banana failed`);
  return { buffers: [], mimeTypes: [] };
}
