/**
 * Email Templates Configuration
 * 
 * Centralized email templates for transactional emails.
 * All templates are exported as functions that return HTML strings.
 * 
 * @example
 * ```typescript
 * import { getPasswordResetTemplate, getVerificationTemplate, getWelcomeTemplate } from '../config/emails/index.js';
 * 
 * const resetHtml = getPasswordResetTemplate('Twistloom', 'https://app.com/reset-password?token=xxx');
 * ```
 */

export { getPasswordResetTemplate } from './password-reset.js';
export { getVerificationTemplate } from './verification.js';
export { getWelcomeTemplate } from './welcome.js';
