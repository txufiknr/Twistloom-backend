import type { BetaDutyRule } from "../types/beta-duties.js";

/**
 * Single Source of Truth (SSOT) for Twistloom's Beta Tester Duty Registry.
 *
 * Each duty represents an essential mission for beta testers to explore,
 * test writing tools, provide feedback, and shape the platform.
 * Rewards are claimable individually once completed.
 */
export const BETA_DUTY_REGISTRY: BetaDutyRule[] = [
  {
    id: 'bd_create_pen',
    titleKey: 'modal.checklist.createPenBook',
    descriptionKey: 'modal.checklist.createPenBookDesc',
    rewardCredits: 100,
    iconName: 'PenTool',
    actionPath: '/pen',
    order: 1,
  },
  {
    id: 'bd_publish_page',
    titleKey: 'modal.checklist.finalizeFirstPage',
    descriptionKey: 'modal.checklist.finalizeFirstPageDesc',
    rewardCredits: 100,
    iconName: 'FileText',
    actionPath: '/pen',
    order: 2,
  },
  {
    id: 'bd_finish_writing',
    titleKey: 'modal.checklist.finishWriting',
    descriptionKey: 'modal.checklist.finishWritingDesc',
    rewardCredits: 100,
    iconName: 'CheckCircle2',
    actionPath: '/pen',
    order: 3,
  },
  {
    id: 'bd_send_feedback',
    titleKey: 'modal.checklist.sendFeedback',
    descriptionKey: 'modal.checklist.sendFeedbackDesc',
    rewardCredits: 50,
    iconName: 'MessageSquare',
    order: 4,
  },
  {
    id: 'bd_platform_testimony',
    titleKey: 'modal.checklist.submitTestimony',
    descriptionKey: 'modal.checklist.submitTestimonyDesc',
    rewardCredits: 150,
    iconName: 'Sparkles',
    order: 5,
  },
];
