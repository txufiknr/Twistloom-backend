/**
 * Shared Email HTML Layout
 *
 * Provides the common HTML structure used by all transactional email templates.
 * Styled to match Twistloom's brand identity:
 *   - Background: #faf8f5 (warm off-white)
 *   - Primary: #8b0000 (deep crimson) for CTAs and accents
 *   - Text: #1a1a1a (near-black)
 *   - Logo displayed at the top
 *
 * Dark mode colours are defined via an inline `<style>` block with a
 * `prefers-color-scheme: dark` media query — broadly supported across
 * Apple Mail, Outlook.com, and Gmail (in-app).
 *
 * @example
 * ```typescript
 * import { buildEmailHtml } from './base-layout.js';
 *
 * const html = buildEmailHtml({
 *   title: 'Reset Your Password',
 *   heading: 'The keys to your story.',
 *   bodyHtml: `<p>Someone requested to reset your password...</p>`,
 *   button: { url: resetUrl, text: 'Reset Password' },
 *   plainUrl: resetUrl,
 * });
 * ```
 */

/** Twistloom brand logo for email headers */
const LOGO_URL = 'https://twistloom-web.vercel.app/images/logo/logo_192.png';

export interface EmailButton {
  /** Button link target */
  url: string;
  /** Button label text */
  text: string;
}

export interface EmailLayoutParams {
  /** HTML `<title>` tag content */
  title: string;
  /** `<h1>` heading displayed below the logo */
  heading: string;
  /** Inner HTML for the body area (paragraphs, etc.) */
  bodyHtml: string;
  /** Optional CTA button rendered below the body */
  button?: EmailButton;
  /** Optional plain-text URL displayed below the button for copy-paste fallback */
  plainUrl?: string;
  /** Optional footer content (rendered in muted text below a divider) */
  footerHtml?: string;
}

/**
 * Wraps template content in the standard Twistloom-branded email frame.
 *
 * @param params - Layout parameters
 * @returns Complete HTML string ready for Resend
 */
export function buildEmailHtml(params: EmailLayoutParams): string {
  const { title, heading, bodyHtml, button, plainUrl, footerHtml } = params;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${title}</title>
  <style type="text/css">
    /* Dark mode overrides — supported by Apple Mail, Outlook.com, Gmail (in-app) */
    @media (prefers-color-scheme: dark) {
      .tl-email-body  { background-color: #0a0a0a !important; }
      .tl-email-card  { background-color: #1a1a1a !important; }
      .tl-email-text  { color: #e5e5e5 !important; }
      .tl-email-muted { color: #9ca3af !important; }
      .tl-email-heading { color: #e5e5e5 !important; }
      .tl-email-divider { border-top-color: #2d2d2d !important; }
      .tl-email-button { background-color: #dc2626 !important; color: #ffffff !important; }
      .tl-email-link { color: #dc2626 !important; }
    }
  </style>
</head>
<body class="tl-email-body" style="margin: 0; padding: 0; background-color: #faf8f5; font-family: 'Source Sans 3', 'Segoe UI', Arial, Helvetica, sans-serif; -webkit-font-smoothing: antialiased;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #faf8f5;">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <!-- Email container card -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width: 520px; width: 100%; background-color: #ffffff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);" class="tl-email-card">
          <tr>
            <td style="padding: 40px 32px 0 32px; text-align: center;">
              <!-- Logo -->
              <img src="${LOGO_URL}" alt="Twistloom" width="48" height="48" style="display: inline-block; border: 0; outline: none; width: 48px; height: 48px;" />
              <p style="margin: 8px 0 0 0; font-size: 18px; font-weight: 600; color: #8b0000; letter-spacing: 1px; text-transform: uppercase;">Twistloom</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 8px 32px 0 32px;">
              <!-- Divider -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="border-bottom: 1px solid #e5e5e5; line-height: 1px; font-size: 1px;" class="tl-email-divider">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding: 24px 32px 0 32px;">
              <h1 class="tl-email-heading" style="margin: 0 0 16px 0; font-size: 22px; font-weight: 700; color: #1a1a1a; line-height: 1.3;">${heading}</h1>
            </td>
          </tr>
          <tr>
            <td class="tl-email-text" style="padding: 0 32px; font-size: 15px; line-height: 1.7; color: #1a1a1a;">
              ${bodyHtml}
            </td>
          </tr>
          ${button ? `
          <tr>
            <td style="padding: 24px 32px 0 32px; text-align: center;">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${button.url}" style="height:44px;v-text-anchor:middle;" arcsize="10%" strokecolor="#8b0000" fillcolor="#8b0000">
                <w:anchorlock/>
                <center style="color:#ffffff;font-family:'Source Sans 3','Segoe UI',Arial,Helvetica,sans-serif;font-size:15px;font-weight:600;">${button.text}</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-->
              <a href="${button.url}" class="tl-email-button" style="display: inline-block; padding: 12px 28px; background-color: #8b0000; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 15px; font-weight: 600; letter-spacing: 0.3px;">
                ${button.text}
              </a>
              <!--<![endif]-->
            </td>
          </tr>
          ` : ''}
          ${plainUrl ? `
          <tr>
            <td class="tl-email-muted" style="padding: 16px 32px 0 32px; font-size: 13px; line-height: 1.5; color: #6b7280;">
              <p style="margin: 0 0 4px 0;">Or copy and paste this link into your browser:</p>
              <p style="margin: 0; word-break: break-all;"><a href="${plainUrl}" class="tl-email-link" style="color: #8b0000; text-decoration: underline;">${plainUrl}</a></p>
            </td>
          </tr>
          ` : ''}
          ${footerHtml ? `
          <tr>
            <td style="padding: 0 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="border-bottom: 1px solid #e5e5e5; line-height: 1px; font-size: 1px; padding-top: 24px;" class="tl-email-divider">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="tl-email-muted" style="padding: 16px 32px 0 32px; font-size: 13px; line-height: 1.5; color: #6b7280;">
              ${footerHtml}
            </td>
          </tr>
          ` : ''}
          <!-- Standard footer -->
          <tr>
            <td style="padding: 0 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="border-bottom: 1px solid #e5e5e5; line-height: 1px; font-size: 1px; padding-top: 24px;" class="tl-email-divider">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="tl-email-muted" style="padding: 16px 32px 32px 32px; font-size: 12px; line-height: 1.5; color: #6b7280; text-align: center;">
              <p style="margin: 0 0 4px 0;">&copy; ${new Date().getFullYear()} Twistloom. All rights reserved.</p>
              <p style="margin: 0;">This is an automated message from Twistloom — please do not reply to this email.</p>
            </td>
          </tr>
        </table>
        <!-- /Email container card -->
      </td>
    </tr>
  </table>
</body>
</html>`;
}
