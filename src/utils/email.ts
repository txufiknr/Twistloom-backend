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
export async function sendPasswordResetEmail(email: string, resetUrl: string): Promise<boolean> {
  try {
    const { error } = await resend.emails.send({
      from: DEFAULT_FROM_EMAIL,
      to: email,
      subject: `Reset Your ${APP_NAME} Password`,
      html: getPasswordResetTemplate(APP_NAME, resetUrl),
    });

    if (error) {
      console.error('[sendPasswordResetEmail] ❌ Resend API error:', error);
      return false;
    }

    console.log('[sendPasswordResetEmail] ✅ Password reset email sent to:', email);
    return true;
  } catch (error) {
    console.error('[sendPasswordResetEmail] ❌ Failed to send password reset email:', error);
    return false;
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
export async function sendVerificationEmail(email: string, verificationUrl: string): Promise<boolean> {
  try {
    const { error } = await resend.emails.send({
      from: DEFAULT_FROM_EMAIL,
      to: email,
      subject: `Verify Your ${APP_NAME} Email`,
      html: getVerificationTemplate(APP_NAME, verificationUrl),
    });

    if (error) {
      console.error('[sendVerificationEmail] ❌ Resend API error:', error);
      return false;
    }

    console.log('[sendVerificationEmail] ✅ Verification email sent successfully to:', email);
    return true;
  } catch (error) {
    console.error('[sendVerificationEmail] ❌ Failed to send verification email:', error);
    return false;
  }
}

/**
 * Sends a welcome email after successful signup
 * 
 * @param email - Recipient email address
 * @param username - User's username
 * @returns Whether the email was successfully sent
 * 
 * @example
 * ```typescript
 * const sent = await sendWelcomeEmail('user@example.com', 'johndoe');
 * ```
 */
export async function sendWelcomeEmail(email: string, username: string): Promise<boolean> {
  try {
    const { error } = await resend.emails.send({
      from: DEFAULT_FROM_EMAIL,
      to: email,
      subject: `Welcome to ${APP_NAME}!`,
      html: getWelcomeTemplate(APP_NAME, username),
    });

    if (error) {
      console.error('[sendWelcomeEmail] ❌ Resend API error:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[sendWelcomeEmail] ❌ Failed to send welcome email:', error);
    return false;
  }
}
