/**
 * Password Reset Email Template
 * 
 * Generates HTML template for password reset emails.
 * 
 * @param appName - Application name
 * @param resetUrl - Password reset URL with token
 * @returns HTML string for the email template
 * 
 * @example
 * ```typescript
 * const html = getPasswordResetTemplate('Twistloom', 'https://app.com/reset-password?token=abc123');
 * ```
 */
export function getPasswordResetTemplate(appName: string, resetUrl: string): string {
  return `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Reset Your Password</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #333;">The keys to your story.</h1>
            <p>Someone requested to reset your password for ${appName}. If that was you, the path forward lies below.</p>
            <p>Click the button to reclaim your narrative:</p>
            <p>
              <a href="${resetUrl}" style="display: inline-block; padding: 12px 24px; background-color: #007bff; color: white; text-decoration: none; border-radius: 4px;">Reset Password</a>
            </p>
            <p>Or copy and paste this link into your browser:</p>
            <p style="word-break: break-all; color: #666;">${resetUrl}</p>
            <p style="color: #666; font-size: 14px;">This gateway closes in 1 hour.</p>
            <p style="color: #666; font-size: 14px;">If you didn't request this, ignore this message—your story remains secure.</p>
          </div>
        </body>
        </html>
      `;
}
