/**
 * Email Templates Index
 *
 * Centralised barrel export for all transactional email template functions.
 * Every template uses the shared `buildEmailHtml` layout for visual consistency.
 *
 * @example
 * ```typescript
 * import { getPasswordResetTemplate, getTrialEndingTemplate } from '../config/emails/index.js';
 *
 * const html = getPasswordResetTemplate('Twistloom', 'https://...');
 * ```
 */

export { getPasswordResetTemplate } from './password-reset.js';
export { getVerificationTemplate } from './verification.js';
export { getWelcomeTemplate } from './welcome.js';
export { getTrialEndingTemplate } from './trial-ending.js';
