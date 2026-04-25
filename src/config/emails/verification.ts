/**
 * Email Verification Template
 * 
 * Generates HTML template for email verification emails.
 * 
 * @param appName - Application name
 * @param verificationUrl - Email verification URL with token
 * @returns HTML string for the email template
 * 
 * @example
 * ```typescript
 * const html = getVerificationTemplate('Twistloom', 'https://app.com/verify-email?token=abc123');
 * ```
 */
export function getVerificationTemplate(appName: string, verificationUrl: string): string {
  return `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Verify Your Email</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #333;">One step closer to the story.</h1>
            <p>You've chosen to enter ${appName}. Before the narrative begins, you must confirm your identity.</p>
            <p>Click the button to verify your email and unlock your journey:</p>
            <p>
              <a href="${verificationUrl}" style="display: inline-block; padding: 12px 24px; background-color: #007bff; color: white; text-decoration: none; border-radius: 4px;">Verify Email</a>
            </p>
            <p>Or copy and paste this link into your browser:</p>
            <p style="word-break: break-all; color: #666;">${verificationUrl}</p>
            <p style="color: #666; font-size: 14px;">This invitation expires in 24 hours.</p>
          </div>
        </body>
        </html>
      `;
}
