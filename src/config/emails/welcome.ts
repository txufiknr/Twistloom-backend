/**
 * Welcome Email Template
 * 
 * Generates HTML template for welcome emails sent after successful signup.
 * 
 * @param appName - Application name
 * @param username - User's username
 * @returns HTML string for the email template
 * 
 * @example
 * ```typescript
 * const html = getWelcomeTemplate('Twistloom', 'johndoe');
 * ```
 */
export function getWelcomeTemplate(appName: string, username: string): string {
  return `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Welcome to ${appName}</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #333;">The story begins, ${username}.</h1>
            <p>You've stepped into ${appName}—where every choice shapes reality, and every decision could be your last.</p>
            <p>This isn't just a platform. It's a living narrative engine that responds to your every move, twisting and turning with the weight of your choices.</p>
            <p>Create stories that grip readers by the throat. Explore narratives that fight back. Build worlds where nothing is as it seems.</p>
            <p>I'm <strong>Taufik</strong>, the creator of ${appName}. I built this because I believe stories should be more than words on a page—they should be experiences that leave you breathless.</p>
            <p>Your first chapter awaits.</p>
            <p style="color: #666; font-style: italic;">Remember: in ${appName}, the story never ends the way you expect.</p>
            <p>See you in the narrative,<br>Taufik<br><em style="color: #666;">Creator, ${appName}</em></p>
          </div>
        </body>
        </html>
      `;
}
