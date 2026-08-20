/**
 * Lifecycle state of a beta duty for a single user.
 *
 * - `in_progress` — the goal is not yet met.
 * - `completed` — detected as met, reward pending claim.
 * - `claimed`   — reward has been redeemed.
 */
export type BetaDutyStatus = 'in_progress' | 'completed' | 'claimed';

export type BetaDutyId =
  | 'bd_create_pen'
  | 'bd_publish_page'
  | 'bd_finish_writing'
  | 'bd_send_feedback'
  | 'bd_platform_testimony';

export interface BetaDutyRule {
  id: BetaDutyId;
  titleKey: string;
  descriptionKey: string;
  rewardCredits: number;
  iconName: 'PenTool' | 'FileText' | 'CheckCircle2' | 'MessageSquare' | 'Sparkles';
  actionPath?: string;
  order: number;
}

export interface UserBetaDutyState {
  id: BetaDutyId;
  titleKey: string;
  descriptionKey: string;
  rewardCredits: number;
  status: BetaDutyStatus;
  completedAt: string | null;
  claimedAt: string | null;
  actionPath?: string;
  iconName: string;
  order: number;
}

export interface BetaDutiesSummary {
  completed: number;
  claimable: number;
  totalReward: number;
  unclaimedReward: number;
  allDone: boolean;
}
