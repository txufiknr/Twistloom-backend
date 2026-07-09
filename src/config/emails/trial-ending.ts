/**
 * VIP Trial Ending Email Template
 *
 * Generates HTML template for the email sent ~3 days before a user's VIP free
 * trial expires. Uses the shared base layout and thriller-themed voice consistent
 * with the other transactional templates.
 *
 * @param appName - Application display name (e.g. "Twistloom")
 * @param name - User's display name for personalisation
 * @param trialEndDate - When the trial ends / the card will be charged
 * @returns Complete email HTML string
 *
 * @example
 * ```typescript
 * const html = getTrialEndingTemplate('Twistloom', 'Jane', new Date('2026-07-15'));
 * ```
 */

import { buildEmailHtml } from './base-layout.js';

export function getTrialEndingTemplate(appName: string, name: string, trialEndDate: Date): string {
  const formattedDate = trialEndDate.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return buildEmailHtml({
    title: `Your ${appName} VIP Trial Ends Soon`,
    heading: `The clock is ticking, ${name}.`,
    bodyHtml: `
      <p>Your VIP access to ${appName} — the badge, the 2x check-in bonus, your monthly credits — is set to expire on <strong>${formattedDate}</strong>.</p>
      <p>After that date, we'll charge your card on file to continue the membership. No interruptions, no gaps in your story.</p>
      <p>If your payment method has changed or you'd rather not continue, update your billing info or cancel anytime from your subscription settings before the trial ends.</p>
    `,
    // Note: button intentionally omitted — no deep link from email is necessary.
    // The in-app subscription settings page is the canonical management entry
    // point, and the companion in-app notification carries the CTA. Stripe's
    // own trial-ending email (sent automatically from the Dashboard) serves
    // as a zero-code safety net.
    footerHtml: `
      <p>Nothing to do if you're planning to stay. Your VIP benefits will continue without a hitch.</p>
      <p><strong>${formattedDate}</strong> — when the trial ends, the real story begins.</p>
    `,
  });
}
