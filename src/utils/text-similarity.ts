/**
 * A minimal set of common English stopwords for text processing.
 * Kept minimal to avoid over-filtering and maintain meaningful content.
 */
const DEFAULT_ENGLISH_STOPWORDS: Set<string> = new Set([
  "the", "and", "for", "with", "that", "this", "from", "were", "have", "has", "had",
  "are", "was", "but", "not", "you", "your", "they", "their", "them", "she", "he", "his", "her",
  "a", "an", "in", "on", "at", "by", "of", "to", "is", "it", "as", "or", "be", "we", "our", "if"
]);

/**
 * Normalizes and tokenizes text for similarity comparison.
 * 
 * The function performs the following transformations in order:
 * 1. Unicode NFKC normalization for compatibility
 * 2. Strips diacritics and combining marks
 * 3. Converts to lowercase (Unicode-aware)
 * 4. Removes punctuation while preserving Unicode letters and numbers
 * 5. Splits into tokens on whitespace
 * 6. Filters out short tokens and stopwords
 *
 * @param inputText - The text to tokenize. Can be a string or array of strings.
 * @param options - Configuration options
 * @param options.minTokenLength - Minimum token length to keep (inclusive)
 * @param options.stopwords - Set of stopwords to filter out
 * @returns Object containing:
 *   - tokens: Array of processed and filtered tokens
 *   - freq: Map where keys are tokens and values are their occurrence counts
 */
export function tokenizeForComparison(
  inputText: string | string[],
  { minTokenLength = 3, stopwords = DEFAULT_ENGLISH_STOPWORDS }: {
    minTokenLength?: number;
    stopwords?: Set<string>;
  } = {}
): { tokens: string[]; freq: Map<string, number> } {
  if (!inputText) return { tokens: [], freq: new Map() };

  // Convert array input to space-separated string if needed
  const textToProcess = Array.isArray(inputText) ? inputText.join(" ") : inputText;

  // 1) Unicode normalize (NFKC) and strip diacritics (NFD + remove marks)
  const normalizedText = textToProcess
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");

  // 2) Convert to lowercase (Unicode-aware)
  const lowercasedText = normalizedText.toLowerCase();

  // 3) Remove punctuation (keep only letters, numbers, and whitespace)
  const cleanText = lowercasedText.replace(/[^\p{L}\p{N}\s]+/gu, " ");

  // 4) Split into tokens and remove empty strings
  const rawTokens = cleanText.split(/\s+/).filter(Boolean);

  const tokens = [];
  const tokenFrequency = new Map();

  for (const token of rawTokens) {
    if (token.length < minTokenLength) continue;
    if (stopwords.has(token)) continue;
    
    tokens.push(token);
    tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1);
  }

  return { 
    tokens, 
    freq: tokenFrequency 
  };
}

/**
 * Calculates Jaccard similarity coefficient between two text inputs.
 * 
 * Jaccard similarity is defined as the size of the intersection divided by the size of the union
 * of the token sets. Returns a value between 0 (completely dissimilar) and 1 (identical).
 *
 * @param textA - First text input to compare
 * @param textB - Second text input to compare
 * @returns Jaccard similarity score in range [0, 1]
 * 
 * @example
 * jaccard("hello world", "world of code")  // returns ~0.33
 */
export function jaccard(
  textA: string | string[],
  textB: string | string[]
): number {
  // Handle edge cases
  if (!textA && !textB) return 1;  // Both empty
  if (!textA || !textB) return 0;  // One is empty

  // Tokenize both inputs
  const tokensA = tokenizeForComparison(textA).tokens;
  const tokensB = tokenizeForComparison(textB).tokens;

  // If either token set is empty after processing, similarity is 0
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  // Convert second token array to Set for O(1) lookups
  const tokenSetB = new Set(tokensB);
  
  // Calculate intersection size
  const intersectionSize = tokensA.reduce(
    (count, token) => count + (tokenSetB.has(token) ? 1 : 0),
    0
  );
  
  // Calculate union size using a Set to remove duplicates
  const unionSize = new Set([...tokensA, ...tokensB]).size;

  return intersectionSize / unionSize;
}

/**
 * Calculates cosine similarity between two token frequency maps.
 * 
 * Cosine similarity measures the cosine of the angle between two vectors,
 * where each vector represents the token frequencies of a document.
 * Returns a value between 0 (completely dissimilar) and 1 (identical).
 *
 * @param frequencyMapA - First token frequency map
 * @param frequencyMapB - Second token frequency map
 * @returns Cosine similarity score in range [0, 1]
 * 
 * @example
 * const freqA = new Map([['hello', 1], ['world', 1]]);
 * const freqB = new Map([['world', 1], ['code', 1]]);
 * cosineSimilarityFromFreq(freqA, freqB);  // returns ~0.5
 */
export function cosineSimilarityFromFreq(
  frequencyMapA: Map<string, number>,
  frequencyMapB: Map<string, number>
): number {
  // Handle null or undefined inputs
  if (!frequencyMapA || !frequencyMapB) return 0;

  let dotProduct = 0;
  let sumOfSquaresA = 0;
  let sumOfSquaresB = 0;

  // First pass: calculate dot product and sum of squares for frequencyMapA
  for (const [token, countA] of frequencyMapA.entries()) {
    sumOfSquaresA += countA * countA;
    const countB = frequencyMapB.get(token) || 0;
    dotProduct += countA * countB;
  }

  // Second pass: calculate sum of squares for frequencyMapB
  for (const countB of frequencyMapB.values()) {
    sumOfSquaresB += countB * countB;
  }

  // Avoid division by zero
  if (sumOfSquaresA === 0 || sumOfSquaresB === 0) return 0;

  // Calculate and return cosine similarity
  const magnitudeA = Math.sqrt(sumOfSquaresA);
  const magnitudeB = Math.sqrt(sumOfSquaresB);
  return dotProduct / (magnitudeA * magnitudeB);
}

/**
 * Calculates the semantic drift between two texts.
 * 
 * The function computes a drift score between 0 and 1, where:
 * - 0 means the texts are identical or very similar
 * - 1 means the texts are completely different
 * 
 * The calculation combines:
 * 1. Jaccard similarity for set overlap of tokens
 * 2. Cosine similarity of term frequencies
 * 3. A length ratio penalty to account for significant length differences
 *
 * @param referenceText - The reference or canonical text (typically the original cluster summary)
 * @param candidateText - The text to compare against the reference (can be string or array of strings)
 * @returns Drift score in range [0, 1]
 * 
 * @example
 * const drift = computeDrift("original cluster summary", "new candidate text");
 */
export function computeDrift(
  referenceText: string,
  candidateText: string | string[]
): number {
  try {
    // Normalize candidateText if it's an array
    const normalizedCandidateText = Array.isArray(candidateText) 
      ? candidateText.join(" ") 
      : candidateText;

    // Handle edge cases for empty inputs
    if (!referenceText && !normalizedCandidateText) return 0; // Both empty
    if (!referenceText || !normalizedCandidateText) return 1; // One is empty

    // Tokenize both texts to get tokens and frequency maps
    const referenceData = tokenizeForComparison(referenceText);
    const candidateData = tokenizeForComparison(normalizedCandidateText);

    // If either text has no valid tokens after processing, treat as maximum drift
    if (referenceData.tokens.length === 0 || candidateData.tokens.length === 0) {
      return 1;
    }

    // Calculate Jaccard similarity (set-based overlap)
    const jaccardSimilarity = jaccard(referenceText, normalizedCandidateText);

    // Calculate Cosine similarity (frequency-based)
    const cosineSimilarity = cosineSimilarityFromFreq(referenceData.freq, candidateData.freq);

    // Combine both similarity measures with equal weight
    const combinedSimilarity = (jaccardSimilarity + cosineSimilarity) / 2;

    // Calculate length ratio to penalize very different text lengths
    const referenceLength = referenceData.tokens.length;
    const candidateLength = candidateData.tokens.length;
    const minLength = Math.min(referenceLength, candidateLength);
    const maxLength = Math.max(referenceLength, candidateLength);
    const lengthRatio = minLength / maxLength;

    // Apply length ratio penalty (scale factor between 0.25 and 1.0)
    // This reduces similarity for texts with very different lengths
    const lengthPenaltyFactor = Math.max(0.25, lengthRatio);

    // Calculate final similarity score with length penalty applied
    const adjustedSimilarity = combinedSimilarity * lengthPenaltyFactor;

    // Convert similarity to drift (inverse of similarity)
    let driftScore = 1 - adjustedSimilarity;

    // Ensure drift score is within valid range [0, 1]
    driftScore = Math.max(0, Math.min(1, driftScore));

    return driftScore;
  } catch (error) {
    console.error("Error in computeDrift:", error);
    // Return maximum drift on error to be safe
    return 1;
  }
}
