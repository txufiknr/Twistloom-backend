/**
 * Account Deleted Confirmation Template
 *
 * Voice: mild farewell noir — irreversible facts stay plain and clear.
 * Not a security-alert template (no action required); still prioritizes clarity.
 */

import { buildEmailHtml } from './base-layout.js';

/**
 * @param appName - Application display name
 * @param name - User display name
 */
export function getAccountDeletedTemplate(appName: string, name: string): string {
  return buildEmailHtml({
    title: `Your ${appName} account has been deleted`,
    heading: `The file is closed, ${name}.`,
    bodyHtml: `
      <p>Your ${appName} account and associated personal data have been deleted as requested.</p>
      <p>We're sorry to see you go. If this was a mistake, you can create a new account — the previous one cannot be restored.</p>
    `,
    footerHtml: `
      <p>This confirmation is sent once when an account is deleted.</p>
    `,
  });
}
