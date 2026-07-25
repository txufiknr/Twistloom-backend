/**
 * Password Changed Email Template
 *
 * Confirms a successful password change (in-app or via reset link).
 */

import { buildEmailHtml } from './base-layout.js';

/**
 * @param appName - Application display name
 * @param name - User display name
 * @param detailHtml - Optional IP / User-Agent / time details
 */
export function getPasswordChangedTemplate(appName: string, name: string, detailHtml?: string): string {
  return buildEmailHtml({
    title: `Your ${appName} password was changed`,
    heading: `Password updated, ${name}.`,
    bodyHtml: `
      <p>Your ${appName} password was changed successfully.</p>
      ${detailHtml ?? ''}
      <p>If you made this change, no further action is needed.</p>
      <p>If you did <strong>not</strong> change your password, reset it immediately and contact support.</p>
    `,
    footerHtml: `
      <p>This is a security notification. We always send these when your password changes.</p>
    `,
  });
}
