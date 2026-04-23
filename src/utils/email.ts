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
 * @todo
 * - extract email template into separate file for maintainability (if possible)
 * - ensure design match with Twistloom UI
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
      subject: 'Reset Your Twistloom Password',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Reset Your Password</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #333;">Reset Your Password</h1>
            <p>You requested a password reset for your Twistloom account.</p>
            <p>Click the button below to reset your password:</p>
            <p>
              <a href="${resetUrl}" style="display: inline-block; padding: 12px 24px; background-color: #007bff; color: white; text-decoration: none; border-radius: 4px;">Reset Password</a>
            </p>
            <p>Or copy and paste this link into your browser:</p>
            <p style="word-break: break-all; color: #666;">${resetUrl}</p>
            <p style="color: #666; font-size: 14px;">This link will expire in 1 hour.</p>
            <p style="color: #666; font-size: 14px;">If you didn't request this password reset, please ignore this email.</p>
          </div>
        </body>
        </html>
      `,
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
      subject: 'Verify Your Twistloom Email',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Verify Your Email</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #333;">Verify Your Email</h1>
            <p>Thank you for signing up for Twistloom!</p>
            <p>Please verify your email address by clicking the button below:</p>
            <p>
              <a href="${verificationUrl}" style="display: inline-block; padding: 12px 24px; background-color: #007bff; color: white; text-decoration: none; border-radius: 4px;">Verify Email</a>
            </p>
            <p>Or copy and paste this link into your browser:</p>
            <p style="word-break: break-all; color: #666;">${verificationUrl}</p>
            <p style="color: #666; font-size: 14px;">This link will expire in 24 hours.</p>
          </div>
        </body>
        </html>
      `,
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
      subject: 'Welcome to Twistloom!',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Welcome to Twistloom</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #333;">Welcome to Twistloom, ${username}!</h1>
            <p>Thank you for joining Twistloom. We're excited to have you on board!</p>
            <p>Start creating amazing interactive stories with our AI-powered platform.</p>
            <p>If you have any questions, feel free to reach out to our support team.</p>
            <p>Best,<br>The Twistloom Team</p>
          </div>
        </body>
        </html>
      `,
    });
  } catch (error) {
    console.error('Failed to send welcome email:', error);
    // Don't throw error for welcome email - it's not critical
  }
}
