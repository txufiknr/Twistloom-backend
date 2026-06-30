/**
 * GitHub workflow dispatch and cancellation utility functions
 * 
 * Provides reusable functions for triggering and cancelling GitHub Actions
 * workflows via REST API. Handles retry logic, error detection, and proper logging.
 */

import { GITHUB_DEFAULT_BRANCH, GITHUB_REPO_NAME, GITHUB_REPO_OWNER } from '../config/env.js';
import type { GitHubRepoConfig, WorkflowDispatchOptions, WorkflowDispatchParams, WorkflowDispatchResult } from '../types/github-workflow.js';
import type { ErrorWithCustomProperties } from './retry.js';
import { retryWithBackoff } from './retry.js';

/**
 * Validates GitHub workflow configuration at startup
 * 
 * This function checks if the required environment variables for GitHub workflow
 * triggering are properly configured. It logs a warning if any are missing.
 * 
 * Should be called during application startup to fail fast if configuration is invalid.
 */
export function validateGitHubWorkflowConfig(): void {
  const token = process.env.GITHUB_WORKFLOW_TOKEN;
  const repoOwner = GITHUB_REPO_OWNER;
  const repoName = GITHUB_REPO_NAME;
  const branch = GITHUB_DEFAULT_BRANCH;

  const missing: string[] = [];
  if (!token) missing.push('GITHUB_WORKFLOW_TOKEN');
  if (!repoOwner) missing.push('GITHUB_REPO_OWNER');
  if (!repoName) missing.push('GITHUB_REPO_NAME');
  if (!branch) missing.push('GITHUB_DEFAULT_BRANCH');

  if (missing.length > 0) {
    console.error('⚠️ GitHub workflow configuration incomplete. Missing environment variables:', missing.join(', '));
    console.error('⚠️ On-demand candidate generation will not work without these variables.');
    console.error('⚠️ Please set them in your environment or .env.local file.');
  } else {
    console.log('✅ GitHub workflow configuration validated successfully');
  }
}

/**
 * Triggers a GitHub Actions workflow via REST API
 * 
 * This function dispatches a workflow run using GitHub's REST API with retry logic
 * for transient failures. It detects and handles disabled workflows gracefully.
 * 
 * **Retry Logic**: Retries up to 3 times with exponential backoff (1s, 2s, 4s) for:
 * - 429 (Rate limit)
 * - 502 (Bad gateway)
 * - 503 (Service unavailable)
 * - 504 (Gateway timeout)
 * 
 * **Non-Retryable Errors**: Immediately fails for:
 * - 422 with "Cannot trigger a 'workflow_dispatch' on a disabled workflow"
 * - Other 4xx errors (except 429)
 * 
 * @param config - GitHub repository configuration
 * @param params - Workflow dispatch parameters
 * @param options - Dispatch options
 * @returns Promise resolving to dispatch result
 * 
 * @example
 * ```typescript
 * const result = await dispatchGitHubWorkflow(
 *   {
 *     owner: 'myorg',
 *     repo: 'myrepo',
 *     defaultBranch: 'main',
 *     token: process.env.GITHUB_TOKEN!
 *   },
 *   {
 *     workflowFile: 'retry-pending-generations.yml',
 *     inputs: { book_id: '123', page_id: '456' }
 *   },
 *   { context: 'GET /candidates/status' }
 * );
 * 
 * if (result.success) {
 *   console.log('Workflow triggered successfully');
 * } else if (result.disabled) {
 *   console.error('Workflow is disabled');
 * } else {
 *   console.error('Failed to trigger workflow:', result.error);
 * }
 * ```
 */
export async function dispatchGitHubWorkflow(
  config: GitHubRepoConfig,
  params: WorkflowDispatchParams,
  options: WorkflowDispatchOptions = {}
): Promise<WorkflowDispatchResult> {
  const { owner, repo, defaultBranch, token } = config;
  if (!token) throw new Error('GitHub workflow token not configured');

  const { workflowFile, ref = defaultBranch, inputs = {} } = params;
  const { context = 'dispatchGitHubWorkflow', maxRetries = 3, baseDelayMs = 1000, maxDelayMs = 4000 } = options;

  console.log(`[${context}] 🚀 Triggering GitHub workflow: ${workflowFile}`);

  try {
    await retryWithBackoff(
      async () => {
        console.log(`[${context}] 📡 Dispatching workflow: ${workflowFile}`);

        const response = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`,
          {
            method: 'POST',
            headers: {
              'Authorization': `token ${token}`,
              'Accept': 'application/vnd.github.v3+json',
              'Content-Type': 'application/json',
              'User-Agent': 'Twistloom-Backend'
            },
            body: JSON.stringify({
              ref,
              inputs
            })
          }
        );

        if (response.ok) {
          console.log(`[${context}] ✅ Workflow dispatched successfully: ${workflowFile}`);
          return;
        }

        const errorText = await response.text();
        const error = new Error(`GitHub API error: ${response.status} ${response.statusText}`) as ErrorWithCustomProperties;
        error.code = `GITHUB_API_${response.status}`;

        // Check for disabled workflow error (non-retryable)
        if (response.status === 422 && errorText.includes('disabled workflow')) {
          console.error(`[${context}] ✋ Workflow is disabled: ${workflowFile}`);
          error.shouldRetry = false;
          throw error;
        }

        // Mark as non-retryable for non-transient errors
        const isRetryable = response.status === 429 || // Rate limit
                            response.status === 502 || // Bad gateway
                            response.status === 503 || // Service unavailable
                            response.status === 504;  // Gateway timeout

        if (!isRetryable) {
          error.shouldRetry = false;
        }

        console.error(`[${context}] ❌ GitHub API error:`, {
          status: response.status,
          statusText: response.statusText,
          body: errorText,
          retryable: isRetryable
        });

        throw error;
      },
      {
        maxRetries,
        baseDelayMs,
        maxDelayMs,
        exponentialBackoff: true,
        shouldRetry: (error) => {
          const err = error as ErrorWithCustomProperties;
          return err.shouldRetry !== false;
        },
        onRetry: (attempt, error) => {
          console.log(`[${context}] 🔄 Retrying workflow dispatch (attempt ${attempt}/${maxRetries}):`, error);
        }
      }
    );

    return { success: true };

  } catch (error) {
    const err = error as ErrorWithCustomProperties;
    const errorMessage = err.message || String(error);
    
    // Check if error is due to disabled workflow
    if (!err.shouldRetry && errorMessage.includes('disabled workflow')) {
      console.error(`[${context}] ✋ Workflow dispatch failed: ${workflowFile} is disabled`);
      return { success: false, error: errorMessage, disabled: true };
    }

    console.error(`[${context}] ❌ Failed to dispatch workflow: ${workflowFile}`, errorMessage);
    return { success: false, error: errorMessage };
  }
}

/**
 * Cancels active GitHub Actions workflow runs for a given workflow file.
 *
 * Lists all in_progress and queued runs and cancels them via the GitHub REST
 * API. This is a best-effort operation — it does not throw on failure so the
 * caller can continue with other teardown work (DB status update, refund).
 *
 * **Race note:**
 * After cancellation the running process receives SIGTERM from GitHub with a
 * 7.5 s grace period before SIGKILL. The catch block in the runner may fire
 * `updateBookGenerationStatus({ status: 'failed' })`. Setting the DB status
 * to `'cancelled'` **after** calling this function ensures cancellation
 * wins in any race with the dying runner.
 *
 * @param config  - GitHub repository configuration
 * @param params  - Workflow file name to cancel runs for
 * @param options - Cancel options (context for logging)
 * @returns Object with `cancelledCount` and any `errors` encountered
 *
 * @example
 * ```typescript
 * const { cancelledCount } = await cancelGitHubWorkflowRuns(
 *   GITHUB_REPO_CONFIG,
 *   { workflowFile: 'on-demand-book-creation.yml' },
 *   { context: 'POST /api/books/:bookId/cancel' }
 * );
 * ```
 */
export async function cancelGitHubWorkflowRuns(
  config: GitHubRepoConfig,
  params: { workflowFile: string },
  options: WorkflowDispatchOptions = {}
): Promise<{ cancelledCount: number; errors: string[] }> {
  const { owner, repo, token } = config;
  const context = options.context || 'cancelGitHubWorkflowRuns';
  const result: { cancelledCount: number; errors: string[] } = {
    cancelledCount: 0,
    errors: [],
  };

  if (!token) {
    console.warn(`[${context}] ⚠️ GitHub token not configured, skipping workflow cancellation`);
    result.errors.push('GitHub token not configured');
    return result;
  }

  const { workflowFile } = params;

  try {
    // Gather runs in both queued and in_progress states
    const statuses = ['in_progress', 'queued'];
    const allRuns: Array<{ id: number; status: string }> = [];

    for (const status of statuses) {
      const listUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?status=${status}&per_page=100`;

      const listResponse = await fetch(listUrl, {
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Twistloom-Backend',
        },
      });

      if (listResponse.ok) {
        const listData = (await listResponse.json()) as { workflow_runs: Array<{ id: number; status: string }> };
        allRuns.push(...(listData.workflow_runs || []));
      } else {
        const errorText = await listResponse.text();
        console.warn(`[${context}] ⚠️ Failed to list ${status} runs: ${listResponse.status} ${errorText}`);
      }
    }

    if (allRuns.length === 0) {
      console.log(`[${context}] ℹ️ No active runs found for ${workflowFile}`);
      return result;
    }

    console.log(`[${context}] 🔴 Cancelling ${allRuns.length} active run(s) for ${workflowFile}`);

    for (const run of allRuns) {
      try {
        const cancelUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${run.id}/cancel`;
        const cancelResponse = await fetch(cancelUrl, {
          method: 'POST',
          headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Twistloom-Backend',
          },
        });

        if (cancelResponse.ok || cancelResponse.status === 202) {
          console.log(`[${context}] ✅ Cancelled workflow run ${run.id}`);
          result.cancelledCount++;
        } else {
          const errorText = await cancelResponse.text();
          console.error(`[${context}] ❌ Failed to cancel workflow run ${run.id}: ${cancelResponse.status} ${errorText}`);
          result.errors.push(`Failed to cancel run ${run.id}: ${cancelResponse.status}`);
        }
      } catch (cancelError) {
        console.error(`[${context}] ❌ Error cancelling workflow run ${run.id}:`, cancelError);
        result.errors.push(`Error cancelling run ${run.id}: ${String(cancelError)}`);
      }
    }

    return result;
  } catch (error) {
    console.error(`[${context}] ❌ Failed to cancel workflow runs:`, error);
    result.errors.push(`Failed to cancel workflow runs: ${String(error)}`);
    return result;
  }
}
