/**
 * Deletes the shared browser/native session control plane inside the caller's
 * credential-change transaction. Refresh families cascade with session deletion.
 * The caller also bumps users.tokenVersion so issued native credentials fail.
 */
import { eq } from "drizzle-orm";
import { authSessions } from "../db/schema.js";
import type { SessionExecutor } from "./session-manager.js";

export async function deleteUserSessions(userId: string, executor: SessionExecutor): Promise<void> {
  await executor.delete(authSessions).where(eq(authSessions.userId, userId));
}
