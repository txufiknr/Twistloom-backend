import { IS_VERCEL } from "../config/env.js";

/**
 * Edge-compatible collapsible log grouping
 *
 * Replaces @actions/core's group() which depends on Node.js process/fs APIs.
 * Uses ::group:: / ::endgroup:: workflow command markers which work in GitHub Actions CI.
 *
 * On Vercel serverless environments, skips ::group:: markers and wrapper overhead
 * to conserve Fluid Active CPU cycles.
 */
export const edgeGroup = {
  start: (title: string): void => {
    if (IS_VERCEL) return;
    console.log(`::group::${title}`);
  },

  end: (): void => {
    if (IS_VERCEL) return;
    console.log('::endgroup::');
  },

  wrap: async <T>(title: string, callback: () => Promise<T> | T): Promise<T> => {
    if (IS_VERCEL) {
      return await callback();
    }
    console.log(`::group::${title}`);
    try {
      return await callback();
    } finally {
      console.log('::endgroup::');
    }
  }
};
