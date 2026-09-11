import { ACHIEVEMENT_REGISTRY } from '../config/achievements.js';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { dbWrite } from '../db/client.js';
import {
  books,
  pages,
  postComments,
  posts,
  uploadedImages,
  userAchievements,
  userBlocks,
  userCompletedBooks,
  userLikes,
  userNotifications,
  userSavedPosts,
  users,
} from '../db/schema.js';
import { normalizeInAppPreferences } from './in-app-preferences.js';
import { normalizePrivacyPreferences } from './privacy-preferences.js';
import { getPsychologicalProfileResult } from './psychological-profile.js';
import { computeEndingStats } from './story.js';
import { logUserActivity } from './user.js';
import {
  getWallPostAfterMutation,
  WallServiceError,
} from './wall.js';
import type {
  CreateWallPostInput,
  UpdateWallPostInput,
  WallAttachmentSnapshot,
  WallPostCommentDto,
  WallPostDto,
  WallPostFlair,
  WallPostType,
  WallReactionType,
} from '../types/wall.js';
import {
  isWallPostFlair,
  isWallPostType,
  isWallReactionType,
  WALL_LIMITS,
} from '../types/wall.js';
import {
  containsExternalWallLink,
  countWallGraphemes,
  normalizeWallContent,
} from '../utils/wall.js';
import { isValidUuid } from '../utils/uuid.js';

interface NormalizedCreateInput extends CreateWallPostInput {
  content: string;
  wallUserId: string | null;
  flair: WallPostFlair | null;
  isSpoiler: boolean;
}

interface MutablePostRow {
  id: string;
  userId: string;
  wallUserId: string | null;
  channelId: string | null;
  type: WallPostType;
  attachmentSnapshot: WallAttachmentSnapshot | null;
  hiddenByWallOwnerAt: Date | null;
  deletedAt: Date | null;
}

/** Creates one idempotent personal or incoming Wall Note. */
export async function createWallPost(
  userId: string,
  value: unknown,
): Promise<WallPostDto> {
  const input = parseCreateInput(value, userId);

  if (input.clientRequestId) {
    const existingId = await findIdempotentPost(userId, input.clientRequestId);
    if (existingId) return requirePostDto(existingId, userId);
  }

  const [author] = await dbWrite
    .select({
      tier: users.tier,
      vipExpiresAt: users.vipExpiresAt,
    })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);
  if (!author) {
    throw new WallServiceError('WALL_NOT_AUTHOR', 403, 'The Note author is unavailable');
  }

  validateContent(input.content, activePostLimit(author.tier, author.vipExpiresAt), input.type !== 'text');
  if (input.wallUserId) await validateIncomingTarget(userId, input.wallUserId);
  const attachment = await createTrustedAttachment(userId, input);
  const now = new Date();

  const insertedRows = await dbWrite
    .insert(posts)
    .values({
      userId,
      clientRequestId: input.clientRequestId,
      wallUserId: input.wallUserId,
      channelId: null,
      type: input.type,
      content: input.content,
      flair: input.flair,
      bookId: input.bookId,
      pageId: input.pageId,
      achievementId: input.achievementId,
      attachmentSnapshot: attachment,
      isSpoiler: input.type === 'ending_share' ? true : input.isSpoiler,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: posts.id });

  let postId: string | undefined = insertedRows[0]?.id;
  let created = true;
  if (!postId && input.clientRequestId) {
    postId = await findIdempotentPost(userId, input.clientRequestId) ?? undefined;
    created = false;
  }
  if (!postId) {
    throw new WallServiceError('WALL_POST_UNAVAILABLE', 409, 'The Note could not be created');
  }

  if (created) {
    void logUserActivity({
      userId,
      activityType: 'wall_post_created',
      targetType: 'post',
      targetId: postId,
      metadata: { type: input.type, wallUserId: input.wallUserId },
    }).catch((error: unknown) => console.error('[wall] activity creation failed', error));

    if (input.wallUserId) {
      void notifyIncomingWallPost(input.wallUserId, userId, postId)
        .catch((error: unknown) => console.error('[wall] incoming notification failed', error));
    }
  }

  return requirePostDto(postId, userId);
}

/** Updates only author-controlled mutable Note fields. */
export async function updateWallPost(
  userId: string,
  postId: string,
  value: unknown,
): Promise<WallPostDto> {
  const existing = await loadMutablePost(postId);
  if (!existing || existing.deletedAt || existing.channelId) {
    throw new WallServiceError('WALL_POST_NOT_FOUND', 404, 'Note not found');
  }
  if (existing.userId !== userId) {
    throw new WallServiceError('WALL_NOT_AUTHOR', 403, 'Only the author may edit this Note');
  }
  if (existing.hiddenByWallOwnerAt) {
    throw new WallServiceError('WALL_POST_UNAVAILABLE', 409, 'A hidden Note cannot be edited');
  }

  const input = parseUpdateInput(value);
  const updates: UpdateWallPostInput & { updatedAt: Date } = { updatedAt: new Date() };

  if (input.content !== undefined) {
    const [author] = await dbWrite
      .select({ tier: users.tier, vipExpiresAt: users.vipExpiresAt })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);
    const content = normalizeAndRejectLinks(input.content);
    validateContent(
      content,
      activePostLimit(author?.tier ?? null, author?.vipExpiresAt ?? null),
      existing.attachmentSnapshot !== null,
    );
    updates.content = content;
  }
  if (input.flair !== undefined) updates.flair = input.flair;
  if (input.isSpoiler !== undefined) {
    updates.isSpoiler = existing.type === 'ending_share' ? true : input.isSpoiler;
  }

  await dbWrite.update(posts).set(updates).where(eq(posts.id, postId));
  return requirePostDto(postId, userId);
}

/** Idempotently soft-deletes an author's Note. */
export async function deleteWallPost(userId: string, postId: string): Promise<void> {
  const existing = await loadMutablePost(postId);
  if (!existing || existing.channelId) {
    throw new WallServiceError('WALL_POST_NOT_FOUND', 404, 'Note not found');
  }
  if (existing.userId !== userId) {
    throw new WallServiceError('WALL_NOT_AUTHOR', 403, 'Only the author may delete this Note');
  }
  if (existing.deletedAt) return;

  await dbWrite
    .update(posts)
    .set({
      deletedAt: new Date(),
      pinnedAt: null,
      pinnedByUserId: null,
      updatedAt: new Date(),
    })
    .where(eq(posts.id, postId));
}

/** Atomically creates or swaps the viewer's lore reaction. */
export async function setWallReaction(
  userId: string,
  postId: string,
  value: unknown,
): Promise<WallPostDto> {
  const reaction = parseReaction(value);
  const visible = await requirePostDto(postId, userId);

  const [previous] = await dbWrite
    .select({ reaction: userLikes.reaction })
    .from(userLikes)
    .where(and(
      eq(userLikes.userId, userId),
      eq(userLikes.targetType, 'post'),
      eq(userLikes.targetId, postId),
    ))
    .limit(1);

  await dbWrite
    .insert(userLikes)
    .values({ userId, targetType: 'post', targetId: postId, reaction, createdAt: new Date() })
    .onConflictDoUpdate({
      target: [userLikes.userId, userLikes.targetType, userLikes.targetId],
      set: { reaction, createdAt: new Date() },
    });

  if (previous?.reaction !== reaction) {
    void logUserActivity({
      userId,
      activityType: 'wall_post_liked',
      targetType: 'post',
      targetId: postId,
      metadata: { reaction },
    }).catch((error: unknown) => console.error('[wall] reaction activity failed', error));

    if (visible.userId !== userId) {
      void notifyWallReaction(visible.userId, userId, postId, reaction)
        .catch((error: unknown) => console.error('[wall] reaction notification failed', error));
    }
  }

  return requirePostDto(postId, userId);
}

/** Idempotently removes the viewer's lore reaction. */
export async function removeWallReaction(userId: string, postId: string): Promise<WallPostDto> {
  await requirePostDto(postId, userId);
  await dbWrite
    .delete(userLikes)
    .where(and(
      eq(userLikes.userId, userId),
      eq(userLikes.targetType, 'post'),
      eq(userLikes.targetId, postId),
    ));
  return requirePostDto(postId, userId);
}

/** Idempotently saves a visible Note in the viewer's private Reading Vault. */
export async function saveWallPost(userId: string, postId: string): Promise<WallPostDto> {
  await requirePostDto(postId, userId);
  await dbWrite
    .insert(userSavedPosts)
    .values({ userId, postId, createdAt: new Date() })
    .onConflictDoNothing();
  return requirePostDto(postId, userId);
}

/** Idempotently removes a Note from the viewer's Reading Vault. */
export async function unsaveWallPost(userId: string, postId: string): Promise<WallPostDto> {
  await dbWrite
    .delete(userSavedPosts)
    .where(and(eq(userSavedPosts.userId, userId), eq(userSavedPosts.postId, postId)));
  return requirePostDto(postId, userId);
}

/** Creates one flat reply after enforcing content and lock rules. */
export async function createWallComment(
  userId: string,
  postId: string,
  value: unknown,
): Promise<WallPostCommentDto> {
  const post = await requirePostDto(postId, userId);
  if (post.isLocked) {
    throw new WallServiceError('WALL_POST_LOCKED', 409, 'This Note is locked');
  }

  const content = parseCommentContent(value);
  const now = new Date();
  const [comment] = await dbWrite
    .insert(postComments)
    .values({ postId, userId, parentId: null, content, createdAt: now, updatedAt: now })
    .returning({ id: postComments.id });
  if (!comment) {
    throw new WallServiceError('WALL_POST_UNAVAILABLE', 409, 'The reply could not be created');
  }

  const [author] = await dbWrite
    .select({
      id: users.userId,
      username: users.username,
      name: users.name,
      imageUrl: users.imageUrl,
      avatarFrame: users.avatarFrame,
      tier: users.tier,
    })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);
  if (!author) {
    throw new WallServiceError('WALL_NOT_AUTHOR', 403, 'The reply author is unavailable');
  }

  if (post.userId !== userId) {
    void notifyWallReply(post.userId, userId, postId, comment.id)
      .catch((error: unknown) => console.error('[wall] reply notification failed', error));
  }

  return {
    id: comment.id,
    postId,
    userId,
    parentId: null,
    content,
    author,
    canDelete: true,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

/** Idempotently soft-deletes the reply author's own reply. */
export async function deleteWallComment(userId: string, commentId: string): Promise<void> {
  if (!isValidUuid(commentId)) {
    throw new WallServiceError('WALL_POST_NOT_FOUND', 404, 'Reply not found');
  }
  const [comment] = await dbWrite
    .select({ userId: postComments.userId, deletedAt: postComments.deletedAt })
    .from(postComments)
    .where(eq(postComments.id, commentId))
    .limit(1);
  if (!comment) throw new WallServiceError('WALL_POST_NOT_FOUND', 404, 'Reply not found');
  if (comment.userId !== userId) {
    throw new WallServiceError('WALL_NOT_AUTHOR', 403, 'Only the reply author may delete it');
  }
  if (comment.deletedAt) return;

  await dbWrite
    .update(postComments)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(postComments.id, commentId));
}

/** Replaces the effective profile owner's one active pinned Note transactionally. */
export async function pinWallPost(userId: string, postId: string): Promise<WallPostDto> {
  const existing = await requireOwnerControlledPost(userId, postId);
  if (existing.hiddenByWallOwnerAt) {
    throw new WallServiceError('WALL_POST_UNAVAILABLE', 409, 'A hidden Note cannot be pinned');
  }
  await requirePostDto(postId, userId);
  const ownerId = existing.wallUserId ?? existing.userId;

  await dbWrite.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ownerId}, 0))`);
    await tx
      .update(posts)
      .set({ pinnedAt: null, pinnedByUserId: null, updatedAt: new Date() })
      .where(and(
        isNull(posts.deletedAt),
        isNull(posts.hiddenByWallOwnerAt),
        sql`COALESCE(${posts.wallUserId}, ${posts.userId}) = ${ownerId}`,
      ));
    await tx
      .update(posts)
      .set({ pinnedAt: new Date(), pinnedByUserId: userId, updatedAt: new Date() })
      .where(eq(posts.id, postId));
  });

  return requirePostDto(postId, userId);
}

/** Idempotently removes a pin controlled by the effective profile owner. */
export async function unpinWallPost(userId: string, postId: string): Promise<WallPostDto> {
  const existing = await requireOwnerControlledPost(userId, postId);
  if (existing.hiddenByWallOwnerAt) {
    throw new WallServiceError('WALL_POST_UNAVAILABLE', 409, 'A hidden Note has no active pin');
  }
  await requirePostDto(postId, userId);
  await dbWrite
    .update(posts)
    .set({ pinnedAt: null, pinnedByUserId: null, updatedAt: new Date() })
    .where(eq(posts.id, postId));
  return requirePostDto(postId, userId);
}

/** Locks or unlocks a Note under author/profile-owner surface control. */
export async function setWallPostLock(
  userId: string,
  postId: string,
  locked: boolean,
): Promise<WallPostDto> {
  const existing = await requireOwnerControlledPost(userId, postId);
  if (existing.hiddenByWallOwnerAt) {
    throw new WallServiceError('WALL_POST_UNAVAILABLE', 409, 'A hidden Note cannot be locked');
  }
  await requirePostDto(postId, userId);
  await dbWrite
    .update(posts)
    .set({ isLocked: locked, updatedAt: new Date() })
    .where(eq(posts.id, postId));
  return requirePostDto(postId, userId);
}

/** Hides or restores an incoming Note from the target owner's profile surface. */
export async function setWallPostHidden(
  userId: string,
  postId: string,
  hidden: boolean,
): Promise<WallPostDto | null> {
  const existing = await loadMutablePost(postId);
  if (!existing || existing.deletedAt || existing.channelId || !existing.wallUserId) {
    throw new WallServiceError('WALL_POST_NOT_FOUND', 404, 'Incoming Note not found');
  }
  if (existing.wallUserId !== userId) {
    throw new WallServiceError('WALL_NOT_OWNER', 403, 'Only the Wall owner controls this surface');
  }

  await dbWrite
    .update(posts)
    .set({
      hiddenByWallOwnerAt: hidden ? new Date() : null,
      pinnedAt: hidden ? null : undefined,
      pinnedByUserId: hidden ? null : undefined,
      updatedAt: new Date(),
    })
    .where(eq(posts.id, postId));

  if (hidden) return null;
  return requirePostDto(postId, userId);
}

async function createTrustedAttachment(
  userId: string,
  input: NormalizedCreateInput,
): Promise<WallAttachmentSnapshot | null> {
  if (input.type === 'text') return null;

  if (input.type === 'achievement_share') {
    const rule = ACHIEVEMENT_REGISTRY.find((candidate) => candidate.id === input.achievementId);
    if (!rule || !input.achievementId) {
      throw new WallServiceError('WALL_INVALID_ATTACHMENT', 400, 'A valid achievement is required');
    }
    const [owned] = await dbWrite
      .select({ id: userAchievements.id })
      .from(userAchievements)
      .where(and(
        eq(userAchievements.userId, userId),
        eq(userAchievements.achievementId, input.achievementId),
      ))
      .limit(1);
    if (!owned) {
      throw new WallServiceError('WALL_ACHIEVEMENT_NOT_UNLOCKED', 403, 'Achievement not unlocked');
    }
    return {
      type: 'achievement_share',
      achievementId: rule.id,
      title: rule.title,
      description: rule.description,
      badgeImageUrl: rule.badgeImageUrl,
      tier: rule.tier,
    };
  }

  if (!input.bookId) {
    throw new WallServiceError('WALL_INVALID_ATTACHMENT', 400, 'A book is required');
  }
  const [book] = await dbWrite
    .select({
      id: books.id,
      slug: books.slug,
      title: books.title,
      hook: books.hook,
      mode: books.mode,
      status: books.status,
      visibility: books.visibility,
      coverImageUrl: sql<string | null>`(
        SELECT ${uploadedImages.imageUrl}
        FROM ${uploadedImages}
        WHERE ${uploadedImages.imageId} = ${books.imageId}
        LIMIT 1
      )`,
    })
    .from(books)
    .where(eq(books.id, input.bookId))
    .limit(1);
  if (!book || book.status !== 'active' || book.visibility !== 'public' || !book.slug) {
    throw new WallServiceError('WALL_BOOK_NOT_PUBLIC', 403, 'Book is not publicly shareable');
  }

  if (input.type === 'book_share') {
    return {
      type: 'book_share',
      bookId: book.id,
      slug: book.slug,
      title: book.title,
      hook: book.hook,
      coverImageUrl: book.coverImageUrl,
      mode: book.mode,
    };
  }

  if (!input.pageId) {
    throw new WallServiceError('WALL_INVALID_ATTACHMENT', 400, 'An ending page is required');
  }
  const [completion] = await dbWrite
    .select({ pageNumber: pages.page })
    .from(userCompletedBooks)
    .innerJoin(pages, eq(pages.id, userCompletedBooks.pageId))
    .where(and(
      eq(userCompletedBooks.userId, userId),
      eq(userCompletedBooks.bookId, book.id),
      eq(userCompletedBooks.pageId, input.pageId),
      eq(pages.bookId, book.id),
    ))
    .limit(1);
  if (!completion) {
    throw new WallServiceError('WALL_ENDING_NOT_COMPLETED', 403, 'Ending not completed');
  }

  const [endingStats, profile] = await Promise.all([
    computeEndingStats(book.id, input.pageId, userId),
    getPsychologicalProfileResult(book.id, input.pageId),
  ]);
  return {
    type: 'ending_share',
    bookId: book.id,
    bookSlug: book.slug,
    bookTitle: book.title,
    coverImageUrl: book.coverImageUrl,
    pageId: input.pageId,
    pageNumber: completion.pageNumber,
    endingTitle: null,
    archetype: profile?.archetypeKey ?? null,
    stability: profile?.stability ?? null,
    rarityPercent: endingStats.endingPercentage,
  };
}

async function validateIncomingTarget(userId: string, targetId: string): Promise<void> {
  const [target] = await dbWrite
    .select({ privacyPreferences: users.privacyPreferences })
    .from(users)
    .where(eq(users.userId, targetId))
    .limit(1);
  if (!target) {
    throw new WallServiceError('WALL_TARGET_NOT_FOUND', 404, 'Wall owner not found');
  }
  const privacy = normalizePrivacyPreferences(target.privacyPreferences);
  if (!privacy.showWallOnProfile || !privacy.allowWallNotesFromOthers) {
    throw new WallServiceError(
      'WALL_TARGET_DISABLED_INCOMING_NOTES',
      403,
      'This profile does not accept incoming Notes',
    );
  }

  const [blocked] = await dbWrite
    .select({ userId: userBlocks.userId })
    .from(userBlocks)
    .where(or(
      and(eq(userBlocks.userId, userId), eq(userBlocks.blockedUserId, targetId)),
      and(eq(userBlocks.userId, targetId), eq(userBlocks.blockedUserId, userId)),
    ))
    .limit(1);
  if (blocked) {
    throw new WallServiceError('WALL_BLOCK_RELATIONSHIP', 403, 'A block relationship prevents this Note');
  }
}

function parseCreateInput(value: unknown, userId: string): NormalizedCreateInput {
  const record = requireRecord(value, 'WALL_INVALID_TYPE', 'A Note payload is required');
  if ('channelId' in record && record.channelId !== null && record.channelId !== undefined) {
    throw new WallServiceError('WALL_CHANNELS_NOT_SUPPORTED', 400, 'Channels are not supported in V1');
  }
  if ('attachmentSnapshot' in record) {
    throw new WallServiceError('WALL_INVALID_ATTACHMENT', 400, 'Attachment snapshots are server-created');
  }
  if (!isWallPostType(record.type)) {
    throw new WallServiceError('WALL_INVALID_TYPE', 400, 'Unsupported Note type');
  }
  if (typeof record.content !== 'string') {
    throw new WallServiceError('WALL_CONTENT_REQUIRED', 400, 'Note content must be text');
  }

  const wallUserId = optionalUuid(record.wallUserId, 'WALL_TARGET_NOT_FOUND');
  if (wallUserId === userId) {
    throw new WallServiceError('WALL_TARGET_IS_SELF', 400, 'Use a personal Note for your own Wall');
  }
  const clientRequestId = optionalUuid(record.clientRequestId, 'WALL_INVALID_ATTACHMENT') ?? undefined;
  const flair = optionalFlair(record.flair);
  const isSpoiler = optionalBoolean(record.isSpoiler, false);
  const bookId = optionalUuid(record.bookId, 'WALL_INVALID_ATTACHMENT') ?? undefined;
  const pageId = optionalUuid(record.pageId, 'WALL_INVALID_ATTACHMENT') ?? undefined;
  const achievementId = optionalNonEmptyString(record.achievementId);

  validateAttachmentIdentity(record.type, { bookId, pageId, achievementId });

  return {
    type: record.type,
    content: normalizeAndRejectLinks(record.content),
    wallUserId,
    clientRequestId,
    flair,
    isSpoiler,
    bookId,
    pageId,
    achievementId,
  };
}

function parseUpdateInput(value: unknown): UpdateWallPostInput {
  const record = requireRecord(value, 'WALL_INVALID_ATTACHMENT', 'An update payload is required');
  const allowed = new Set(['content', 'flair', 'isSpoiler']);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new WallServiceError('WALL_INVALID_ATTACHMENT', 400, 'Note identity and attachments are immutable');
  }

  const update: UpdateWallPostInput = {};
  if ('content' in record) {
    if (typeof record.content !== 'string') {
      throw new WallServiceError('WALL_CONTENT_REQUIRED', 400, 'Note content must be text');
    }
    update.content = record.content;
  }
  if ('flair' in record) update.flair = optionalFlair(record.flair);
  if ('isSpoiler' in record) {
    if (typeof record.isSpoiler !== 'boolean') {
      throw new WallServiceError('WALL_INVALID_ATTACHMENT', 400, 'Spoiler state must be boolean');
    }
    update.isSpoiler = record.isSpoiler;
  }
  if (Object.keys(update).length === 0) {
    throw new WallServiceError('WALL_INVALID_ATTACHMENT', 400, 'No mutable Note fields were provided');
  }
  return update;
}

function validateAttachmentIdentity(
  type: WallPostType,
  ids: { bookId?: string; pageId?: string; achievementId?: string },
): void {
  const hasBook = ids.bookId !== undefined;
  const hasPage = ids.pageId !== undefined;
  const hasAchievement = ids.achievementId !== undefined;
  const valid = (type === 'text' && !hasBook && !hasPage && !hasAchievement)
    || (type === 'book_share' && hasBook && !hasPage && !hasAchievement)
    || (type === 'ending_share' && hasBook && hasPage && !hasAchievement)
    || (type === 'achievement_share' && !hasBook && !hasPage && hasAchievement);
  if (!valid) {
    throw new WallServiceError('WALL_INVALID_ATTACHMENT', 400, 'Attachment identifiers do not match Note type');
  }
}

function parseReaction(value: unknown): WallReactionType {
  const record = requireRecord(value, 'WALL_INVALID_REACTION', 'A reaction payload is required');
  if (!isWallReactionType(record.reaction)) {
    throw new WallServiceError('WALL_INVALID_REACTION', 400, 'Unsupported lore reaction');
  }
  return record.reaction;
}

function parseCommentContent(value: unknown): string {
  const record = requireRecord(value, 'WALL_CONTENT_REQUIRED', 'A reply payload is required');
  if ('parentId' in record && record.parentId !== null && record.parentId !== undefined) {
    throw new WallServiceError('WALL_INVALID_ATTACHMENT', 400, 'Threaded replies are not supported in V1');
  }
  if (typeof record.content !== 'string') {
    throw new WallServiceError('WALL_CONTENT_REQUIRED', 400, 'Reply content is required');
  }
  const content = normalizeAndRejectLinks(record.content);
  validateContent(content, WALL_LIMITS.commentGraphemes, false);
  return content;
}

function normalizeAndRejectLinks(value: string): string {
  if (value.length > WALL_LIMITS.maximumRawTextCodeUnits) {
    throw new WallServiceError('WALL_CONTENT_TOO_LONG', 400, 'Note content is too large');
  }
  const content = normalizeWallContent(value);
  if (containsExternalWallLink(content)) {
    throw new WallServiceError(
      'WALL_EXTERNAL_LINKS_NOT_ALLOWED',
      400,
      'External links are not supported in Wall Notes',
    );
  }
  return content;
}

function validateContent(content: string, limit: number, attachmentAllowsEmpty: boolean): void {
  const length = countWallGraphemes(content);
  if (length === 0 && !attachmentAllowsEmpty) {
    throw new WallServiceError('WALL_CONTENT_REQUIRED', 400, 'Note content is required');
  }
  if (length > limit) {
    throw new WallServiceError('WALL_CONTENT_TOO_LONG', 400, `Note content exceeds ${limit} characters`);
  }
}

function activePostLimit(tier: string | null, vipExpiresAt: Date | null): number {
  const isVip = tier === 'vip' && (!vipExpiresAt || vipExpiresAt.getTime() > Date.now());
  return isVip ? WALL_LIMITS.vipPostGraphemes : WALL_LIMITS.freePostGraphemes;
}

async function loadMutablePost(postId: string): Promise<MutablePostRow | null> {
  if (!isValidUuid(postId)) return null;
  const rows = await dbWrite
    .select({
      id: posts.id,
      userId: posts.userId,
      wallUserId: posts.wallUserId,
      channelId: posts.channelId,
      type: posts.type,
      attachmentSnapshot: posts.attachmentSnapshot,
      hiddenByWallOwnerAt: posts.hiddenByWallOwnerAt,
      deletedAt: posts.deletedAt,
    })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);
  return rows[0] ?? null;
}

async function requireOwnerControlledPost(userId: string, postId: string): Promise<MutablePostRow> {
  const post = await loadMutablePost(postId);
  if (!post || post.deletedAt || post.channelId) {
    throw new WallServiceError('WALL_POST_NOT_FOUND', 404, 'Note not found');
  }
  const ownerId = post.wallUserId ?? post.userId;
  if (ownerId !== userId) {
    throw new WallServiceError('WALL_NOT_OWNER', 403, 'Only the effective Wall owner may do this');
  }
  return post;
}

async function requirePostDto(postId: string, viewerId: string): Promise<WallPostDto> {
  const post = await getWallPostAfterMutation(postId, viewerId);
  if (!post) throw new WallServiceError('WALL_POST_NOT_FOUND', 404, 'Note not found');
  return post;
}

async function findIdempotentPost(userId: string, requestId: string): Promise<string | null> {
  const [row] = await dbWrite
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.userId, userId), eq(posts.clientRequestId, requestId)))
    .limit(1);
  return row?.id ?? null;
}

function requireRecord(
  value: unknown,
  code: 'WALL_INVALID_TYPE' | 'WALL_INVALID_ATTACHMENT' | 'WALL_INVALID_REACTION' | 'WALL_CONTENT_REQUIRED',
  message: string,
): Record<string, unknown> {
  if (!isUnknownRecord(value)) {
    throw new WallServiceError(code, 400, message);
  }
  return value;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalUuid(
  value: unknown,
  code: 'WALL_TARGET_NOT_FOUND' | 'WALL_INVALID_ATTACHMENT',
): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (!isValidUuid(value)) throw new WallServiceError(code, 400, 'Invalid identifier');
  return value;
}

function optionalFlair(value: unknown): WallPostFlair | null {
  if (value === undefined || value === null || value === '') return null;
  if (!isWallPostFlair(value)) {
    throw new WallServiceError('WALL_INVALID_FLAIR', 400, 'Unsupported Wall flair');
  }
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new WallServiceError('WALL_INVALID_ATTACHMENT', 400, 'Expected a boolean value');
  }
  return value;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 100) {
    throw new WallServiceError('WALL_INVALID_ATTACHMENT', 400, 'Invalid attachment identifier');
  }
  return value;
}

async function notificationRecipientAllows(userId: string, category: 'comments' | 'likes'): Promise<boolean> {
  const [recipient] = await dbWrite
    .select({ inAppPreferences: users.inAppPreferences })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);
  if (!recipient) return false;
  return normalizeInAppPreferences(recipient.inAppPreferences)[category];
}

async function actorName(userId: string): Promise<string> {
  const [actor] = await dbWrite
    .select({ name: users.name })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);
  return actor?.name ?? 'A reader';
}

async function notifyWallReaction(
  recipientId: string,
  actorId: string,
  postId: string,
  reaction: WallReactionType,
): Promise<void> {
  if (!await notificationRecipientAllows(recipientId, 'likes')) return;
  const name = await actorName(actorId);
  const [existing] = await dbWrite
    .select({ id: userNotifications.id })
    .from(userNotifications)
    .where(and(
      eq(userNotifications.userId, recipientId),
      eq(userNotifications.type, 'wall_post_reaction'),
      eq(userNotifications.read, false),
      sql`${userNotifications.data}->>'postId' = ${postId}`,
    ))
    .limit(1);

  const data = { postId, actorId, actorName: name, reaction, href: `/wall?post=${postId}` };
  if (existing) {
    await dbWrite
      .update(userNotifications)
      .set({ message: `${name} reacted to your Note`, data, updatedAt: new Date() })
      .where(eq(userNotifications.id, existing.id));
    return;
  }
  await dbWrite.insert(userNotifications).values({
    userId: recipientId,
    type: 'wall_post_reaction',
    title: 'New reaction on your Note',
    message: `${name} reacted to your Note`,
    data,
    read: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function notifyWallReply(
  recipientId: string,
  actorId: string,
  postId: string,
  commentId: string,
): Promise<void> {
  if (!await notificationRecipientAllows(recipientId, 'comments')) return;
  const name = await actorName(actorId);
  await dbWrite.insert(userNotifications).values({
    userId: recipientId,
    type: 'wall_post_reply',
    title: 'New reply to your Note',
    message: `${name} replied to your Note`,
    data: { postId, commentId, actorId, actorName: name, href: `/wall?post=${postId}` },
    read: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function notifyIncomingWallPost(
  recipientId: string,
  actorId: string,
  postId: string,
): Promise<void> {
  if (!await notificationRecipientAllows(recipientId, 'comments')) return;
  const name = await actorName(actorId);
  await dbWrite.insert(userNotifications).values({
    userId: recipientId,
    type: 'wall_post_incoming',
    title: 'A new Note appeared on your Wall',
    message: `${name} left a Note on your Wall`,
    data: { postId, actorId, actorName: name, href: `/wall?post=${postId}` },
    read: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}
