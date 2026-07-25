/**
 * Email Changed (old address) Template
 *
 * Alerts the previous login email that the account email was updated.
 */

import { buildEmailHtml } from './base-layout.js';

/**
 * @param appName - Application display name
 * @param name - User display name
 * @param newEmailMasked - Partially masked new email for context
 * @param detailHtml - Optional IP / User-Agent details
 */
export function getEmailChangedTemplate(
  appName: string,
  name: string,
  newEmailMasked: string,
  detailHtml?: string,
): string {
  return buildEmailHtml({
    title: `Your ${appName} email address was changed`,
    heading: `Email updated, ${name}.`,
    bodyHtml: `
      <p>The login email on your ${appName} account was changed to <strong>${newEmailMasked}</strong>.</p>
      ${detailHtml ?? ''}
      <p>If you made this change, you can ignore this message. A verification email was sent to the new address.</p>
      <p>If you did <strong>not</strong> request this, reset your password immediately and contact support.</p>
    `,
    footerHtml: `
      <p>This is a security notification. We always send these when your login email changes.</p>
    `,
  });
}
