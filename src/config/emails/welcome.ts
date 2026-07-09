/**
 * Welcome Email Template
 *
 * Generates HTML template for welcome emails sent after successful signup.
 * Uses the shared base layout.
 *
 * @param appName - Application display name (e.g. "Twistloom")
 * @param username - New user's chosen username
 * @returns Complete email HTML string
 *
 * @example
 * ```typescript
 * const html = getWelcomeTemplate('Twistloom', 'johndoe');
 * ```
 */

import { buildEmailHtml } from './base-layout.js';

export function getWelcomeTemplate(appName: string, username: string): string {
  return buildEmailHtml({
    title: `Welcome to ${appName}`,
    heading: `The story begins, ${username}.`,
    bodyHtml: `
      <p>You've stepped into ${appName} — where every choice shapes reality, and every decision could be your last.</p>
      <p>This isn't just a platform. It's a living narrative engine that responds to your every move, twisting and turning with the weight of your choices.</p>
      <p>Create stories that grip readers by the throat. Explore narratives that fight back. Build worlds where nothing is as it seems.</p>
      <p>I'm <strong>Taufik</strong>, the creator of ${appName}. I built this because I believe stories should be more than words on a page — they should be experiences that leave you breathless.</p>
      <p>Your first chapter awaits. Dive in, and remember: in ${appName}, the story never ends the way you expect.</p>
    `,
    footerHtml: `
      <p style="font-style: italic;">See you in the narrative,<br>Taufik<br><em style="color: #999;">Creator, ${appName}</em></p>
    `,
  });
}
