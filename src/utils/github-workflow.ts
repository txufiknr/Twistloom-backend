/**
 * GitHub workflow dispatch utility functions
 * 
 * Provides reusable functions for triggering GitHub Actions workflows via REST API.
 * Handles retry logic, error detection, and proper logging.
 */

import type { GitHubRepoConfig, WorkflowDispatchOptions, WorkflowDispatchParams, WorkflowDispatchResult } from '../types/github-workflow.js';
import type { ErrorWithCustomProperties } from './retry.js';
import { retryWithBackoff } from './retry.js';

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
