import type { GitHubRepoConfig } from "../types/github-workflow.js";

/** Environment flag for development vs production behavior */
export const IS_PRODUCTION = process.env.NODE_ENV === "production";
export const IS_DEVELOPMENT = process.env.NODE_ENV === "development";
export const IS_TEST = (process.env.NODE_ENV ?? "test") === "test";
export const DEV_USE_SECURE_COOKIES = process.env.DEV_USE_SECURE_COOKIES === 'true';

/**
 * Cloud / Runtime environment detection: true on any serverless platform.
 *
 * Semantics are "am I running inside a serverless function?", not "am I on a
 * specific vendor?" — consumers use it for serverless log frugality, reduced
 * diagnostics, and platform-provided execution limits. Recognizes Vercel
 * (`VERCEL` / `VERCEL_ENV`) and Netlify (`NETLIFY`), so switching platforms
 * never silently flips production behavior into local-dev mode.
 */
export const IS_SERVERLESS = Boolean(
  process.env.VERCEL || process.env.VERCEL_ENV || process.env.NETLIFY
);
export const IS_GITHUB_ACTIONS = Boolean(process.env.GITHUB_ACTIONS);

/** Default server port */
export const PORT: number = Number(process.env.PORT) || 3000;

/** Github repo */
export const GITHUB_REPO_OWNER = process.env.GITHUB_REPO_OWNER || "txufiknr";
export const GITHUB_REPO_NAME = process.env.GITHUB_REPO_NAME || "Twistloom-backend";
export const GITHUB_DEFAULT_BRANCH = process.env.GITHUB_DEFAULT_BRANCH || "main";

// GitHub repository configuration for workflow dispatch
export const GITHUB_REPO_CONFIG: GitHubRepoConfig = {
  owner: GITHUB_REPO_OWNER,
  repo: GITHUB_REPO_NAME,
  defaultBranch: GITHUB_DEFAULT_BRANCH,
  token: process.env.GITHUB_WORKFLOW_TOKEN
};