import type { VerificationConfidence } from "../types/wallet.js";

/**
 * Utility functions for fuzzy name matching, normalization,
 * and KYC name verification.
 */

const INDONESIAN_PREFIX_HONORIFICS = new Set([
  "dr",
  "drs",
  "dra",
  "ir",
  "prof",
  "h",
  "hj",
  "kh",
]);

const INDONESIAN_SUFFIX_TITLES = new Set([
  "st",
  "sp",
  "ss",
  "se",
  "sh",
  "skom",
  "kom",
  "mm",
  "mba",
  "spd",
  "ssi",
  "skep",
  "msi",
]);

/**
 * Normalizes a human or corporate name:
 * - Converts to lowercase
 * - Strips diacritics/accents (e.g., é -> e)
 * - Removes punctuation and non-alphanumeric chars except whitespace
 * - Expands standard Indonesian banking abbreviations (Moh/Md -> Muhammad, St -> Siti, etc.)
 * - Strips common academic and religious honorific titles (Dr, Ir, SE, SH, SKom, etc.)
 * - Collapses repeated whitespace
 */
export function normalizeName(name: string): string {
  if (!name) return "";
  const cleaned = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = cleaned.split(" ").filter(Boolean);
  const normalizedTokens: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Strip prefix honorifics (e.g. Dr., Ir., Prof., H., Hj.)
    if (i === 0 && INDONESIAN_PREFIX_HONORIFICS.has(token)) {
      continue;
    }

    // Strip suffix degree titles (e.g. S.Kom, S.E., S.H., M.M., M.B.A.)
    if (i > 0 && INDONESIAN_SUFFIX_TITLES.has(token)) {
      continue;
    }

    // Expand standard Indonesian name abbreviations
    if (token === "st" && i === 0 && tokens.length > 1) {
      normalizedTokens.push("siti");
    } else if (token === "moh" || token === "mohd" || token === "md" || token === "muh") {
      normalizedTokens.push("muhammad");
    } else if (token === "abd") {
      normalizedTokens.push("abdul");
    } else if (token === "ibn") {
      normalizedTokens.push("ibnu");
    } else {
      normalizedTokens.push(token);
    }
  }

  return normalizedTokens.join(" ");
}

/**
 * Computes standard Jaro-Winkler string similarity between two strings.
 * Returns a value between 0.0 (no similarity) and 1.0 (identical).
 */
export function jaroWinklerDistance(s1: string, s2: string): number {
  const str1 = normalizeName(s1);
  const str2 = normalizeName(s2);

  if (str1 === str2) return 1.0;
  if (str1.length === 0 || str2.length === 0) return 0.0;

  const matchWindow = Math.max(0, Math.floor(Math.max(str1.length, str2.length) / 2) - 1);
  const str1Matches = new Array(str1.length).fill(false);
  const str2Matches = new Array(str2.length).fill(false);

  let matches = 0;
  for (let i = 0; i < str1.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, str2.length);

    for (let j = start; j < end; j++) {
      if (!str2Matches[j] && str1[i] === str2[j]) {
        str1Matches[i] = true;
        str2Matches[j] = true;
        matches++;
        break;
      }
    }
  }

  if (matches === 0) return 0.0;

  // Count transpositions
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < str1.length; i++) {
    if (str1Matches[i]) {
      while (!str2Matches[k]) {
        k++;
      }
      if (str1[i] !== str2[k]) {
        transpositions++;
      }
      k++;
    }
  }

  const jaro =
    (matches / str1.length +
      matches / str2.length +
      (matches - transpositions / 2) / matches) /
    3.0;

  // Winkler prefix adjustment (up to 4 chars, prefix scale factor p = 0.1)
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(str1.length, str2.length)); i++) {
    if (str1[i] === str2[i]) {
      prefix++;
    } else {
      break;
    }
  }

  return jaro + prefix * 0.1 * (1.0 - jaro);
}

/**
 * Computes token-level intersection (Jaccard / overlap ratio) between two names.
 * Especially effective for inverted names (e.g. "Doe John" vs "John Doe")
 * or truncated middle names.
 */
export function tokenIntersectionScore(nameA: string, nameB: string): number {
  const normA = normalizeName(nameA);
  const normB = normalizeName(nameB);
  if (!normA || !normB) return 0.0;

  const tokensA = normA.split(" ").filter(Boolean);
  const tokensB = normB.split(" ").filter(Boolean);

  if (tokensA.length === 0 || tokensB.length === 0) return 0.0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  let matchCount = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      matchCount++;
    }
  }

  const unionSize = new Set([...tokensA, ...tokensB]).size;
  return unionSize > 0 ? matchCount / unionSize : 0.0;
}

export interface NameMatchResult {
  score: number;
  isMatch: boolean;
  confidence: VerificationConfidence;
}

/**
 * Calculates a composite name match score combining Jaro-Winkler and Token Intersection.
 * Thresholds:
 * - score >= 0.85: "high" confidence match (auto-approved)
 * - score >= 0.60: "medium" confidence match (requires manual review)
 * - score < 0.60: "low" confidence (rejected)
 */
export function calculateNameMatchScore(
  userName: string,
  bankHolderName: string
): NameMatchResult {
  const jw = jaroWinklerDistance(userName, bankHolderName);
  const tokenScore = tokenIntersectionScore(userName, bankHolderName);

  // Take the maximum of string edit distance vs word token overlap
  // to gracefully handle inverted names ("Budi Santoso" vs "Santoso Budi")
  const compositeScore = Math.max(jw, tokenScore * 0.95 + jw * 0.05);
  const roundedScore = Math.round(compositeScore * 100) / 100;

  if (roundedScore >= 0.85) {
    return { score: roundedScore, isMatch: true, confidence: "high" };
  } else if (roundedScore >= 0.60) {
    return { score: roundedScore, isMatch: true, confidence: "medium" };
  } else {
    return { score: roundedScore, isMatch: false, confidence: "low" };
  }
}
