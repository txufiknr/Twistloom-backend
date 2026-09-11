import type { AchievementTier } from './achievements.js';
import type { BookMode } from './book.js';
import type { Archetype, StabilityTier } from './story.js';
import type { AvatarFrame, UserTier } from './user.js';

/** Wall Note types supported by the V1 API. */
export type WallPostType = 'text' | 'book_share' | 'ending_share' | 'achievement_share';

/** Topic flairs supported by the V1 Wall. */
export type WallPostFlair = 'general' | 'clue' | 'theory' | 'review' | 'recommendation' | 'celebration';

/** Story-native reactions supported on Wall Notes. */
export type WallReactionType = 'heart' | 'candle' | 'mind' | 'magnifier' | 'broken_heart';

/** Feed tabs accepted by the Wall read service. */
export type WallFeedTab = 'following' | 'discover';

/** Stable limits shared by Wall validation and entitlement responses. */
export const WALL_LIMITS = {
  freePostGraphemes: 200,
  vipPostGraphemes: 500,
  commentGraphemes: 500,
  defaultPageSize: 20,
  maximumPageSize: 50,
  maximumMentions: 5,
  maximumRawTextCodeUnits: 4_000,
  maximumCursorLength: 512,
} satisfies Record<string, number>;

/** Stable Wall error codes returned at API boundaries. */
export type WallErrorCode =
  | 'WALL_POST_NOT_FOUND'
  | 'WALL_POST_UNAVAILABLE'
  | 'WALL_POST_LOCKED'
  | 'WALL_NOT_AUTHOR'
  | 'WALL_NOT_OWNER'
  | 'WALL_TARGET_NOT_FOUND'
  | 'WALL_TARGET_IS_SELF'
  | 'WALL_TARGET_DISABLED_INCOMING_NOTES'
  | 'WALL_BLOCK_RELATIONSHIP'
  | 'WALL_CONTENT_REQUIRED'
  | 'WALL_CONTENT_TOO_LONG'
  | 'WALL_EXTERNAL_LINKS_NOT_ALLOWED'
  | 'WALL_INVALID_TYPE'
  | 'WALL_INVALID_FLAIR'
  | 'WALL_INVALID_TAB'
  | 'WALL_INVALID_REACTION'
  | 'WALL_INVALID_ATTACHMENT'
  | 'WALL_INVALID_CURSOR'
  | 'WALL_INVALID_SINCE'
  | 'WALL_BOOK_NOT_PUBLIC'
  | 'WALL_ENDING_NOT_COMPLETED'
  | 'WALL_ACHIEVEMENT_NOT_UNLOCKED'
  | 'WALL_CHANNELS_NOT_SUPPORTED'
  | 'WALL_RATE_LIMITED';

/** Denormalized reaction buckets kept on each post for O(1) rendering. */
export interface WallReactionCounts {
  heart: number;
  candle: number;
  mind: number;
  magnifier: number;
  broken_heart: number;
}

/** Public immutable book presentation captured when a book Note is created. */
export interface WallBookAttachmentSnapshot {
  type: 'book_share';
  bookId: string;
  slug: string;
  title: string;
  hook: string | null;
  coverImageUrl: string | null;
  mode: BookMode;
}

/** Public immutable ending presentation captured after completion is verified. */
export interface WallEndingAttachmentSnapshot {
  type: 'ending_share';
  bookId: string;
  bookSlug: string;
  bookTitle: string;
  coverImageUrl: string | null;
  pageId: string;
  pageNumber: number;
  endingTitle: string | null;
  archetype: Archetype | null;
  stability: StabilityTier | null;
  rarityPercent: number;
}

/** Public immutable achievement presentation captured after ownership is verified. */
export interface WallAchievementAttachmentSnapshot {
  type: 'achievement_share';
  achievementId: string;
  title: string;
  description: string;
  badgeImageUrl: string;
  tier: AchievementTier;
}

/** Trusted attachment snapshot union. Only the server may construct this payload. */
export type WallAttachmentSnapshot =
  | WallBookAttachmentSnapshot
  | WallEndingAttachmentSnapshot
  | WallAchievementAttachmentSnapshot;

/** Minimal public author projection embedded in Wall responses. */
export interface WallPostAuthor {
  id: string;
  username: string;
  name: string;
  imageUrl: string | null;
  avatarFrame: AvatarFrame | null;
  tier: UserTier | null;
}

/** Minimal public account projection used by composer mention suggestions. */
export interface WallMentionSuggestion {
  id: string;
  username: string;
  name: string;
  imageUrl: string | null;
  avatarFrame: AvatarFrame | null;
}

/** Server-authorized actions for the current viewer. */
export interface WallViewerActions {
  canEdit: boolean;
  canDelete: boolean;
  canPin: boolean;
  canLock: boolean;
  canHideFromWall: boolean;
  canReport: boolean;
  canReply: boolean;
}

/** Stable public Wall Note DTO returned by feed and detail endpoints. */
export interface WallPostDto {
  id: string;
  userId: string;
  wallUserId: string | null;
  type: WallPostType;
  content: string;
  flair: WallPostFlair | null;
  attachment: WallAttachmentSnapshot | null;
  isSpoiler: boolean;
  isLocked: boolean;
  isPinned: boolean;
  isHiddenFromWall: boolean;
  pinnedAt: string | null;
  likesCount: number;
  commentsCount: number;
  savesCount: number;
  reactionCounts: WallReactionCounts;
  author: WallPostAuthor;
  viewerReaction: WallReactionType | null;
  viewerHasSaved: boolean;
  viewerActions: WallViewerActions;
  createdAt: string;
  updatedAt: string;
}

/** Stable flat reply DTO returned by Wall comment endpoints. */
export interface WallPostCommentDto {
  id: string;
  postId: string;
  userId: string;
  parentId: null;
  content: string;
  author: WallPostAuthor;
  canDelete: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Cursor-paginated response used by all Wall list endpoints. */
export interface WallPageDto<TItem> {
  items: TItem[];
  nextCursor: string | null;
}

/** Creation payload accepted by POST /api/wall/posts. */
export interface CreateWallPostInput {
  clientRequestId?: string;
  type: WallPostType;
  content: string;
  flair?: WallPostFlair | null;
  wallUserId?: string | null;
  bookId?: string;
  pageId?: string;
  achievementId?: string;
  isSpoiler?: boolean;
}

/** Mutable post fields accepted by PATCH /api/wall/posts/:id. */
export interface UpdateWallPostInput {
  content?: string;
  flair?: WallPostFlair | null;
  isSpoiler?: boolean;
}

/** Reaction mutation payload. */
export interface SetWallReactionInput {
  reaction: WallReactionType;
}

/** Flat reply creation payload. V1 intentionally exposes no parent ID. */
export interface CreateWallCommentInput {
  content: string;
}

/** Chronological cursor for Following, profile, comments, and Saved reads. */
export interface WallChronologicalCursor {
  version: 1;
  kind: 'chronological';
  createdAt: string;
  id: string;
}

/** Engagement cursor for the mutable Discover ordering. */
export interface WallDiscoverCursor {
  version: 1;
  kind: 'discover';
  score: number;
  createdAt: string;
  id: string;
}

/** Profile cursor includes pin rank so the pinned-first row is never repeated. */
export interface WallProfileCursor {
  version: 1;
  kind: 'profile';
  pinnedRank: 0 | 1;
  createdAt: string;
  id: string;
}

/** Internal cursor union parsed by the Wall service. */
export type WallCursor = WallChronologicalCursor | WallDiscoverCursor | WallProfileCursor;

/** Creates the canonical zero-valued reaction dictionary. */
export function createEmptyWallReactionCounts(): WallReactionCounts {
  return {
    heart: 0,
    candle: 0,
    mind: 0,
    magnifier: 0,
    broken_heart: 0,
  };
}

/** Narrows an unknown value to a supported Wall post type. */
export function isWallPostType(value: unknown): value is WallPostType {
  return value === 'text'
    || value === 'book_share'
    || value === 'ending_share'
    || value === 'achievement_share';
}

/** Narrows an unknown value to a supported Wall flair. */
export function isWallPostFlair(value: unknown): value is WallPostFlair {
  return value === 'general'
    || value === 'clue'
    || value === 'theory'
    || value === 'review'
    || value === 'recommendation'
    || value === 'celebration';
}

/** Narrows an unknown value to a supported lore reaction. */
export function isWallReactionType(value: unknown): value is WallReactionType {
  return value === 'heart'
    || value === 'candle'
    || value === 'mind'
    || value === 'magnifier'
    || value === 'broken_heart';
}
