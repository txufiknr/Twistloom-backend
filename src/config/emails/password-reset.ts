/**
 * Password Reset Email Template
 *
 * Generates HTML template for password reset emails using the shared base layout.
 * Voice: suspenseful but clear — the user may be anxious, so instructions must
 * be the most prominent element.
 *
 * @param appName - Application display name (e.g. "Twistloom")
 * @param resetUrl - Full password reset URL including token
 * @returns Complete email HTML string
 *
 * @example
 * ```typescript
 * const html = getPasswordResetTemplate('Twistloom', 'https://app.com/reset-password?token=abc123');
 * ```
 */

import { buildEmailHtml } from './base-layout.js';

export function getPasswordResetTemplate(appName: string, resetUrl: string): string {
  return buildEmailHtml({
    title: `Reset Your ${appName} Password`,
    heading: 'The keys to your story.',
    bodyHtml: `
      <p>Someone requested to reset your password for ${appName}. If that was you, the path forward lies below.</p>
      <p>Click the button to reclaim your narrative — your account, your secrets, your next chapter.</p>
    `,
    button: { url: resetUrl, text: 'Reset Password' },
    plainUrl: resetUrl,
    footerHtml: `
      <p>This gateway closes in <strong>1 hour</strong>.</p>
      <p>If you didn't request this, ignore this message — your story remains secure, and no changes have been made.</p>
    `,
  });
}
