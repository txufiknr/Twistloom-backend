/** Idempotent campaign producer; the shared worker owns delivery. */
import { queueMonthlyEmailCampaign } from '../services/email-campaigns.js';
import { dispatchEmailWorkers } from '../services/email-dispatch.js';
export async function runMonthlyActivitySummaryEmail(): Promise<void> {
  const id = await queueMonthlyEmailCampaign();
  await dispatchEmailWorkers(`campaign/${id}`);
}
if (import.meta.main) await runMonthlyActivitySummaryEmail();
