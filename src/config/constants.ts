/** Application constants and configuration */
export const APP_NAME: string = 'Twistloom';
export const APP_NAME_SLUG: string = 'twistloom';
export const APP_DESCRIPTION = 'Where your choices shape the story. Step into psychological thrillers that adapt to every decision you make.';
export const APP_TAGLINE = 'AI-powered platform for creating and reading interactive branching thriller stories.';
export const APP_TAGLINE_SHORT = 'AI Thriller Story Generator';
export const APP_WEB_URL = 'https://twistloom-backend.vercel.app';
export const APP_EMAIL = 'admin@twistloom.com';

/**
 * Application version from npm_package_version env var (injected by Vercel at build time)
 */
export const VERSION: string = process.env['npm_package_version'] || '1.0.0';