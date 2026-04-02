import type { AIChatProvider, AIPromptOptions, AIProvider, AIResponse, AISummarizeOptions, ArticleCandidate, ContentTopic, ContentType, SummarizerParams, SummaryContext, SummaryDetail, SummaryResult } from "../types/content.js";
import { MAX_ARTICLE_TITLE_LENGTH, MIN_ARTICLE_LENGTH, SUMMARY_MAX_LENGTH, SUMMARY_WORD_COUNT, SUMMARY_SENTENCE_COUNT, SUMMARY_MIN_LENGTH, SUMMARY_MAX_HOOK_LENGTH, SUMMARY_MAX_LENGTH_TOLERANCE, SUMMARY_BLACKLIST_WORDS, SUMMARY_MAX_CONTEXT_LENGTH } from "../config/constants.js";
import { CONTENT_TYPES, ISLAMIC_ABBREVIATIONS } from "../config/contents.js";
import { CONTEXT_GENERATION_THRESHOLD } from "../config/content-cis.js";
import { containsRelativeTime, postProcessSummary, truncateToSentence, validateAndSanitizeAIText } from "../utils/text-processing.js";
import { SummarizerManager } from "node-summarizer";
import { getTodayDate } from "../utils/time.js";
import type { SummaryProvider } from "../types/content.js";
import { getRateLimiter, getHuggingfaceLimiter, incrementDailyUsageCount, canUseAIToday } from './ai-limiters.js';
import { logAISuccess, logAIFailure, logAIPrompt } from './ai-logger.js';
import { classifyGenAIError, getErrorMessage } from "./error.js";
import { isForeignLanguage, isSentenceComplete } from "./text-processing.js";
import { splitSentencesRegex, splitWordsRegex, scoreSentences, removeBoilerplateText } from './text-processing.js';
import winkNLP from 'wink-nlp';
import model from 'wink-eng-lite-web-model';
import natural, { type WordTokenizer, type SentenceTokenizer } from 'natural';
import fs from 'fs';
import path from 'path';
import type Groq from 'groq-sdk';
import type { ChatCompletion as OpenAIChatCompletion } from 'openai/resources/chat/completions.js';

import type { GenerateContentResponse } from "@google/genai";
import { needsTitleRefinement, replaceIslamicTerms, computeContextImportance } from "./content.js";
import { AI_PROVIDER_API_KEYS, getCerebrasClient, getCohereClient, getGeminiClient, getGitHubClient, getGroqClient, getHfClient, getMistralClient } from './ai-clients.js';
import { convertSingleToDoubleQuotes, normalizeQuotemarks } from "./quote.js";
import { parseAISafely } from "./parser.js";
import { combineItems } from "../db/cluster.js";
import { getTopicFromKeywords } from "./topics.js";
import { MAX_ARTICLE_LENGTH, MAX_OUTPUT_TOKEN, MAX_PROMPT_LENGTH, MAX_TEMPERATURE, NEED_OUTPUT_REVIEW, SUMMARIZER_MODELS, TIER_S_PROVIDERS, TRUNCATION_CONSTANTS } from "../config/ai-clients.js";
import type { V2ChatResponse } from "cohere-ai/api";
import type { ChatCompletion } from "@cerebras/cerebras_cloud_sdk/resources/index.mjs";
import type { ChatCompletionResponse } from "@mistralai/mistralai/models/components";
import { requireEnv } from "./env.js";
import { STANDARD_SUMMARY_SOURCES } from "../db/purge.js";
import { AIDocument } from "../types/ai-chat.js";

// Initialize natural tokenizers
const sentenceTokenizer: SentenceTokenizer = new natural.SentenceTokenizer(ISLAMIC_ABBREVIATIONS);
const wordTokenizer: WordTokenizer = new natural.WordTokenizer();

// Initialize wink-nlp model and utilities
const nlp = winkNLP(model);
const its = nlp.its;

// System prompt that will be included in every request
const PROMPT_SYSTEM = `You are a knowledgeable Islamic editor writing quality short news digests for global Muslim readers.

Principles:
- NEVER change the meanings of Quranic verses or Hadith
- NEVER paraphrase or summarize Quranic verse wording
- NEVER issue fatwas, verdicts, or personal opinions
- Use precise Islamic terminology (e.g. "Quran" not "Koran")
- Maintain academic rigor and respectful tone
- Write in clear, neutral English suitable for general readers

Critical accuracy requirements:
- NEVER simplify statements in ways that change temporal context
- NEVER create ambiguous statements that could be misinterpreted
- NEVER use relative time words (e.g. today, tomorrow, yesterday, tonight)
- Use absolute dates or event-relative timing when available, or omit
- Preserve temporal qualifiers from the original
- When in doubt, be MORE specific rather than less specific

Examples of temporal accuracy:
- ❌ "Ramadan begins after Maghrib"
- ✅ "Ramadan begins the night before the first fast, after Maghrib"`;

const PROMPT_TITLE_LENGTH = `
- 1 sentence, 6-12 words or ${MAX_ARTICLE_TITLE_LENGTH} characters`;

const RULES_EDITORIAL = `
- Write the summary as the content, not about the content
- Do NOT include phrases like "This article..." or "The author..."
- Provide direct narrative summaries written as if for a reader
- Begin directly with the subject matter
- No framing, no commentary, no analysis of the writing
- Write minimum 6 words per sentence for clarity`;

const RULES_ARTICLE = `
- Focus on key facts, context, and developments
- Preserve Quranic and Hadith meanings exactly
- If scholars are mentioned, name them explicitly
- Do NOT oversimplify religious rulings
- No emojis, no casual language
- No conclusions, recommendations, or advice`;

const RULES_NEWS = `
- Prioritize factual accuracy and clarity
- Include key details: who, what, when, where, why
- Maintain neutral, objective tone
- Preserve Islamic terminology and context
- Avoid speculation or unverified claims
- No emotional language or sensationalism`;

const RULES_QURAN_HADITH = `
- Preserve exact meaning
- DO NOT paraphrase Quranic verses loosely
- DO: "Muhammad ﷺ", DON'T: "Prophet Muhammad (peace be upon him)"
- If a Hadith is mentioned, note its context if present
- Avoid interpretive opinions
- Use neutral academic tone`;

const RULES_FIQH_SHARIA = `
- Do NOT issue rulings or advice
- Mention differences of scholarly opinion if stated
- Avoid definitive language unless explicitly stated
- Preserve Arabic terms where relevant`;

const RULES_QA = `
- Format with exactly two sections: \`Q: (Short question text)\` and \`A: (Answer text)\`
- Preserve the essence of the question being asked
- Include the scholarly response or guidance provided
- If multiple scholars respond, note different perspectives
- Do NOT provide personal opinions or additional advice
- Keep answers concise but clear
- Reference evidence (Qur’an, Hadith, scholars), if mentioned`;

const PROMPT_TITLE = `Refine the following article title to be clear, warm, and engaging.

Tone & intent:
- Suitable for a Muslim audience (IMPORTANT)
- Calm, welcoming, and respectful
- Lightly conversational (reader-friendly, not casual slang)
- Encourages reading without exaggeration

Rules:
${PROMPT_TITLE_LENGTH}
- Preserve the authentic meaning and context
- Use correct Islamic terminology (not Western)
- Do NOT add new facts, conclusions, or opinions
- Do NOT imply obligation, sin, reward, or punishment
- No clickbait, fear-based, or sensational phrasing
- No emojis
- No rhetorical questions that imply judgment
- Avoid any psychological framing

Style guidance:
- Prefer gentle phrasing over commands
- It may sound inviting or reflective, but not promotional
- No rulings, no hype, no guilt language
- Example:
  - ❌ "Prepare for Ramadan"
  - ✅ "Ramadan is coming — here’s the to-do list"
- Why:
  - “Ramadan is coming” → contextual + comforting
  - “here’s the to-do list” → helpful, not commanding`;

const PROMPT_TITLE_NUANCED = `Refine the following article title for clarity while preserving the original religious meaning.

Tone & intent:
- Neutral, respectful, and precise
- Suitable for Islamic knowledge content
- Informational rather than engaging or conversational

Rules:
${PROMPT_TITLE_LENGTH}
- Preserve the original meaning exactly
- Keep Islamic terminology accurate
- Do NOT paraphrase Quranic wording
- Do NOT reinterpret Hadith meaning
- Do NOT introduce explanations not present in the title
- Do NOT add conclusions, lessons, or reflections
- Do NOT imply rulings, obligations, rewards, or sins
- Do NOT modernize theological language
- Avoid emotional or persuasive wording
- No clickbait, hype, or dramatic tone
- No emojis
- No rhetorical questions

Style guidance:
- Prefer clear descriptive phrasing
- Titles should read like an educational reference
- Avoid conversational language
- Avoid psychological or motivational framing
- If the original title already appears clear and accurate, keep it unchanged
- Minor shortening for readability is allowed only if meaning remains identical

Examples:
❌ "This Powerful Hadith Will Change Your Life"
✅ "Hadith on the Importance of Intention"

❌ "The Quran Teaches Us an Incredible Lesson About Patience"
✅ "Quranic Verses on Patience"

❌ "What Islam Says About Divorce Might Surprise You"
✅ "Islamic Rulings on Divorce in Classical Fiqh"`;

const PROMPT_TITLE_NEWS = `Refine the following news headline ONLY if necessary.

Refinement is allowed ONLY when:
- The headline exceeds ${MAX_ARTICLE_TITLE_LENGTH} characters
- OR it contains sensational, exaggerated, or clickbait wording

Do NOT:
- Change the factual meaning
- Add interpretation, conclusions, or opinions
- Add religious rulings
- Add emotional language
- Add new information
- Soften strong but factual wording

If the headline is already clear, factual, and within length limit:
Return it unchanged.

If shortening is required:
- Keep it under ${MAX_ARTICLE_TITLE_LENGTH} characters
- Preserve key facts (who/what/where)
- Remove unnecessary filler words`;

/**
 * Gets the appropriate rules based on content type
 * @param contentType - The content type from CONTENT_TYPES
 * @returns The appropriate rules string
 */
function getRulesForContentType(contentType?: ContentType): string {
  switch (contentType) {
    case CONTENT_TYPES['QURAN']:
    case CONTENT_TYPES['HADITH']:
      return RULES_QURAN_HADITH;
    case CONTENT_TYPES['FIQH']:
    case CONTENT_TYPES['SHARIA']:
      return RULES_FIQH_SHARIA;
    case CONTENT_TYPES['QA']:
      return RULES_QA;
    case CONTENT_TYPES['NEWS']:
      return RULES_NEWS;
    case CONTENT_TYPES['HISTORY']:
      return RULES_ARTICLE + '\n- Focus on historical context and significance';
    case CONTENT_TYPES['OPINION']:
      return RULES_ARTICLE + '\n- Note that this is an opinion piece';
    case CONTENT_TYPES['ARTICLE']:
    default:
      return RULES_ARTICLE;
  }
}

/**
 * Extracts content type flags for reuse across functions
 * @param contentType - The content type from CONTENT_TYPES
 * @param topic - Optional topic for specialized handling (e.g., 'seerah')
 * @returns Object with boolean flags for each content type
 */
export function getContentTypeFlags(contentType?: ContentType, topic?: ContentTopic | null) {
  const isQuran = contentType === CONTENT_TYPES.QURAN || topic === 'quran';
  const isHadith = contentType === CONTENT_TYPES.HADITH || topic === 'hadith';
  const isFiqh = contentType === CONTENT_TYPES.FIQH || topic === 'fiqh';
  const isSharia = contentType === CONTENT_TYPES.SHARIA || topic === 'sharia';
  const isAqeedah = topic === 'aqeedah';

  const isQnA = contentType === CONTENT_TYPES.QA;
  const isReflection = contentType === CONTENT_TYPES.REFLECTION || topic === 'reflection';
  const isOpinion = contentType === CONTENT_TYPES.OPINION || topic === 'opinion';
  const isNews = contentType === CONTENT_TYPES.NEWS || topic === 'news';

  const isHistory = contentType === CONTENT_TYPES.HISTORY || topic === 'history';
  const isSeerah = contentType === CONTENT_TYPES.SEERAH || topic === 'seerah';
  const isStory = contentType === CONTENT_TYPES.STORY;

  const isNuanced = isQuran || isHadith || isFiqh || isSharia || isAqeedah;

  return {
    isQnA,
    isHistory,
    isFiqh,
    isSharia,
    isReflection,
    isOpinion,
    isNews,
    isSeerah,
    
    /** Requiring careful interpretation */
    isFactual: isNews || isHistory || isSeerah,
    isEmotional: isReflection || isOpinion || isSeerah,
    isNarrative: isReflection || isStory,
    isNuanced,
    shouldPreserveQuotes: isNuanced || isSeerah,
  };
}

/**
 * Determines summary format based on content type and topic
 * @param flags - Content type flags from getContentTypeFlags
 * @returns Format string for summary
 */
function getSummaryFormat(contentType?: ContentType, topic?: ContentTopic): string {
  const {
    isQnA,
    isHistory,
    isFiqh,
    isSharia,
    isReflection,
    isNews,
    isSeerah
  } = getContentTypeFlags(contentType, topic);

  if (isHistory || isReflection || isSeerah) return 'narrative paragraph format';
  if (isFiqh || isSharia) return 'structured paragraph format';
  if (isQnA) return 'two paragraphs: Q: question (short) and A: answer';
  if (isNews) return 'single paragraph';
  return 'single paragraph or 3-4 bullet points if fits perfectly';
}

/**
 * Gets content type label for display purposes
 * @param contentType - The content type from CONTENT_TYPES
 * @returns Formatted content type label string
 */
function getContentTypeLabel(contentType?: ContentType): string {
  if (contentType === CONTENT_TYPES.QA) return 'Islamic Q&A';
  return `${contentType} text`;
}

/**
 * Validates if a raw AI summary contains blacklisted words that indicate poor quality
 * 
 * This function checks for common AI-generated summary patterns that indicate the summary
 * is not properly focused on the actual content, such as references to "the author"
 * or "the text" which suggest the AI is describing the process rather than summarizing.
 * 
 * @param summary - The raw summary text from AI to validate
 * @param context - Optional context for error logging (e.g., function name)
 * @returns True if summary is valid (no blacklisted words found), false if invalid
 */
function isValidRawSummary(summary: string, context?: string): boolean {
  const summaryLower = summary.toLowerCase();
  const foundBlacklistedWords: string[] = [];
  
  // Find all blacklisted words that appear in the summary
  for (const blacklistedWord of SUMMARY_BLACKLIST_WORDS) {
    if (summaryLower.includes(blacklistedWord)) {
      foundBlacklistedWords.push(blacklistedWord);
    }
  }
  
  // Log warning with specific words found
  if (foundBlacklistedWords.length > 0) {
    console.warn(`[${context ?? 'summary'}] ⚠️ Contains blacklisted words: "${foundBlacklistedWords.join(', ')}"`);
  }
  
  return foundBlacklistedWords.length === 0;
}

/**
 * Validates if a summary meets length requirements
 * 
 * @param summary - The summary text to validate
 * @param context - Optional context for error logging (e.g., function name)
 * @returns True if summary meets minimum and maximum length requirements, false otherwise
 */
function isValidSummary(summary: string, context?: string): boolean {
  const trimmedLength = summary.trim().length;
  const acceptableMaxLength = SUMMARY_MAX_LENGTH + SUMMARY_MAX_LENGTH_TOLERANCE;
  
  if (trimmedLength < SUMMARY_MIN_LENGTH) {
    console.log(`[${context ?? 'summary'}] ❌ Final check: TOO SHORT (${trimmedLength} < ${SUMMARY_MIN_LENGTH})`);
    return false;
  }
  
  if (trimmedLength > acceptableMaxLength) {
    console.log(`[${context ?? 'summary'}] ❌ Final check: TOO LONG (${trimmedLength} > ${acceptableMaxLength})`);
    return false;
  }
  
  console.log(`[${context ?? 'summary'}] ✅ Final check: VALID (${trimmedLength} characters)`);
  return true;
}

/**
 * Validates and processes a raw summary through the complete quality pipeline
 * 
 * This function handles the common pattern of validating raw summaries, post-processing,
 * and validating the final result. Used across multiple summarization functions.
 * 
 * @param summary - The raw summary text to validate and process
 * @param context - Optional context for error logging (e.g., function name)
 * @returns Processed summary text or null if validation fails at any stage
 */
function validateAndProcessSummary(summary: string, context?: string): string | null {
  // Skip invalid raw summary
  if (!isValidRawSummary(summary, context)) {
    return null;
  }

  // Post-process summary result to ensure quality
  const postProcessResult = postProcessSummary(summary, context);
  const finalSummary = postProcessResult.text;

  // Check processed summary validity
  if (!isValidSummary(finalSummary, context)) {
    return null;
  }

  return finalSummary;
}

/**
 * Gets the appropriate prompt based on content type
 * @param contentType - The content type from CONTENT_TYPES
 * @param topic - Optional topic for specialized handling (e.g., 'seerah')
 * @returns The appropriate prompt
 */
function getPromptForContentType(contentType?: ContentType, topic?: ContentTopic): string {
  // 1. Define format for the summary
  const { isQnA, isNarrative } = getContentTypeFlags(contentType);
  const format = getSummaryFormat(contentType, topic);
  
  // 2. Length specifications with context-aware guidance
  const maybeBulletPoints = format.includes('bullet points');
  const maxLengthPerLine = Math.ceil(SUMMARY_MAX_LENGTH / 3);
  const lengthRules = [
    `Overall output length: Target ${SUMMARY_MAX_LENGTH} characters total`,
    `Minimum output length: ${SUMMARY_MIN_LENGTH} characters total (more is better, ensuring clarity)`,
    maybeBulletPoints ? `If bullet points: Maximum ${maxLengthPerLine} characters each line` : ``,
    isQnA ? `Length proportion for Q&A: Q: 25%, A: 75%` : ``
  ];

  const narrativeRules = isNarrative ? `Narrative Perspective Rules:
- If the original text is written in first person (I, my, we), preserve first-person voice in the summary.
- Do NOT refer to "the author".
- Do NOT switch narrative perspective.
- Maintain the speaker's voice faithfully.
- Keep it natural and sincere.` : '';

  // 3. Build prompt components
  const contentTypeLabel = getContentTypeLabel(contentType);
  const task = `Summarization task:\nSummarize the following ${contentTypeLabel} as a concise digest in ${SUMMARY_WORD_COUNT} words (${format}).`;
  const rules = `Summarization rules:${getRulesForContentType(contentType)}`;
  const editorial = `Editorial rules:${RULES_EDITORIAL}`;
  const length = `Length specifications:\n- ${lengthRules.filter(Boolean).join('\n- ')}`;

  return [task, rules, editorial, narrativeRules, length].filter(Boolean).join(`\n\n`);
}

/**
 * Sanitizes text by removing title, boilerplate, and unwanted content for summarization
 * 
 * @param params - Summarizer parameters including text, title, and content type
 * @param options - Sanitization options
 * @returns Sanitized text ready for summarization
 * 
 * @description This function performs comprehensive text cleaning:
 * 1. Removes duplicate titles from content
 * 2. Removes RSS attribution boilerplate ("appeared first on", etc.)
 * 3. Removes website UI boilerplate ("cookie", "privacy policy", etc.)
 * 4. Removes footer patterns
 * 5. Handles edge cases and partial matches
 */
export function sanitizeArticleText(
  params: SummarizerParams,
  options: {
    removeBoilerplate?: boolean;
    maxBeginningDistance?: number;
    minLength?: number;
  } = {}
): string {
  const { text, title, contentType } = params;
  const {
    removeBoilerplate = true,
    maxBeginningDistance = Math.floor(text.length * 0.2), // 20% of article length
    minLength = Math.floor(MIN_ARTICLE_LENGTH * 0.2) // 20% of minimum article length
  } = options;
  
  let cleaned = text.trim();

  // 1️⃣ Remove duplicate title from content (sometimes articles include title unnecessarily)
  // Skip title removal for QA content as it often contains "Question:" in title
  if (title && title.trim() && contentType !== CONTENT_TYPES.QA) {
    const titleIndex = cleaned.indexOf(title);
    if (titleIndex !== -1) {
      // Check if title is positioned reasonably close to beginning
      const firstSentenceEnd = cleaned.indexOf('.');
      const isNearBeginning = titleIndex <= maxBeginningDistance;
      const isBeforeFirstSentence = firstSentenceEnd !== -1 && titleIndex <= firstSentenceEnd;
      
      if (isNearBeginning || isBeforeFirstSentence) {
        cleaned = cleaned.substring(titleIndex + title.length).trim();
      }
    }
  }

  // 2️⃣ Find and split on social sharing patterns at the beginning of article
  const possibleSeparators = ['Share Save'];
  
  // Find earliest separator within distance limit
  const earliestMatch = possibleSeparators
    .map(separator => ({
      separator,
      index: cleaned.indexOf(separator)
    }))
    .filter(({ index }) => index !== -1 && index < maxBeginningDistance)
    .sort((a, b) => a.index - b.index)[0];
  
  if (earliestMatch) {
    const afterSeparator = cleaned.substring(earliestMatch.index + earliestMatch.separator.length).trim();
    if (afterSeparator.length > MIN_ARTICLE_LENGTH) {
      cleaned = afterSeparator;
      console.log(`[sanitizeArticleText] Split content at "${earliestMatch.separator}", taking remaining ${cleaned.length} chars`);
    }
  }

  // 3️⃣ Remove boilerplate content if enabled
  if (removeBoilerplate) {
    // Remove RSS attribution, website boilerplate, and footer patterns for all content types
    // Biographical footers can incorrectly add seerah scoring even for Q&A content
    cleaned = removeBoilerplateText(cleaned, { rss: true, website: true, footer: true });
  }

  // 4️⃣ Clean up whitespace and normalize
  cleaned = cleaned
    .replace(/\s+/g, ' ')  // Normalize multiple spaces
    .replace(/\n\s*\n/g, '\n')  // Remove excessive line breaks
    .trim();

  // 5️⃣ Replaces all curly quotemarks with straight one
  cleaned = normalizeQuotemarks(cleaned);
  cleaned = convertSingleToDoubleQuotes(cleaned);

  // 5️⃣ Final validation
  if (cleaned.length < minLength) {
    console.warn(`[sanitizeArticleText] Text became too short after sanitization (${cleaned.length} < ${minLength}), returning original`);
    return text.trim();
  }

  return cleaned;
}

/**
 * Summarize text using wink-nlp with frequency-based scoring
 * @param text - The text to summarize
 * @param maxSentences - Maximum number of sentences in the summary (default: SUMMARY_SENTENCE_COUNT)
 * @returns Summarized text
 */
function winkSummarize(
  text: string,
  maxSentences = SUMMARY_SENTENCE_COUNT
): string {
  // 1. Early validation for short texts
  if (!text || text.trim().length < 40) return text;

  // 2. Process text with wink-nlp
  const doc = nlp.readDoc(text);

  // 3. Split into sentences
  const sentences = doc.sentences().out();

  // 4. Return original text if already within limit
  if (sentences.length <= maxSentences) {
    return text;
  }

  // 5. Build keyword frequency map from non-stop words
  const wordFrequencyMap = new Map<string, number>();

  doc.tokens()
    .filter(
      (token: any) =>
        token.out(its.type) === 'word' &&
        !token.out(its.stopWordFlag)
    )
    .each((token: any) => {
      const wordLemma = token.out(its.lemma).toLowerCase();
      wordFrequencyMap.set(wordLemma, (wordFrequencyMap.get(wordLemma) ?? 0) + 1);
    });

  // 6. Score each sentence based on word frequencies
  const scoredSentences = sentences.map(sentence => {
    const sentenceDoc = nlp.readDoc(sentence);
    let sentenceScore = 0;

    sentenceDoc.tokens()
      .filter((token: any) => token.out(its.type) === 'word')
      .each((token: any) => {
        const wordLemma = token.out(its.lemma).toLowerCase();
        sentenceScore += wordFrequencyMap.get(wordLemma) ?? 0;
      });

    return { sentence, score: sentenceScore };
  });

  // 7. Sort by score and select top sentences
  scoredSentences.sort((a, b) => b.score - a.score);

  // 8. Join selected sentences into summary
  return scoredSentences
    .slice(0, maxSentences)
    .map(sentenceObject => sentenceObject.sentence)
    .join(' ');
}

/**
 * Summarize text using natural library tokenizers with regex fallback
 * @summary Enhanced fallback summarization using modern NLP libraries
 * @param text - The text to summarize
 * @param maxSentences - Maximum number of sentences in the summary (default: SUMMARY_SENTENCE_COUNT)
 * @returns Summarized text
 */
function naturalSummarize(
  text: string,
  maxSentences = SUMMARY_SENTENCE_COUNT
): string {
  // 1. Early validation for short texts
  if (!text || text.trim().length < 40) return text;

  // 2. Use natural tokenizers if available, otherwise fallback to regex
  let sentences: string[];
  if (sentenceTokenizer && wordTokenizer) {
    try {
      sentences = sentenceTokenizer.tokenize(text);
    } catch (error) {
      console.warn('Natural tokenizers failed, falling back to regex:', getErrorMessage(error));
      sentences = splitSentencesRegex(text);
    }
  } else {
    sentences = splitSentencesRegex(text);
  }

  // 3. Return original text if already within limit
  if (sentences.length <= maxSentences) {
    return text;
  }

  // 4. Build word frequency map using natural tokenizers or regex fallback
  const wordFrequencyMap = new Map<string, number>();

  for (const sentence of sentences) {
    let words: string[];
    if (wordTokenizer) {
      try {
        words = wordTokenizer.tokenize(sentence.toLowerCase())
          .filter((word: string) => word.length > 3 && /^[a-zA-Z]+$/.test(word));
      } catch (error) {
        console.warn('Word tokenizer failed, using regex fallback:', getErrorMessage(error));
        words = splitWordsRegex(sentence);
      }
    } else {
      words = splitWordsRegex(sentence);
    }

    for (const word of words) {
      wordFrequencyMap.set(word, (wordFrequencyMap.get(word) ?? 0) + 1);
    }
  }

  // 5. Score sentences using utility function
  const scoredSentences = scoreSentences(sentences, wordFrequencyMap);

  // 6. Sort by score and select top sentences
  scoredSentences.sort((a: { sentence: string; score: number }, b: { sentence: string; score: number }) => b.score - a.score);

  // 7. Join selected sentences into summary
  return scoredSentences
    .slice(0, maxSentences)
    .map((sentenceObject: { sentence: string; score: number }) => sentenceObject.sentence.trim())
    .join(' ');
}

/**
 * NLP summarizer - frequency based using wink-nlp with natural and node-summarizer fallbacks
 * @summary Enhanced fallback summarization using modern NLP libraries
 * @param params - Summarizer parameters including text, title, and content type
 * @returns Summary result with status, text, and provider method
 */
async function nlpSummarize(params: SummarizerParams): Promise<SummaryResult> {
  // 1. Sanitize text before summarizing
  const sanitized = sanitizeArticleText(params);

  try {
    // 2. Try wink-nlp first (more advanced NLP)
    const winkSummary = winkSummarize(sanitized, SUMMARY_SENTENCE_COUNT);
    if (winkSummary && winkSummary.length >= SUMMARY_MIN_LENGTH) {
      console.log('Using wink-nlp for summarization');
      return { status: 'ok', output: winkSummary, sanitized, provider: 'wink' };
    }
  } catch (error) {
    console.warn('wink-nlp summarization failed, falling back to natural:', getErrorMessage(error));
  }

  try {
    // 3. Fallback to natural library
    const naturalSummary = naturalSummarize(sanitized, SUMMARY_SENTENCE_COUNT);
    if (naturalSummary && naturalSummary.length >= SUMMARY_MIN_LENGTH) {
      console.log('Using natural library for summarization');
      return { status: 'ok', output: naturalSummary, sanitized, provider: 'natural' };
    }
  } catch (error) {
    console.warn('Natural library summarization failed, falling back to node-summarizer:', getErrorMessage(error));
  }

  // 4. Check WordNet availability before using node-summarizer
  if (!isWordNetAvailable()) {
    throw new Error('WordNet database not available for node-summarizer');
  }

  // 5. Final fallback to original node-summarizer implementation
  console.log('Using node-summarizer as final fallback');
  const summarizer = new SummarizerManager(sanitized, SUMMARY_SENTENCE_COUNT);
  const summaryObject = await summarizer.getSummaryByRank();
  
  if (summaryObject instanceof Error) {
    throw summaryObject;
  }

  const { summary } = summaryObject;
  return { status: 'ok', output: summary, sanitized, provider: 'node' };
}

/**
 * Summarize text using Gemini AI API
 *
 * @param prompt - Built summarization prompt (system rules are prepended inside {@link geminiPrompt})
 * @param flags - Content flags; Q&A mode disables stop sequences that prevent multi-paragraph answers
 * @returns {@link AIResponse} or `null` if the model returns nothing or throws
 */
async function geminiSummarize(prompt: string, flags: ContentTypeFlags): Promise<AIResponse | null> {
  try {
    const summary = await geminiPrompt(prompt, { stopSequences: flags.isQnA ? undefined : ['\n\n'], context: 'summary' });
    if (!summary) {
      throw new Error('No summary returned from Gemini AI');
    }

    return summary;
  } catch {
    return null;
  }
}

/**
 * Summarize text using GitHub Models inference (OpenAI-compatible chat completions).
 *
 * Uses {@link githubPrompt} with the same stop-sequence behavior as {@link geminiSummarize}:
 * for standard (non–Q&A) content, passes `['\n\n']` to limit run-on output.
 *
 * @param prompt - Built summarization prompt for the article
 * @param flags - Content flags (QnA disables double-newline stop)
 * @returns {@link AIResponse} or `null` on failure
 */
async function githubSummarize(prompt: string, flags: ContentTypeFlags): Promise<AIResponse | null> {
  try {
    const summary = await githubPrompt(prompt, { stopSequences: flags.isQnA ? undefined : ['\n\n'], context: 'summary' });
    if (!summary) {
      throw new Error('No summary returned from GitHub Models');
    }

    return summary;
  } catch {
    return null;
  }
}

/**
 * Summarize text using Cohere AI Chat API V2
 * @param text - The text to summarize
 * @param prompt - Optional additional prompt for better context
 * @returns Generated summary text
 * 
 * @todo correct & refine jsdoc comment
 */
async function cohereSummarize(prompt: string, flags: ContentTypeFlags, document: AIDocument): Promise<AIResponse | null> {
  const { isNuanced, isQnA } = flags;
  const summary = await coherePrompt(
    prompt,
    {
      documents: [document], // Pass the text to be summarized as documents for grounding
      stopSequences: isQnA ? undefined : ['\n\n'], // Stop at double line break for non-Q&A content
      excludeModels: isNuanced ? ['command-r7b-12-2024'] : undefined, // Exclude older model for nuanced content
      context: 'summary'
    }
  );
  return summary;
}

/**
 * Summarize text using Cerebras AI
 * @param prompt - Built summarization prompt
 * @param flags - Content flags (QnA disables double-newline stop)
 * @returns AIResponse or null on failure
 */
async function cerebrasSummarize(prompt: string, flags: ContentTypeFlags): Promise<AIResponse | null> {
  try {
    const summary = await cerebrasPrompt(prompt, { stopSequences: flags.isQnA ? undefined : ['\n\n'], context: 'summary' });
    if (!summary) throw new Error('No summary returned from Cerebras');
    return summary;
  } catch {
    return null;
  }
}

/**
 * Summarize text using Mistral
 * @param prompt - Built summarization prompt
 * @param flags - Content flags (QnA disables double-newline stop)
 * @returns AIResponse or null on failure
 */
async function mistralSummarize(prompt: string, flags: ContentTypeFlags): Promise<AIResponse | null> {
  try {
    const summary = await mistralPrompt(prompt, { stopSequences: flags.isQnA ? undefined : ['\n\n'], context: 'summary' });
    if (!summary) throw new Error('No summary returned from Mistral');
    return summary;
  } catch {
    return null;
  }
}

/**
 * Summarize text using NVIDIA NIM
 * @param prompt - Built summarization prompt
 * @param flags - Content flags (QnA disables double-newline stop)
 * @returns AIResponse or null on failure
 */
async function nvidiaSummarize(prompt: string, flags: ContentTypeFlags): Promise<AIResponse | null> {
  try {
    const summary = await nvidiaPrompt(prompt, { stopSequences: flags.isQnA ? undefined : ['\n\n'], context: 'summary' });
    if (!summary) throw new Error('No summary returned from NVIDIA NIM');
    return summary;
  } catch {
    return null;
  }
}

/**
 * Summarize text using Groq AI API
 * @param text - The text to summarize
 * @param prompt - Optional additional prompt for better context
 * @returns Generated summary text
 */
async function groqSummarize(prompt: string, flags: ContentTypeFlags): Promise<AIResponse | null> {
  try {
    const summary = await groqPrompt(prompt, { stopSequences: flags.isQnA ? undefined : ['\n\n'], context: 'summary' });
    if (!summary) {
      throw new Error('No summary returned from Groq API');
    }

    return summary;
  } catch {
    return null;
  }
}

/**
 * Summarize text using HuggingFace AI API
 * @param text - The text to summarize
 * @returns Generated summary text
 */
async function huggingFaceSummarize(text: string, flags: ContentTypeFlags): Promise<AIResponse | null> {
  const hf = getHfClient();

  // Try models in fallback order
  const models = SUMMARIZER_MODELS['huggingface'];

  // Build text to summarize
  const maxArticleLength = MAX_ARTICLE_LENGTH['huggingface'];
  const truncationResult = truncateToSentence(text, maxArticleLength, { preserveQuotes: flags.shouldPreserveQuotes });
  const textToSummarize = truncationResult.text;
  if (truncationResult.wasTruncated) {
    console.log(`[huggingface] ✂️ Truncated to maxArticleLength: ${maxArticleLength} (original length: ${text.length})`);
  }

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    if (model === 'philschmid/bart-large-cnn-samsum' && !flags.isQnA) continue;
    
    try {
      console.log(`[huggingface] 🤗 Trying model:`, model);

      // Apply rate limiting before API call
      await getHuggingfaceLimiter().throttle();
      
      const summaryResponse = await hf.summarization({
        model,
        inputs: textToSummarize,
        parameters: {
          temperature: MAX_TEMPERATURE['huggingface'], // Ignored when do_sample=false
          max_length: MAX_OUTPUT_TOKEN['huggingface'],
          min_length: 80,            // Minimum ~60 words
          num_beams: 6,              // Better sentence completion quality
          no_repeat_ngram_size: 3,   // Prevents repeating 3-word phrases
          do_sample: false,          // Deterministic for consistency
          early_stopping: false,     // Let beams complete naturally
          length_penalty: 1.2        // Encourages complete sentences
        }
      });

      const rawSummary = summaryResponse.summary_text?.trim();
      if (!rawSummary) {
        throw new Error('No summary');
      }

      const summary = rawSummary.split('appeared first on')[0].trim();
      if (summary.length < SUMMARY_MIN_LENGTH) {
        throw new Error('Summary length is too short');
      }

      logAISuccess({ provider: 'huggingface', model, output: summary });
      return { provider: 'huggingface', model, output: summary };
    } catch (error) {
      logAIFailure('huggingface', model, getErrorMessage(error));
      if (i === models.length - 1) {
        console.error('[huggingface] ❌ All models failed');
        return null;
      }
    }
  }

  return null;
}

/**
 * 
 * @param result 
 * @param sanitized 
 * @returns 
 * 
 * Note: `null` means we should try to summarize again with next provider in fallback order
 */
function checkSummaryResult(result: AIResponse, sanitized: string): SummaryResult | null {
  const { output: summary, provider, model } = result;

  // Early returns
  if (!summary) {
    console.warn(`[${provider}] ⚠️ Summarization is currently unavailable. Falling back to alternative methods...`);
    return null;
  }
  if (summary === "SUMMARY_REQUIRES_REVIEW") {
    console.warn(`[${provider}] ⚠️ Summarization flagged content for human review.`);
    return { status: 'requires_review', output: '', sanitized, provider };
  }
  if (summary === "SUMMARY_UNAVAILABLE") {
    console.warn(`[${provider}] ⚠️ Summarization is unavailable for this content.`);
    return { status: 'unavailable', output: '', sanitized, provider };
  }
  
  // Check summary length
  if (summary.length < SUMMARY_MIN_LENGTH) {
    console.warn(`[${provider}] ⚠️ Summarization is too short. Falling back to alternative methods...`);
    return null;
  }

  // Check whether summary result is complete
  const isSummaryComplete = isSentenceComplete(summary);
  if (!isSummaryComplete) {
    console.log(`[${provider}] ⚠️ Generated truncated summary (${summary.length} chars), falling back...`);
    return null;
  }

  // Validate and process summary through quality pipeline
  const finalSummary = validateAndProcessSummary(summary, provider);
  if (!finalSummary) return null;

  return { status: 'ok', output: finalSummary, sanitized, provider, model };
}

/**
 * Attempts to summarize text using a specific AI provider with proper error handling and fallback logic
 * @param provider - The AI provider to use
 * @param sanitized - Sanitized text for summary
 * @param summarizeFn - Function that performs the summarization
 * @returns Summary result or null if unsuccessful
 * 
 * Note: `null` means we should try to summarize again with next provider in fallback order
 */
async function tryAISummarizer(
  provider: SummaryProvider,
  sanitized: string,
  summarizeFn: () => Promise<AIResponse | null>
): Promise<SummaryResult | null> {
  const canUse = provider !== 'none' && (STANDARD_SUMMARY_SOURCES.includes(provider) || await canUseAIToday(provider as AIProvider));
  if (!canUse) return null; // Daily AI limit reached. Using next fallback method...

  try {
    const summaryResult = await summarizeFn();
    if (!summaryResult) return null;
    return checkSummaryResult(summaryResult, sanitized);
  } catch (error) {
    console.error(`[${provider}] ❌ Error during summarization:`, getErrorMessage(error));
    return null;
  }
}

/** Content type flags for content analysis */
type ContentTypeFlags = ReturnType<typeof getContentTypeFlags>;

/**
 * Unified interface for AI summarizer functions
 * All wrapper functions conform to this signature
 */
type UnifiedSummarizerFn = (prompt: string, flags: ContentTypeFlags, document: AIDocument) => Promise<AIResponse | null>;

/**
 * Wrapper functions to normalize different provider signatures
 */
const unifiedSummarizers = {
  github: (prompt: string, flags: ContentTypeFlags, _document: AIDocument) => githubSummarize(prompt, flags),
  gemini: (prompt: string, flags: ContentTypeFlags, _document: AIDocument) => geminiSummarize(prompt, flags),
  cohere: (prompt: string, flags: ContentTypeFlags, document: AIDocument) => cohereSummarize(prompt, flags, document),
  groq: (prompt: string, flags: ContentTypeFlags, _document: AIDocument) => groqSummarize(prompt, flags),
  huggingface: (prompt: string, flags: ContentTypeFlags, _document: AIDocument) => huggingFaceSummarize(prompt, flags),
  mistral: (prompt: string, flags: ContentTypeFlags, _document: AIDocument) => mistralSummarize(prompt, flags),
  cerebras: (prompt: string, flags: ContentTypeFlags, _document: AIDocument) => cerebrasSummarize(prompt, flags),
  nvidia: (prompt: string, flags: ContentTypeFlags, _document: AIDocument) => nvidiaSummarize(prompt, flags),
} satisfies Record<AIChatProvider, UnifiedSummarizerFn>;

/**
 * Configuration for AI summarization providers in fallback order (highest quality first)
 * 
 * AI Summarizer Ranking (Quality-wise)
 * 1. GitHub Models (GPT-4o)                            9.5 (S)
 * 2. Gemini (Gemini 2.5 Flash)                         9.0-9.2 (S)
 * 3. Cohere (Command-R-08-2024) (35B) + Chat API V2    8.5-8.8 (A)
 * 4. Mistral (Mistral Large 3)                         8.5-8.8 (A)
 * 5. Groq (Llama 3.3 70B)                              8.0 (B)
 * 6. Cerebras (Llama 3.3 70B)                          8.0 (B)
 * 7. NVIDIA NIM (Llama 3.3 70B / Mistral Large)        8.0 (B)
 * 8. Hugging Face (facebook/bart-large-cnn)            6.5 (C)
 * 
 * Groq/Cerebras/NVIDIA NIM = same quality (Tier B)
 * 1. Cerebras = fastest engine (bulk output speed)
 * 2. Groq = fastest reaction time (chat responsiveness)
 * 3. NVIDIA = most general-purpose, but slowest per request
 * 
 * @todo add Mistral, Cerebras, NVIDIA NIM
 */
const AI_SUMMARIZERS = [
  { provider: 'github' as SummaryProvider, fn: unifiedSummarizers.github },
  { provider: 'gemini' as SummaryProvider, fn: unifiedSummarizers.gemini },
  { provider: 'cohere' as SummaryProvider, fn: unifiedSummarizers.cohere },
  { provider: 'mistral' as SummaryProvider, fn: unifiedSummarizers.mistral },
  { provider: 'groq' as SummaryProvider, fn: unifiedSummarizers.groq },
  { provider: 'cerebras' as SummaryProvider, fn: unifiedSummarizers.cerebras },
  { provider: 'nvidia' as SummaryProvider, fn: unifiedSummarizers.nvidia },
  { provider: 'huggingface' as SummaryProvider, fn: unifiedSummarizers.huggingface },
] as const;

/**
 * Finds the optimal provider for a given article length
 * @param sanitized - The text to summarize
 * @param exclude - Array of providers to exclude
 * @returns Optimal provider configuration or null if none available
 */
function findOptimalProvider(sanitized: string, exclude: SummaryProvider[]): typeof AI_SUMMARIZERS[0] | null {
  // Filter out excluded providers
  const availableProviders = AI_SUMMARIZERS.filter(p => !exclude.includes(p.provider));
  if (availableProviders.length === 0) return null;

  // For foreign languages, prefer strongest chat models (github → gemini → …) and exclude huggingface
  if (isForeignLanguage(sanitized)) {
    const foreignExclude = [...exclude, 'huggingface'];
    const foreignProviders = AI_SUMMARIZERS.filter(p => !foreignExclude.includes(p.provider));
    if (foreignProviders.length === 0) return null;
    
    // For foreign content, return the best available provider (order matches AI_SUMMARIZERS)
    return foreignProviders[0];
  }

  // Find the provider with the smallest max limit that can still handle the article
  // This ensures we use the most "appropriate" provider for the article size
  for (const provider of availableProviders) {
    const maxLimit = MAX_ARTICLE_LENGTH[provider.provider];
    if (sanitized.length <= maxLimit) {
      return provider;
    }
  }
  
  // If article is too long for all providers, return the one with highest limit
  return availableProviders.reduce((best, current) => 
    MAX_ARTICLE_LENGTH[current.provider] > MAX_ARTICLE_LENGTH[best.provider] ? current : best
  );
}

/**
 * Gets bidirectional fallback providers when optimal provider fails
 * Tries both higher quality (if available) and lower quality providers
 * @param failedProvider - The provider that failed
 * @param exclude - Array of providers to exclude
 * @returns Array of fallback providers in optimal order
 */
function getBidirectionalFallbackProviders(failedProvider: SummaryProvider, exclude: SummaryProvider[]): Array<typeof AI_SUMMARIZERS[0]> {
  const failedIndex = AI_SUMMARIZERS.findIndex(p => p.provider === failedProvider);
  if (failedIndex === -1) return [];
  
  const fallbackProviders: Array<typeof AI_SUMMARIZERS[0]> = [];
  
  // Try higher quality providers first (those before the failed one)
  for (let i = failedIndex - 1; i >= 0; i--) {
    const provider = AI_SUMMARIZERS[i];
    if (!exclude.includes(provider.provider)) {
      fallbackProviders.push(provider);
    }
  }
  
  // Then try lower quality providers (those after the failed one)
  for (let i = failedIndex + 1; i < AI_SUMMARIZERS.length; i++) {
    const provider = AI_SUMMARIZERS[i];
    if (!exclude.includes(provider.provider)) {
      fallbackProviders.push(provider);
    }
  }
  
  return fallbackProviders;
}

/**
 * Extractive summarization using standard NLP-based methods in priority order
 * This is the fallback chain when AI summarizers are unavailable or fail
 * 
 * @param params - Summarizer parameters including text, title, and content type
 * @returns Summary result with status, text, and provider, or null
 */
export async function standardSummarize(params: SummarizerParams): Promise<SummaryResult | null> {
  try {
    const nlpResult = await nlpSummarize(params);
    const summary = nlpResult.output;

    console.log(`[${nlpResult.provider}] ✅ Successfully generated summary (${summary.length} chars)\n"""\n${summary}\n"""`);

    // Validate and process summary through quality pipeline
    const finalSummary = validateAndProcessSummary(summary, nlpResult.provider);
    if (!finalSummary) return null;

    return { ...nlpResult, output: finalSummary };
  } catch (error) {
    console.error('❌ NLP summarization error:', getErrorMessage(error));
  }
  
  console.warn('❓ No summary, every NLP summarizer has failed');
  return null;
}

/**
 * Builds a context-aware prompt for summarization based on content type and title
 * @param params - Summarizer parameters including text, title, content type, and provider
 * @param includeTexts - Whether to include text in the prompt
 * @returns The prompt string or null if insufficient
 */
function buildSummarizePrompt(params: SummarizerParams & { provider: SummaryProvider, contentTypeFlags: ContentTypeFlags }, includeTexts: boolean = true): string | null {
  const { contentType, publishedAt, title, text, topic, provider, videoUrl, videoTitle, videoDuration, contentTypeFlags } = params;
  const { isQnA, shouldPreserveQuotes: preserveQuotes } = contentTypeFlags;
  
  // 1. Get base prompt for content type
  const summarizePrompt = getPromptForContentType(contentType, topic);
  
  // 2. Add special handling for QA content and content quality warning
  const qualityWarning = isQnA
    ? 'This is a Q&A format. Focus on the core question and answer, preserving key Islamic terminology.'
    : `If the content is ambiguous, controversial, completely unrelated to Islamic topics, or lacks scholarly attribution,
respond with exactly:
"SUMMARY_REQUIRES_REVIEW"

If the content is outdated, short-term, localized, or unsuitable for global Muslim readers (e.g., local event invitation, local announcement, advertisement, promotion, app or website feature information),
respond with exactly:
"SUMMARY_UNAVAILABLE"`;

  // 3. Build review instruction — gives AI specific things to check
  // Most effective single-pass technique
  const review = containsRelativeTime(text) || NEED_OUTPUT_REVIEW.includes(provider);
  const reviewInstruction = review ? `Otherwise, work in two silent steps (important):
STEP 1 — Draft: Write summary following all rules above.
STEP 2 — Review & Fix: Verify your draft against this checklist:
  □ Does my summary include timing/when information?
    → If YES: Check if the original article has temporal qualifiers (e.g., "the night before", "on the first day", "during", "after X days")
    → If the original has qualifiers but my summary doesn't: ADD THEM BACK
  □ Could any sentence be misunderstood to mean something happening NOW or TODAY?
    → If YES: Add clarifying context
  □ Could any sentence be misunderstood in multiple ways?
    → If YES: Add clarifying context until only ONE interpretation is possible
  □ Are there any Islamic timing/scheduling statements that could confuse readers?
    → If YES: Make them crystal clear with full context
  □ Could the timing be misunderstood based on when it's read?
    → If YES: REWRITE to be event-relative or omit time reference
  □ Does "this [event]" refer to a specific year/occurrence?
    → If unclear: Add the year or make it generic (e.g. "during Ramadan" not "this Ramadan")
  □ Does my summary contain phrases like "the author", "the text", "the article"?
    → If YES: Remove ALL meta-commentary and focus on the actual content
  Then silently fix any issues.
OUTPUT: Final corrected summary only. No explanations, no labels, no preamble.` : '';

  const maxPromptLength = MAX_PROMPT_LENGTH[provider];
  
  let titleSection = '';
  let timeSection = '';
  let videoSection = '';
  let textSection = '';

  // 4. Build complete prompt
  const getCombinedPrompt = (): string => [summarizePrompt, qualityWarning, reviewInstruction, titleSection, timeSection, videoSection, textSection].filter(Boolean).join('\n\n');

  if (includeTexts) {
    titleSection = title ? `Content title: "${title}"` : '';
    timeSection = publishedAt ? `Published at: ${publishedAt}\nToday date: ${getTodayDate()}` : '';
    videoSection = videoUrl ? [
      `This article contains a video:`,
      videoTitle ? `Video Title: "${videoTitle}"` : '',
      videoDuration ? `Video Duration: ${videoDuration}s` : '',
      `Video URL: ${videoUrl}`
    ].filter(Boolean).join('\n- ') : '';
  
    // 5. Text to summarize with dynamic length management
    const basePromptLength = getCombinedPrompt().length;
    let currentMaxArticleLength = MAX_ARTICLE_LENGTH[provider] - basePromptLength;
    let textToSummarize = text;
    
    // Iteratively truncate until prompt fits within max length
    let attempts = 0;
    
    while (attempts < TRUNCATION_CONSTANTS.MAX_TRUNCATION_ATTEMPTS) {
      const truncationResult = truncateToSentence(textToSummarize, currentMaxArticleLength, { preserveQuotes });
      textSection = `Text to summarize:\n"""\n${truncationResult.text}\n"""`;
      
      // Build final result using cached base elements + new text section
      const result = getCombinedPrompt();
      
      if (result.length <= maxPromptLength) {
        if (truncationResult.wasTruncated) {
          console.log(`[${provider}] ✂️ Truncated to maxArticleLength: ${currentMaxArticleLength} (original length: ${text.length})`);
        }
        // Log the final prompt before returning
        logAIPrompt(provider, result, maxPromptLength, PROMPT_SYSTEM);
        return result;
      }
      
      // If still too long, reduce max article length and try again
      const excessive = result.length - maxPromptLength;
      const previousLength = currentMaxArticleLength;
      
      // Calculate reduction amount with minimum guarantee of progress
      const reductionAmount = Math.max(
        TRUNCATION_CONSTANTS.LENGTH_REDUCTION_BUFFER,
        Math.ceil(excessive / 2) // Ensure at least 50% reduction of excess
      );
      
      currentMaxArticleLength = Math.max(
        TRUNCATION_CONSTANTS.MIN_FALLBACK_LENGTH, 
        currentMaxArticleLength - reductionAmount
      );
      
      // Prevent infinite loop by ensuring we're making significant progress
      if (currentMaxArticleLength <= TRUNCATION_CONSTANTS.MIN_FALLBACK_LENGTH || 
          currentMaxArticleLength >= previousLength) {
        console.warn(`[${provider}] ⚠️ Reached minimum fallback length or no progress made, breaking truncation loop`);
        break;
      }
      
      textToSummarize = truncationResult.text;
      attempts++;
    }
    
    // Fallback: skip summarization
    console.log(`[${provider}] ⚠️ Decided to skip summarization after ${attempts + 1} attempts`);
    return null;
  }
  
  const finalPrompt = getCombinedPrompt();
  logAIPrompt(provider, finalPrompt, maxPromptLength, PROMPT_SYSTEM);
  return finalPrompt;
}

/**
 * Attempts AI summarizers in fallback order with smart filtering based on article length
 * Uses bidirectional fallback: tries optimal provider first, then falls back both up and down the quality ladder
 * @param params - Summarizer parameters including text, title, and content type
 * @param options - Optional configuration for AI summarization behavior
 * @returns Summary result with status, text, and provider
 */
export async function aiSummarize(
  params: SummarizerParams,
  options?: AISummarizeOptions
): Promise<SummaryResult | null> {
  const { text: sanitized, title, contentType, topic } = params;
  const { exclude = [], enableNLP = true } = options || {};

  const contentTypeFlags = getContentTypeFlags(contentType, topic);
  
  // Find the optimal provider based on article length
  const optimalProvider = findOptimalProvider(sanitized, exclude);
  if (!optimalProvider) {
    console.log('⏭️ No suitable providers available (all excluded)');
    return { status: 'unavailable', output: sanitized, sanitized, provider: 'none' };
  }

  console.log(`🎯 Optimal provider for ${sanitized.length} chars: ${optimalProvider.provider}`);
  
  // Try optimal provider first
  const includeTexts = optimalProvider.provider !== 'cohere';
  const prompt = optimalProvider.provider === 'huggingface' ? sanitized : buildSummarizePrompt({...params, provider: optimalProvider.provider, contentTypeFlags}, includeTexts);
  // Fallback to next provider when failed generate sufficent prompt
  if (prompt != null) {
    const result = await tryAISummarizer(optimalProvider.provider, sanitized, () => 
      optimalProvider.fn(prompt, contentTypeFlags, {title, text: sanitized})
    );
    if (result) return result;
  }

  // If optimal fails, try bidirectional fallback: both higher and lower quality providers
  const fallbackProviders = getBidirectionalFallbackProviders(optimalProvider.provider, exclude);
  console.log(`🔄 ${optimalProvider.provider} failed, trying bidirectional fallback: ${fallbackProviders.map(p => p.provider).join(' → ')}`);
  
  for (const { provider, fn } of fallbackProviders) {
    const includeTexts = provider !== 'cohere';
    const prompt = provider === 'huggingface' ? sanitized : buildSummarizePrompt({...params, provider, contentTypeFlags}, includeTexts);
    if (prompt == null) continue; // Fallback to next provider when failed generate sufficent prompt
    const result = await tryAISummarizer(provider, sanitized, () => 
      fn(prompt, contentTypeFlags, {title, text: sanitized})
    );
    if (result) return result;
  }

  if (enableNLP) return null; // Fallback to NLP-based extractive summarization

  return { status: 'unavailable', output: sanitized, sanitized, provider: 'none' };
}

/**
 * Smart summarization that tries AI first, then falls back to NLP-based methods
 * Follows this summarization hierarchy:
 * 🧠 Gemini AI (primary, with daily quotas)
 * 🚀 Groq AI (fallback when Gemini unavailable)
 * 🤖 Cohere AI (fallback when Groq is unavailable)
 * 🤗 HuggingFace AI (fallback when Cohere is unavailable)
 * 📊 NLP-based (extractive summarization)
 * 🔧 Heuristic (final fallback)
 * 
 * @param params - Summarizer parameters including text, title, and content type
 * @param options - Optional configuration for summarization behavior
 * @returns Summary result with status, text, and provider
 */
export async function smartSummarize(
  params: SummarizerParams,
  options?: AISummarizeOptions
): Promise<SummaryResult> {
  const { enableNLP = true } = options || {};

  // 1. Sanitize text before summarizing
  const sanitized = sanitizeArticleText(params);

  // 2. Skip summarization if sanitized length is already short
  if (sanitized.length <= SUMMARY_MAX_LENGTH) {
    if (params.videoUrl || params.contentType === CONTENT_TYPES.HADITH) { // Allow short article text for video or hadith content
      console.log('⏭️ Summarization skipped: Article length is already within limit, no need to summarize');
      return { status: 'ok', output: sanitized, sanitized, provider: 'none' };
    } else { // Too short for pure article content
      console.log('⚠️ Summarization skipped: Article length is too short');
      return { status: 'unavailable', output: '', sanitized, provider: 'none' };
    }
  }

  // 3. Try AI summarizers in fallback order with smart filtering based on article length
  const aiResult = await aiSummarize(params, options);
  if (aiResult != null) return aiResult;

  // 4. Fall back to standard NLP summarization methods
  if (enableNLP) {
    const nlpResult = await standardSummarize(params);
    if (nlpResult != null) return nlpResult;
  }

  return { status: 'unavailable', output: sanitized, sanitized, provider: 'none' };
}

/**
 * Validates and sanitizes AI-generated text with proper error handling
 */
function validateAndProcessText(
  text: string | null | undefined,
  maxLength: number,
  options: { context: string; tolerance?: number }
): string | undefined {
  if (!text?.trim()) return undefined;
  
  const validation = validateAndSanitizeAIText(text.trim(), maxLength, options);
  return validation.isValid ? validation.processedText : undefined;
}

/**
 * Generates enhanced article metadata using AI for Islamic content presentation
 * 
 * This function intelligently enhances Islamic articles by generating up to three types
 * of metadata based on content analysis and type:
 * 1. Title Refinement: Improves article titles for clarity, warmth, and Muslim audience appropriateness.
 * 2. Hook Generation: Creates attention-grabbing, engaging hooks tailored to each content types (hadith, fiqh, seerah, etc.).
 * 3. Context Generation: Provides relevant contextual explanation for article.
 * 
 * Context-awareness:
 * - Applies content-type-specific prompts for optimal results
 * - Only refines titles and generating hooks/context when necessary
 * - May generate all three types based on analysis
 * 
 * Validation & Safety:
 * - Applies Islamic terminology corrections and safety validations
 * - Applies length limits and tolerance checks
 * - Returns original title as fallback if generation fails
 * - Logs all generation activities for monitoring
 * - Implements robust error handling with fallbacks
 * 
 * @param title - The original article title to potentially refine
 * @param contentType - Content type from `CONTENT_TYPES` (e.g., 'hadith', 'fiqh', 'seerah', 'news')
 * @param summary - The generated article summary used as context for generation
 * @returns Promise resolving to enhanced article metadata
 * 
 * @returns {title} Enhanced title (original if refinement skipped or failed)
 * @returns {hook} Generated hook for engagement (null if skipped for nuanced content)
 * @returns {context} Generated explanatory context (null if skipped for nuanced content)
 * 
 * @example
 * ```typescript
 * const result = await generateContext(
 *   "Prophet's Journey",
 *   "seerah", 
 *   "The story of Hijrah from Mecca to Medina..."
 * );
 * // Returns: { 
 * //   title: "The Hijrah: Prophet's Journey to Medina", 
 * //   hook: "Three days hiding in cave changed Islamic history forever",
 * //   context: "The Hijrah marks the beginning of Islamic calendar..."
 * // }
 * ```
 */
export async function generateContext(summaryDetail: SummaryDetail): Promise<SummaryContext> {
  const { title, contentType, topicPrimary, summary } = summaryDetail;
  const originalContentType = contentType || CONTENT_TYPES.ARTICLE;
  const { isNews, isNuanced } = getContentTypeFlags(originalContentType);
  const originalTitle = title?.trim() || '';
  
  // CIS-based context generation: Calculate Context Importance Score (heuristic)
  const cisScore = computeContextImportance(summaryDetail);
  
  // Generate context if CIS meets threshold
  const shouldGenerateContext = cisScore >= CONTEXT_GENERATION_THRESHOLD;

  // Determine content type if not Q&A
  const shouldDetermineType = originalContentType !== CONTENT_TYPES.QA;
  
  // Log CIS decision for monitoring
  if (shouldGenerateContext) {
    console.log(`[ingest] 🧩 Should generate context (CIS: ${cisScore.toFixed(1)} >= ${CONTEXT_GENERATION_THRESHOLD})`);
  } else {
    console.log(`[ingest] ⏩ Skipping context generation (CIS: ${cisScore.toFixed(1)} < ${CONTEXT_GENERATION_THRESHOLD})`);
  }

  const shouldRefineTitle = (() => {
    if (!originalTitle) return false;
    if (isNews || isNuanced) return needsTitleRefinement(originalTitle);
    return true;
  })();

  const expectedOutput = {
    ...(shouldRefineTitle ? {"title": "Refined Display Title"} : {}),
    "hook": "Generated hook for the article (null if skipped)",
    ...(shouldGenerateContext ? {"context": "Generated context for the article (null if skipped)"} : {}),
    ...(shouldDetermineType ? {"type": `Detected content type (one of: '${Object.values(CONTENT_TYPES).join("', '")}')`} : {}),
    "keywords": "Relevant topic or keywords (array of strings, lowercase, minimum but accurate, e.g. ['fiqh', 'quran', 'history', etc])"
  };

  const reviewInstruction = `Review & Fix:
Before outputting, self-check and fix silently, ensure:
□ Respectful and suitable for Muslim
□ Represent the context perfectly
□ Temporal context preserved ("night before", "after one year")
□ No relative time (tomorrow, recently, tonight, etc.)
□ Use correct Islamic terms (not Western)
□ Should not provide religious rulings
□ No opinion or giving advice
□ Quran or Hadith should not be paraphrased`;

  // Build prompt
  const outputRules = `Output:\nRespond with parseable JSON string format exactly (important):\n${JSON.stringify(expectedOutput, null, 2)}`;
  const promptTitle = isNews ? PROMPT_TITLE_NEWS : isNuanced ? PROMPT_TITLE_NUANCED : PROMPT_TITLE;
  const promptHook = buildHookPrompt(originalContentType);
  const prompt = [
    ...[
      shouldRefineTitle ? `(title): ${promptTitle}` : '',
      `(hook): ${promptHook}`,
      shouldGenerateContext ? `(context): ${buildContextPrompt(originalContentType, cisScore)}` : '',
    ].filter(Boolean).map((task, n) => `Task ${n + 1} ${task}`),
    outputRules,
    reviewInstruction,
    // contentType ? `Content type: ${contentType} (heuristic, uncertain, correct it in "type" output)` : '',
    `Original title: "${originalTitle}"`,
    `Summary: "${summary}"`
  ].filter(Boolean).join('\n\n');

  const logContext = 'ingest';

  // Try to get the result from AI
  try {
    // Reserve Gemini for summarizing article text
    const response = await aiPrompt(prompt, { excludeProviders: TIER_S_PROVIDERS, context: 'context' });

    // Parse JSON response to extract title, hook, and context
    const parsedResult = parseAISafely<SummaryContext>(response, 'title', {
      logContext,
      maxLength: 5000,
      allowPartialObjects: true
    });

    // Parse keywords array
    let processedKeywords: string[] = [];
    if (parsedResult.keywords) {
      try {
        processedKeywords = combineItems([parsedResult.keywords]);
      } catch {
        console.warn(`[${logContext}] ⚠️ Cannot parse detected keywords:`, parsedResult.keywords);
      }
    }

    // Extract and validate all generated fields
    const processedTitle = validateAndProcessText(parsedResult.title, MAX_ARTICLE_TITLE_LENGTH, { context: 'title', tolerance: 10 });
    const processedHook = validateAndProcessText(parsedResult.hook, SUMMARY_MAX_HOOK_LENGTH, { context: 'hook' });
    const processedContext = validateAndProcessText(parsedResult.context, SUMMARY_MAX_CONTEXT_LENGTH, { context: 'context' });
    const processedContentType = validateAndProcessText(parsedResult.type, 20, { context: 'content_type' });
    const processedTopic = getTopicFromKeywords(processedKeywords);

    // Log successful generations
    if (processedTitle && processedTitle !== originalTitle) console.log(`[${logContext}] Generated display title: "${processedTitle}" (original: "${originalTitle}")`);
    if (processedHook) console.log(`[${logContext}] Generated hook: "${processedHook}"`);
    if (processedContext) console.log(`[${logContext}] Generated context: "${processedContext}"`);
    if (processedContentType && processedContentType != originalContentType) console.log(`[${logContext}] Detected content type: "${originalContentType}" → "${processedContentType}"`);
    if (processedTopic && processedTopic != topicPrimary) console.log(`[${logContext}] Detected topic: "${topicPrimary}" → "${processedTopic}"`);
    if (processedKeywords.length > 0) console.log(`[${logContext}] Detected keywords:`, processedKeywords);

    return {
      title: replaceIslamicTerms(processedTitle || originalTitle),
      hook: processedHook,
      context: processedContext,
      type: processedContentType,
      keywords: processedKeywords,
      topic: processedTopic,
    };
  } catch (error) {
    console.error(`[${logContext}] ❌ AI context generation failed:`, error);
    return { title: originalTitle };
  }
}

/**
 * Builds a content-type-specific prompt for generating engaging hooks
 * 
 * Creates tailored prompts that guide AI to generate attention-grabbing hooks
 * while maintaining Islamic content standards and safety protocols.
 * 
 * @param contentType - Content type from CONTENT_TYPES (e.g., 'hadith', 'fiqh', 'seerah')
 * @returns Comprehensive prompt string with:
 *   - Content-specific guidance and style instructions
 *   - Safety rules for sensitive Islamic topics
 *   - Length requirements and examples
 *   - Quality guidelines and bad examples to avoid
 */
function buildHookPrompt(contentType: ContentType): string {
  // 1. Define guidance prompts
  const hookGuidance: Record<ContentType, string> = {
    hadith: 'Focus on the wisdom or reward mentioned in the hadith',
    seerah: 'Highlight a pivotal moment or dramatic detail from the story',
    fiqh: 'Use a clear factual statement, avoid sensationalism',
    virtue: 'Emphasize the specific reward or spiritual benefit',
    story: 'Create suspense or highlight the most compelling moment',
    knowledge: 'Pose an intriguing fact or surprising revelation',
  };

  // 2. Define style prompts
  const hookStyle: Record<ContentType, string> = {
    hadith: 'Direct quote from hadith OR statement of its benefit',
    seerah: 'Vivid narrative detail that creates curiosity',
    fiqh: 'Clear factual statement of the ruling or principle',
    virtue: 'Specific reward or benefit in measurable terms',
    story: 'Pivotal moment or surprising detail',
    knowledge: 'Surprising fact or intriguing question',
  };

  // 3. Define Safety rules by content type
  const { isNuanced } = getContentTypeFlags(contentType);
  const safetyRules = isNuanced ? `CRITICAL SAFETY for ${contentType}:
- Must be 100% factually accurate
- No exaggeration or sensationalism
- No oversimplification of nuanced rulings
- Include authenticity context if from hadith
` : `Safety:
- Accurate to content
- Respectful tone
- No sensationalism of tragedy`;

  // 4. Build prompt
  return `Create a short attention-grabbing hook for the following article.

Purpose: Make readers curious and want to read the full summary.
Guidance: ${hookGuidance[contentType] ?? 'Find the most attention-grabbing element while staying accurate'}
Style: ${hookStyle[contentType] ?? 'Most compelling angle from the content'}

${safetyRules}

Requirements:
- Minimum 6 words, maximum 10 words (6-8 words ideal)
- No clickbait or exaggeration
- Must be accurate to the content
- Should intrigue without misleading
- Can be a statement, fragment, or brief quote
- Be creative using marks like semicolon or em dash

Examples of GOOD hooks:
✅ "The reward is more than a thousand months" (8 words - virtue)
✅ "Three days hiding in the cave" (6 words - seerah/story)
✅ "The name that brings instant peace" (6 words - knowledge)
✅ "One word that changes your prayer" (6 words - practical)
✅ "When the moon split in two" (6 words - historical)

Examples of BAD hooks:
❌ "You won't believe what happened next!" (clickbait)
❌ "This will change your life forever and ever" (too long, exaggerated)
❌ "The shocking truth about Islam" (sensationalist)
❌ "Learn the secret that scholars don't want you to know" (misleading)

If content is about tragedy, deemed controversial, or you're doubt about safety, SKIP generating hook`;
}

/**
 * Builds a safe prompt for generating contextual background for Islamic content.
 *
 * The context should help readers understand the background of the topic
 * without interpreting religious texts or issuing rulings.
 *
 * This function intentionally constrains the AI to prevent:
 * - religious interpretation
 * - issuing fatwas
 * - hallucinating scholarly sources
 * - moral prescriptions
 * 
 * Enhanced with CIS validation to prevent unnecessary context generation.
 */
function buildContextPrompt(contentType: ContentType, cisScore?: number): string {
  const { isNuanced } = getContentTypeFlags(contentType);

  // Context guidance per content type
  const contextGuidance: Record<ContentType, string> = {
    hadith: "Describe the historical setting or circumstances in which the hadith is commonly discussed.",
    seerah: "Provide the historical background of the event and where it fits in the life of the Prophet.",
    fiqh: "Explain that the topic relates to Islamic legal discussions among scholars.",
    virtue: "Describe the broader Islamic teaching or theme the article relates to.",
    story: "Provide the narrative or historical background surrounding the story.",
    knowledge: "Explain the educational or scholarly background of the topic.",
  };

  const focusAreas: Record<ContentType, string> = {
    hadith: "Historical context and the companions involved",
    seerah: "Historical timeline and key figures",
    fiqh: "Scholarly discussion and legal topic background",
    virtue: "Spiritual themes commonly discussed in Islamic teachings",
    story: "Historical setting and narrative background",
    knowledge: "Islamic scholarship or educational context",
  };

  const safetyRules = isNuanced
    ? `CRITICAL SAFETY RULES:
- Do NOT interpret Quran or Hadith.
- Do NOT derive religious rulings.
- Do NOT declare halal or haram.
- Do NOT provide religious advice.
- Only describe factual or widely known background context.`
    : `Safety Rules:
- Provide neutral informational background.
- Do NOT introduce opinions or speculation.
- Do NOT interpret religious texts.
- Avoid claims not supported by the article summary.`;

  // CIS validation section - ensuring context is only generated when genuinely beneficial for reader understanding
  const cisValidation = cisScore !== undefined ? `
CIS VALIDATION CHECK:
Context Importance Score (CIS): ${cisScore.toFixed(1)}
Threshold: 4.0

Before generating context, VALIDATE if it's actually needed:
- Does the content already provide sufficient background?
- Are there clear gaps that would confuse average readers?
- Would adding context actually improve understanding?
- Is the content self-explanatory for the target audience?

If the content is already clear and self-explanatory, SKIP context generation.
Only generate context if there are genuine knowledge gaps.` : '';

  return `Generate a short "Context" section that helps readers understand the
background of an article.

${cisValidation}

Guidance:
${contextGuidance[contentType] ?? "Provide neutral background context."}

Focus on:
${focusAreas[contentType] ?? "General historical or informational background."}

${safetyRules}

Important editorial principles:
- The context must be descriptive, not interpretive.
- Do NOT explain what Muslims should do.
- Do NOT present religious conclusions.
- Do NOT introduce new claims not implied by the title or summary.
- PREFER factual historical or scholarly context over interpretive statements.
- PREFER clear name instead of like "The event..." or "The incident..."

Style requirements:
- 1-2 sentences maximum (30 words ideal)
- Neutral, respectful tone
- No bullet points
- No emojis
- No quotes

Examples of GOOD context:

Good example (historical):
"The event took place during the early years of the Muslim community in Medina, a period when many foundational teachings and social practices of Islam were being established."

Good example (Quran narrative):
"The story appears in Surah Hud, where Prophet Nuh's call to faith and the rejection by some of his people are described."

Examples of BAD context:

❌ "This teaches Muslims that they must..."
❌ "The correct Islamic ruling is..."
❌ "This proves that people should..."
❌ "In my opinion this means..."

Self-check before answering:
Ensure the context DOES NOT:
- Issue religious rulings
- Interpret Quran or Hadith
- Give advice to Muslims
- Introduce personal opinions

Output:
Return only the context sentence(s).
Do not include labels or explanations.

If content requires specialized scholarly knowledge beyond established sources, or if you're uncertain about accuracy and/or safety, SKIP generating context.`;
}

/**
 * Refines cluster presentation (title and summary) using AI for better digest format
 * 
 * Enhances article clusters by:
 * - Creating concise, digest-friendly summaries within word limits
 * - Applying editorial standards and content type rules
 * - Generating clear, engaging titles for cluster presentation
 * 
 * @param context - Cluster context containing multiple related articles
 * @param contentType - Optional content type for targeted refinement rules
 * @returns Promise resolving to:
 *   - `ArticleCandidate` with refined title, summary, and provider info
 *   - `null` if AI refinement fails or encounters errors
 * ```
 */
export async function refineClusterPresentation(context: string, contentType: ContentType, topic?: ContentTopic): Promise<ArticleCandidate | null> {
  const contentTypeLabel = getContentTypeLabel(contentType);
  const format = getSummaryFormat(contentType, topic);
  const prompt = `Refinement task:
Based on recent related articles, create a refined ${contentTypeLabel} summary in ${SUMMARY_WORD_COUNT} words (${format})

Rules:${getRulesForContentType(contentType)}
- MUST captures the essence of multiple related summaries

Editorial rules:${RULES_EDITORIAL}

OUTPUT: Final corrected summary only. No explanations, no labels, no preamble.

Recent summaries:
${context}`;

  try {
    const result = await aiPrompt(prompt);
    const summary = result.output;

    // Validate and process summary through quality pipeline
    const finalSummary = validateAndProcessSummary(summary, result.provider);
    if (!finalSummary) return null;
    
    return {
      summary: finalSummary,
      summaryProvider: result.provider
    } as ArticleCandidate;
  } catch {
    return null;
  }
}

/**
 * Check if WordNet database is available for node-summarizer
 * @returns True if WordNet database files are found, false otherwise
 */
function isWordNetAvailable(): boolean {
  try {
    const base = path.dirname(
      require.resolve('wordnet-db/package.json')
    );

    const dictPath = path.join(base, 'dict', 'fast-index.noun.json');
    return fs.existsSync(dictPath);
  } catch {
    return false;
  }
}