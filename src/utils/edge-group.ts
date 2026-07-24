/**
 * Edge-compatible collapsible log grouping
 *
 * Replaces @actions/core's group() which depends on Node.js process/fs APIs.
 * Uses ::group:: / ::endgroup:: workflow command markers which work in both
 * GitHub Actions CI and standard log environments like Vercel/Edge.
 */
export const edgeGroup = {
  start: (title: string): void => {
    console.log(`::group::${title}`);
  },

  end: (): void => {
    console.log('::endgroup::');
  },

  wrap: async <T>(title: string, callback: () => Promise<T> | T): Promise<T> => {
    console.log(`::group::${title}`);
    try {
      return await callback();
    } finally {
      console.log('::endgroup::');
    }
  }
};
