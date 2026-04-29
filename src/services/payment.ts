import { dbWrite } from "../db/client.js";
import { processedEvents, transactions } from "../db/schema.js";
import { eq, sql, and, desc } from "drizzle-orm";
import { getErrorMessage } from "../utils/error.js";

/**
 * Cleanup and recovery for processed events without corresponding transactions
 * 
 * Finds processed_events entries that don't have matching successful transactions
 * and attempts to recover by either:
 * 1. Creating missing transaction records (if possible)
 * 2. Cleaning up orphaned processed_events entries
 * 
 * This handles the race condition where webhook dies after inserting
 * into processed_events but before completing the payment transaction.
 * 
 * @returns Cleanup statistics
 */
export async function cleanupOrphanedProcessedEvents(): Promise<{
  eventsProcessed: number;
  transactionsRecovered: number;
  eventsCleaned: number;
}> {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  
  // Find processed events from last 10 minutes without corresponding successful transactions
  const orphanedEvents = await dbWrite
    .select({
      eventId: processedEvents.eventId,
      processedAt: processedEvents.processedAt,
    })
    .from(processedEvents)
    .leftJoin(
      transactions,
      eq(processedEvents.eventId, transactions.stripeEventId)
    )
    .where(
      and(
        eq(processedEvents.processedAt, tenMinutesAgo),
        sql`${transactions.stripeEventId} IS NULL` // No corresponding transaction
      )
    )
    .orderBy(desc(processedEvents.processedAt))
    .limit(50); // Process up to 50 orphaned events per run

  let eventsProcessed = 0;
  let transactionsRecovered = 0;
  let eventsCleaned = 0;

  for (const orphanedEvent of orphanedEvents) {
    eventsProcessed++;
    
    try {
      // Try to find if we have the payment data to recover this transaction
      if (orphanedEvent.eventId.startsWith('evt_')) {
        // For webhook events, we can't recover the transaction without additional data
        // Just clean up the orphaned event
        console.log(`[cleanup] 🗑️ Removing orphaned webhook event: ${orphanedEvent.eventId}`);
        await dbWrite
          .delete(processedEvents)
          .where(eq(processedEvents.eventId, orphanedEvent.eventId));
        eventsCleaned++;
      } else {
        console.log(`[cleanup] ⚠️ Found orphaned event but cannot recover: ${orphanedEvent.eventId}`);
        eventsCleaned++;
      }
    } catch (error) {
      console.error(`[cleanup] ❌ Failed to process orphaned event ${orphanedEvent.eventId}:`, getErrorMessage(error));
    }
  }

  return {
    eventsProcessed,
    transactionsRecovered,
    eventsCleaned,
  };
}