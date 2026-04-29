// Payment service module
// This file previously contained cleanupOrphanedProcessedEvents function which was
// part of the event-first pattern workaround for neon-http.
// Now that we use neon-serverless with transaction support, this function is no longer needed.