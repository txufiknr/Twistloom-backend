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

export function getVerificationTemplate(appName: string, verificationUrl: string, otpCode?: string): string {
  const codeHtml = otpCode ? `
    <div style="margin: 24px 0; text-align: center;">
      <p style="font-size: 13px; color: #a1a1aa; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 600;">Your Verification Code</p>
      <div style="font-size: 32px; font-weight: 900; letter-spacing: 8px; color: #ffffff; background: #18181b; padding: 14px 24px; border-radius: 12px; display: inline-block; border: 1px solid #27272a; font-family: monospace;">
        ${otpCode}
      </div>
    </div>
  ` : '';

  return buildEmailHtml({
    title: `Verify Your ${appName} Email`,
    heading: 'One step closer to the story.',
    bodyHtml: `
      <p>You've chosen to enter ${appName} — a world where every choice ripples through the narrative. But first, you must confirm your identity.</p>
      ${codeHtml}
      <p style="margin-top: 16px;">Or click the button below to verify your email directly:</p>
    `,
    button: { url: verificationUrl, text: 'Verify Email' },
    plainUrl: verificationUrl,
    footerHtml: `
      <p>This verification code expires in <strong>24 hours</strong>.</p>
      <p>If you didn't create an account, no action is needed — this code will expire on its own.</p>
    `,
  });
}
