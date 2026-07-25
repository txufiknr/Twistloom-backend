/**
 * Payment Failed / Past Due Email Template
 *
 * Voice: mild noir — urgency with atmosphere; action and facts stay unmistakable.
 */

import { buildEmailHtml } from './base-layout.js';

/**
 * @param appName - Application display name
 * @param name - User display name
 * @param portalUrl - Optional customer portal / billing URL
 */
export function getPaymentFailedTemplate(appName: string, name: string, portalUrl?: string): string {
  return buildEmailHtml({
    title: `Action needed: ${appName} payment failed`,
    heading: `The trail went cold, ${name}.`,
    bodyHtml: `
      <p>We couldn't process your latest ${appName} VIP payment. Your membership is marked <strong>past due</strong>.</p>
      <p>Update your payment method so the badge, credits, and 2× check-in don't slip into the dark.</p>
    `,
    button: portalUrl ? { url: portalUrl, text: 'Update billing' } : undefined,
    plainUrl: portalUrl,
    footerHtml: `
      <p>Already fixed the card? You can ignore this — the next charge will try again on its own.</p>
    `,
  });
}
