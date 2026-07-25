/**
 * Internal Feedback Alert Template (team inbox)
 */

import { buildEmailHtml } from './base-layout.js';

export interface FeedbackInternalTemplateParams {
  appName: string;
  category: string;
  message: string;
  userId: string;
  username?: string | null;
  email?: string | null;
  imageUrl?: string | null;
}

/**
 * @param params - Feedback context for the ops team
 */
export function getFeedbackInternalTemplate(params: FeedbackInternalTemplateParams): string {
  const { appName, category, message, userId, username, email, imageUrl } = params;
  const escapedMessage = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br/>');

  return buildEmailHtml({
    title: `[Feedback] ${category} — ${appName}`,
    heading: `New ${category.replace(/_/g, ' ')}`,
    bodyHtml: `
      <p><strong>User:</strong> ${username ?? '—'} (${userId})</p>
      <p><strong>Email:</strong> ${email ?? '—'}</p>
      <p><strong>Category:</strong> ${category}</p>
      <p><strong>Message:</strong></p>
      <p style="padding: 12px; background: #f4f4f5; border-radius: 6px;">${escapedMessage}</p>
      ${imageUrl ? `<p><strong>Screenshot:</strong> <a href="${imageUrl}">${imageUrl}</a></p>` : ''}
    `,
  });
}
