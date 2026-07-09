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

// TODO: it has many repeating codes, also `sendTrialEndingEmail` has inconsistent pattern (should create template)
// can you make them consistent and DRY?

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

/**
 * Sends a reminder email ~3 days before a user's VIP free trial ends.
 *
 * This is deliberately simple, plain-text-forward HTML — the goal is a fast,
 * legible reminder, not a marketing email. Keep it easy to distinguish from
 * Stripe's own trial-ending email (different sender name/voice) so a user who
 * gets both doesn't dismiss the second as a duplicate.
 *
 * Non-blocking by design at the call site: handleTrialWillEnd() wraps this in
 * a try/catch so a Resend failure never breaks the in-app notification or
 * fails the webhook. Errors here should be logged, not thrown to the caller,
 * unless you want the caller to decide the retry policy explicitly.
 *
 * @param params.to - User's email address
 * @param params.name - User's display name, for personalization
 * @param params.trialEndDate - When the trial ends / the card will be charged
 */
export async function sendTrialEndingEmail(params: {
  to: string;
  name: string;
  trialEndDate: Date;
}): Promise<void> {
  const formattedDate = params.trialEndDate.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  await resend.emails.send({
    // Adjust to match the sender identity your other transactional emails use.
    from: "Twistloom <noreply@twistloom.app>",
    to: params.to,
    subject: "Your Twistloom VIP trial ends in 3 days",
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h1 style="font-size: 20px; margin-bottom: 16px;">Your free trial ends soon</h1>
        <p style="font-size: 15px; line-height: 1.6; color: #333;">
          Hi ${params.name},
        </p>
        <p style="font-size: 15px; line-height: 1.6; color: #333;">
          Your Twistloom VIP free trial ends on <strong>${formattedDate}</strong>.
          After that, we'll charge your card on file to continue your VIP membership —
          the badge, 2x check-in bonus, and your monthly credits.
        </p>
        <p style="font-size: 15px; line-height: 1.6; color: #333;">
          Nothing to do if you're planning to stay. If your card has changed or you'd
          rather not continue, you can update your payment method or cancel any time
          from your subscription settings before the trial ends.
        </p>
        <p style="font-size: 15px; line-height: 1.6; color: #333; margin-top: 24px;">
          — The Twistloom team
        </p>
      </div>
    `,
  });
}