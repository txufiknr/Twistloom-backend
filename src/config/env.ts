import type { GitHubRepoConfig } from "../types/github-workflow.js";

/** Environment flag for development vs production behavior */
export const IS_PRODUCTION = process.env.NODE_ENV === "production";
export const IS_DEVELOPMENT = process.env.NODE_ENV === "development";
export const IS_TEST = (process.env.NODE_ENV ?? "test") === "test";
export const DEV_USE_SECURE_COOKIES = process.env.DEV_USE_SECURE_COOKIES === 'true';

/** Cloud / Runtime environment detection */
export const IS_VERCEL = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
export const IS_GITHUB_ACTIONS = Boolean(process.env.GITHUB_ACTIONS);

/** Default server port */
export const PORT: number = Number(process.env.PORT) || 3000;

/** Feature flag gating the multi-turn (stage-split) page generation pipeline.
 * See MULTI_TURN_PAGE_GENERATION_ROADMAP.md Part 3 Phase 8. Read at module
 * load (same pattern as IS_PRODUCTION); use `isMultiTurnGenerationEnabled()`
 * for dynamic per-request toggling without a process restart. */
export const USE_MULTI_TURN_GENERATION: boolean = process.env.USE_MULTI_TURN_GENERATION === 'true';

/** Live (per-call) read of the multi-turn flag — supports dynamic dev toggling
 * without a restart, unlike the module-load `USE_MULTI_TURN_GENERATION`. */
export function isMultiTurnGenerationEnabled(): boolean {
  return process.env.USE_MULTI_TURN_GENERATION === 'true';
}

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