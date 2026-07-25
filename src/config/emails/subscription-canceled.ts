/**
 * Subscription Canceled Email Template
 *
 * Voice: mild noir — clear access end date, atmospheric close.
 */

import { buildEmailHtml } from './base-layout.js';

/**
 * @param appName - Application display name
 * @param name - User display name
 * @param accessEndsAt - Optional date when VIP access ends
 */
export function getSubscriptionCanceledTemplate(
  appName: string,
  name: string,
  accessEndsAt?: Date,
): string {
  const accessLine = accessEndsAt
    ? `<p>VIP access holds until <strong>${accessEndsAt.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })}</strong> — then the lights dim and your account returns to standard.</p>`
    : `<p>Your VIP benefits will end with the current billing period.</p>`;

  return buildEmailHtml({
    title: `Your ${appName} VIP subscription was canceled`,
    heading: `This chapter ends, ${name}.`,
    bodyHtml: `
      <p>Your ${appName} VIP subscription has been canceled.</p>
      ${accessLine}
      <p>The door stays open. Resubscribe anytime from your account settings when you're ready for the next act.</p>
    `,
  });
}
