/**
 * GitHub repository configuration
 */
export interface GitHubRepoConfig {
  /** Repository owner (e.g., 'octocat') */
  owner: string;
  /** Repository name (e.g., 'Hello-World') */
  repo: string;
  /** Default branch (e.g., 'main') */
  defaultBranch: string;
  /** GitHub personal access token with workflow permissions */
  token: string;
}

/**
 * Workflow dispatch parameters
 */
export interface WorkflowDispatchParams {
  /** Workflow file name (e.g., 'retry-pending-generations.yml') */
  workflowFile: string;
  /** Git reference (branch/tag) to run workflow on (defaults to repo default branch) */
  ref?: string;
  /** Workflow inputs (key-value pairs) */
  inputs?: Record<string, string>;
}

/**
 * Workflow dispatch options
 */
export interface WorkflowDispatchOptions {
  /** Context for logging (e.g., 'GET /candidates/status') */
  context?: string;
  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in milliseconds (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds (default: 4000) */
  maxDelayMs?: number;
}

/**
 * Workflow dispatch result
 */
export interface WorkflowDispatchResult {
  /** Whether the workflow was triggered successfully */
  success: boolean;
  /** Error message if dispatch failed */
  error?: string;
  /** Whether the workflow was already disabled (non-retryable error) */
  disabled?: boolean;
}