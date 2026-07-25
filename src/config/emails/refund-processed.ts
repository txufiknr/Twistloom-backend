/**
 * Refund Processed Email Template
 *
 * Voice: mild noir — confirmation first, atmosphere second.
 */

import { buildEmailHtml } from './base-layout.js';

/**
 * @param appName - Application display name
 * @param name - User display name
 * @param creditsDeducted - Credits removed due to refund
 */
export function getRefundProcessedTemplate(appName: string, name: string, creditsDeducted: number): string {
  return buildEmailHtml({
    title: `Refund processed — ${appName}`,
    heading: `The deal is reversed, ${name}.`,
    bodyHtml: `
      <p>A refund on your ${appName} purchase has gone through.</p>
      <p>To keep the books balanced, <strong>${creditsDeducted}</strong> credit${creditsDeducted === 1 ? '' : 's'} ${creditsDeducted === 1 ? 'has' : 'have'} been pulled from your balance.</p>
    `,
    footerHtml: `
      <p>Your bank or card issuer may take a few business days to show the refund on your statement.</p>
    `,
  });
}
