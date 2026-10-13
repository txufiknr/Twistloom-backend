/** Idempotent campaign producer; the shared worker owns delivery. */
import { queueWeeklyEmailCampaign } from '../services/email-campaigns.js';
import { dispatchEmailWorkers } from '../services/email-dispatch.js';
export async function runWeeklyRecommendationsEmail(): Promise<void> {
  const id = await queueWeeklyEmailCampaign();
  await dispatchEmailWorkers(`campaign/${id}`);
}
if (import.meta.main) await runWeeklyRecommendationsEmail();
