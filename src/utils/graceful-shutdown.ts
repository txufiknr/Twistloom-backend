/**
 * Graceful shutdown utilities for clean process termination
 */

let shuttingDown = false;

/**
 * Check if shutdown process has started
 * @returns {boolean} True if shutting down
 */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Register cleanup handlers for graceful shutdown
 * @param cleanup - Async cleanup function to run before exit
 * @param timeoutMs - Max time to wait for cleanup (default: 10s)
 */
export function registerGracefulShutdown(
  cleanup: () => Promise<void> | void,
  timeoutMs = 10_000
) {
  const handler = async (signal: string) => {
    // Prevent duplicate shutdowns
    if (shuttingDown) return;
    shuttingDown = true;

    // Log shutdown signal
    console.log(`[shutdown] ${signal} received`);

    // Force exit if cleanup takes too long
    const timer = setTimeout(() => {
      console.warn("[shutdown] forced exit");
      process.exit(1);
    }, timeoutMs);

    try {
      // Run cleanup function
      await cleanup();
      // Cancel forced exit timer
      clearTimeout(timer);
      // Clean exit
      process.exit(0);
    } catch (err) {
      // Log cleanup failure
      console.error("[shutdown] cleanup failed", err);
      // Exit with error
      process.exit(1);
    }
  };

  // Register signal handlers
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}
