/**
 * Feedback Acknowledgment Email Template
 *
 * Generates HTML for the thank-you email sent after a user submits feedback.
 * Confirms receipt, apologizes for any inconvenience, and reassures that the
 * team will address the issue as soon as possible.
 *
 * @param appName - Application display name (e.g. "Twistloom")
 * @param name - User's display name for personalisation
 * @returns Complete email HTML string
 *
 * @example
 * ```typescript
 * const html = getFeedbackAcknowledgmentTemplate('Twistloom', 'Jane');
 * ```
 */

import { buildEmailHtml } from './base-layout.js';

export function getFeedbackAcknowledgmentTemplate(appName: string, name: string): string {
  return buildEmailHtml({
    title: `We Received Your Feedback — ${appName}`,
    heading: `Thank you for reaching out, ${name}.`,
    bodyHtml: `
      <p>We've received your message and truly appreciate you taking the time to let us know.</p>
      <p>We're sorry for any inconvenience this may have caused. Our team will review your feedback and address the issue as soon as possible.</p>
      <p>Your input helps us make ${appName} better for everyone — thank you for being part of the story.</p>
    `,
    footerHtml: `
      <p>No action needed on your end. We'll follow up if we need more details.</p>
    `,
  });
}
