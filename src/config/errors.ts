/**
 * Error Message Constants
 * 
 * Centralized error messages to ensure consistency across the application
 * and avoid magic strings in error handling code.
 */

import { getErrorMessage } from "../utils/error.js";

/**
 * Credit-related error messages
 */
export const CREDIT_ERRORS = {
  /** Standard insufficient credits message */
  INSUFFICIENT_CREDITS: "Insufficient credits",
  
  /** Pattern for matching insufficient credits errors */
  INSUFFICIENT_CREDITS_PATTERN: "Insufficient credits:",
} as const;

/**
 * Translation-related error messages
 */
export const TRANSLATION_ERRORS = {
  /** Standard translation failed message */
  TRANSLATION_FAILED: "Translation failed",
} as const;

/**
 * Validation-related error messages
 */
export const VALIDATION_ERRORS = {
  /** Missing required field */
  MISSING_FIELD: "Missing required field",
  
  /** Invalid field type or format */
  INVALID_FIELD: "Invalid",
  
  /** Field exceeds maximum length */
  EXCEEDS_MAX_LENGTH: "exceeds maximum length",
} as const;

/**
 * Authentication-related error messages
 */
export const AUTH_ERRORS = {
  /** User not found */
  USER_NOT_FOUND: "User not found",
  
  /** Unauthorized access */
  UNAUTHORIZED: "Unauthorized",
} as const;

/**
 * Type guards for error checking
 */
export const isCreditError = (error: unknown): boolean => {
  return getErrorMessage(error).includes(CREDIT_ERRORS.INSUFFICIENT_CREDITS_PATTERN);
};

export const isNotFoundError = (error: unknown): boolean => {
  return getErrorMessage(error).toLowerCase().includes("not found");
};
