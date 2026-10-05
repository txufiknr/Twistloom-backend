import type { DBUser } from '../types/schema.js';
import { isUserVipActive } from './subscription.js';

/** Public profile update response. An allowlist remains safe when new credential,
 * moderation or recovery columns are added to users in the future. */
export function publicUpdatedProfile(user: DBUser) {
  return {
    id: user.userId, name: user.name, username: user.username, email: user.email,
    bio: user.bio, gender: user.gender, imageUrl: user.imageUrl,
    avatarFrame: user.avatarFrame, profileTitle: user.profileTitle,
    pinnedStoryIds: user.pinnedStoryIds, featuredStoryId: user.featuredStoryId,
    featuredStoryNote: user.featuredStoryNote, favoriteStoryIds: user.favoriteStoryIds,
    loreStatusText: user.loreStatusText, loreStatusIcon: user.loreStatusIcon,
    loreStatusStoryId: user.loreStatusStoryId, loreStatusUpdatedAt: user.loreStatusUpdatedAt, loreStatusExpiresAt: user.loreStatusExpiresAt, credits: user.credits, isNewUser: user.isNewUser,
    isBetaTester: user.isBetaTester, preferredLocale: user.preferredLocale,
    emailPreferences: user.emailPreferences, inAppPreferences: user.inAppPreferences,
    privacyPreferences: user.privacyPreferences, createdAt: user.createdAt,
    updatedAt: user.updatedAt, lastActive: user.lastActive,
    hasReferrer: Boolean(user.referrerId), subscription: { tier: user.tier },
    isVip: isUserVipActive({ tier: user.tier, vipExpiresAt: user.vipExpiresAt }),
  };
}
