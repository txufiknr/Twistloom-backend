/**
 * Email Verification Template
 *
 * Generates HTML template for email verification emails using the shared base layout.
 *
 * @param appName - Application display name (e.g. "Twistloom")
 * @param verificationUrl - Full email verification URL including token
 * @returns Complete email HTML string
 *
 * @example
 * ```typescript
 * const html = getVerificationTemplate('Twistloom', 'https://app.com/verify-email?token=abc123');
 * ```
 */

import { buildEmailHtml } from './base-layout.js';

export function getVerificationTemplate(appName: string, verificationUrl: string): string {
  return buildEmailHtml({
    title: `Verify Your ${appName} Email`,
    heading: 'One step closer to the story.',
    bodyHtml: `
      <p>You've chosen to enter ${appName} — a world where every choice ripples through the narrative. But first, you must confirm your identity.</p>
      <p>Click the button below to verify your email and unlock your journey. The next chapter won't write itself.</p>
    `,
    button: { url: verificationUrl, text: 'Verify Email' },
    plainUrl: verificationUrl,
    footerHtml: `
      <p>This invitation expires in <strong>24 hours</strong>.</p>
      <p>If you didn't create an account, no action is needed — this link will expire on its own.</p>
    `,
  });
}
