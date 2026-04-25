/**
 * Email Utilities
 * 
 * Provides email sending functionality using Resend API.
 * Used for password reset, email verification, and other transactional emails.
 * 
 * @example
 * ```typescript
 * import { sendPasswordResetEmail, sendVerificationEmail } from '../utils/email.js';
 * 
 * // Send password reset email
 * await sendPasswordResetEmail('user@example.com', 'https://app.com/reset-password?token=xxx');
 * 
 * // Send email verification
 * await sendVerificationEmail('user@example.com', 'https://app.com/verify-email?token=xxx');
 * ```
 */

import { Resend } from 'resend';
import { APP_NAME } from '../config/constants.js';
import { getPasswordResetTemplate, getVerificationTemplate, getWelcomeTemplate } from '../config/emails/index.js';

// Initialize Resend client
const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * Default sender email address
 */
const DEFAULT_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'noreply@twistloom.com';

/**
 * Sends a password reset email
 * 
 * @param email - Recipient email address
 * @param resetUrl - Password reset URL with token
 * 
 * @example
 * ```typescript
 * await sendPasswordResetEmail('user@example.com', 'https://app.com/reset-password?token=abc123');
 * ```
 */
export async function sendPasswordResetEmail(email: string, resetUrl: string): Promise<void> {
  try {
    await resend.emails.send({
      from: DEFAULT_FROM_EMAIL,
      to: email,
      subject: `Reset Your ${APP_NAME} Password`,
      html: getPasswordResetTemplate(APP_NAME, resetUrl),
    });
  } catch (error) {
    console.error('Failed to send password reset email:', error);
    throw new Error('Failed to send password reset email', { cause: error });
  }
}

/**
 * Sends an email verification email
 * 
 * @param email - Recipient email address
 * @param verificationUrl - Email verification URL with token
 * 
 * @example
 * ```typescript
 * await sendVerificationEmail('user@example.com', 'https://app.com/verify-email?token=abc123');
 * ```
 */
export async function sendVerificationEmail(email: string, verificationUrl: string): Promise<void> {
  try {
    await resend.emails.send({
      from: DEFAULT_FROM_EMAIL,
      to: email,
      subject: `Verify Your ${APP_NAME} Email`,
      html: getVerificationTemplate(APP_NAME, verificationUrl),
    });
  } catch (error) {
    console.error('Failed to send verification email:', error);
    throw new Error('Failed to send verification email', { cause: error });
  }
}

/**
 * Sends a welcome email after successful signup
 * 
 * @param email - Recipient email address
 * @param username - User's username
 * 
 * @example
 * ```typescript
 * await sendWelcomeEmail('user@example.com', 'johndoe');
 * ```
 */
export async function sendWelcomeEmail(email: string, username: string): Promise<void> {
  try {
    await resend.emails.send({
      from: DEFAULT_FROM_EMAIL,
      to: email,
      subject: `Welcome to ${APP_NAME}!`,
      html: getWelcomeTemplate(APP_NAME, username),
    });
  } catch (error) {
    console.error('Failed to send welcome email:', error);
    // Don't throw error for welcome email - it's not critical
  }
}
