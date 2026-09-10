import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { dbRead, dbWrite } from '../db/client.js';
import {
  postComments,
  posts,
  userBlocks,
  userFollows,
  userLikes,
  userSavedPosts,
  users,
} from '../db/schema.js';
import { normalizePrivacyPreferences } from './privacy-preferences.js';
import type { AvatarFrame, UserTier } from '../types/user.js';
import type {
  WallAttachmentSnapshot,
  WallCursor,
  WallErrorCode,
  WallFeedTab,
  WallPageDto,
  WallPostCommentDto,
  WallPostDto,
  WallPostFlair,
  WallReactionCounts,
  WallReactionType,
} from '../types/wall.js';
import { WALL_LIMITS } from '../types/wall.js';
import {
  createWallChronologicalCursor,
  createWallDiscoverCursor,
  createWallProfileCursor,
  decodeWallCursor,
} from '../utils/wall.js';
import { isValidUuid } from '../utils/uuid.js';

const MAX_COUNT_SINCE_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const COUNT_DISPLAY_CAP = 100;

const discoverScore = sql<number>`(
  EXTRACT(EPOCH FROM ${posts.createdAt})::bigint
  + (${posts.likesCount}::bigint * 3600)
  + (${posts.commentsCount}::bigint * 7200)
)`;

const pinnedRank = sql<number>`CASE WHEN ${posts.pinnedAt} IS NULL THEN 0 ELSE 1 END`;

/** A stable Wall-domain failure that routes can serialize without text matching. */
export class WallServiceError extends Error {
  constructor(
    readonly code: WallErrorCode,
    readonly status: 400 | 401 | 403 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
    this.name = 'WallServiceError';
  }
}

export interface WallFeedParams {
  tab: WallFeedTab;
  cursor?: string;
  limit?: number;
  flair?: WallPostFlair;
}

export interface WallListParams {
  cursor?: string;
  limit?: number;
}

export interface WallCountSinceParams {
  tab: WallFeedTab;
  since: string;
  flair?: WallPostFlair;
}

interface WallPostRow {
  id: string;
  userId: string;
  wallUserId: string | null;
  type: WallPostDto['type'];
  content: string;
  flair: WallPostFlair | null;
  attachment: WallAttachmentSnapshot | null;
  isSpoiler: boolean;
  isLocked: boolean;
  pinnedAt: Date | null;
  hiddenByWallOwnerAt: Date | null;
  likesCount: number;
  commentsCount: number;
  savesCount: number;
  reactionCounts: WallReactionCounts;
  createdAt: Date;
  updatedAt: Date;
  authorId: string;
  authorUsername: string;
  authorName: string;
  authorImageUrl: string | null;
  authorAvatarFrame: AvatarFrame | null;
  authorTier: UserTier | null;
  viewerReaction: WallReactionType | null;
  viewerHasSaved: boolean;
  discoverScore: number;
  pinnedRank: number;
}

interface WallCommentRow {
  id: string;
  postId: string;
  userId: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  authorId: string;
  authorUsername: string;
  authorName: string;
  authorImageUrl: string | null;
  authorAvatarFrame: AvatarFrame | null;
  authorTier: UserTier | null;
}

/** Returns one visible Note, including viewer-specific reaction and save state. */
export async function getWallPost(
  postId: string,
  viewerId: string | null,
): Promise<WallPostDto | null> {
  return getWallPostWithClient(postId, viewerId, dbRead);
}

/** Reads a just-mutated Note from the primary to avoid replica-lag responses. */
export async function getWallPostAfterMutation(
  postId: string,
  viewerId: string,
): Promise<WallPostDto | null> {
  return getWallPostWithClient(postId, viewerId, dbWrite);
}

async function getWallPostWithClient(
  postId: string,
  viewerId: string | null,
  client: typeof dbRead,
): Promise<WallPostDto | null> {
  if (!isValidUuid(postId)) return null;

  const rows = await wallPostSelect(viewerId, client)
    .where(and(
      eq(posts.id, postId),
      ...buildVisibilityConditions(viewerId, { includeIncomingPrivacy: true }),
    ))
    .limit(1);

  const row = rows[0];
  return row ? mapWallPostRow(row, viewerId) : null;
}

/** Reads Following or Discover with their exact ordering and cursor contract. */
export async function getWallFeed(
  viewerId: string | null,
  params: WallFeedParams,
): Promise<WallPageDto<WallPostDto>> {
  const limit = normalizeLimit(params.limit);
  const cursor = parseCursor(params.cursor);

  if (params.tab === 'following' && !viewerId) {
    throw new WallServiceError('WALL_POST_UNAVAILABLE', 401, 'Authentication is required for Following');
  }

  const conditions = [
    ...buildVisibilityConditions(viewerId),
    isNull(posts.wallUserId),
  ];

  if (params.flair) conditions.push(eq(posts.flair, params.flair));

  if (params.tab === 'following') {
    const authenticatedViewerId = viewerId;
    if (!authenticatedViewerId) {
      throw new WallServiceError('WALL_POST_UNAVAILABLE', 401, 'Authentication is required for Following');
    }

    conditions.push(combineOr(
      eq(posts.userId, authenticatedViewerId),
      sql`EXISTS (
        SELECT 1 FROM ${userFollows}
        WHERE ${userFollows.followerId} = ${authenticatedViewerId}
          AND ${userFollows.followingId} = ${posts.userId}
      )`,
    ));

    if (cursor) {
      requireCursorKind(cursor, 'chronological');
      conditions.push(chronologicalAfter(cursor.createdAt, cursor.id));
    }

    const rows = await wallPostSelect(viewerId)
      .where(and(...conditions))
      .orderBy(desc(posts.createdAt), desc(posts.id))
      .limit(limit + 1);

    return createPostPage(rows, limit, viewerId, (row) => (
      createWallChronologicalCursor(row.createdAt, row.id)
    ));
  }

  if (cursor) {
    requireCursorKind(cursor, 'discover');
    conditions.push(sql`(
      ${discoverScore}, ${posts.createdAt}, ${posts.id}
    ) < (
      ${cursor.score}, ${new Date(cursor.createdAt)}, ${cursor.id}::uuid
    )`);
  }

  const rows = await wallPostSelect(viewerId)
    .where(and(...conditions))
    .orderBy(desc(discoverScore), desc(posts.createdAt), desc(posts.id))
    .limit(limit + 1);

  return createPostPage(rows, limit, viewerId, (row) => (
    createWallDiscoverCursor(row.discoverScore, row.createdAt, row.id)
  ));
}

/** Reads the exact personal-plus-incoming profile Wall predicate. */
export async function getWallUserPosts(
  identifier: string,
  viewerId: string | null,
  params: WallListParams,
): Promise<WallPageDto<WallPostDto> | null> {
  const ownerRows = await dbRead
    .select({
      userId: users.userId,
      privacyPreferences: users.privacyPreferences,
    })
    .from(users)
    .where(isValidUuid(identifier)
      ? eq(users.userId, identifier)
      : eq(users.username, identifier))
    .limit(1);

  const owner = ownerRows[0];
  if (!owner) return null;

  const isOwner = viewerId === owner.userId;
  const privacy = normalizePrivacyPreferences(owner.privacyPreferences);
  if (!isOwner && !privacy.showWallOnProfile) {
    return { items: [], nextCursor: null };
  }

  const limit = normalizeLimit(params.limit);
  const cursor = parseCursor(params.cursor);
  const conditions = [
    ...buildVisibilityConditions(viewerId, { allowOwnerHiddenFor: owner.userId }),
    combineOr(
      combineAnd(eq(posts.userId, owner.userId), isNull(posts.wallUserId)),
      eq(posts.wallUserId, owner.userId),
    ),
  ];

  if (cursor) {
    requireCursorKind(cursor, 'profile');
    conditions.push(sql`(
      ${pinnedRank}, ${posts.createdAt}, ${posts.id}
    ) < (
      ${cursor.pinnedRank}, ${new Date(cursor.createdAt)}, ${cursor.id}::uuid
    )`);
  }

  const rows = await wallPostSelect(viewerId)
    .where(and(...conditions))
    .orderBy(desc(pinnedRank), desc(posts.createdAt), desc(posts.id))
    .limit(limit + 1);

  return createPostPage(rows, limit, viewerId, (row) => (
    createWallProfileCursor(row.pinnedRank === 1 ? 1 : 0, row.createdAt, row.id)
  ));
}

/** Reads the authenticated viewer's private flat Reading Vault. */
export async function getSavedWallPosts(
  viewerId: string,
  params: WallListParams,
): Promise<WallPageDto<WallPostDto>> {
  const limit = normalizeLimit(params.limit);
  const cursor = parseCursor(params.cursor);
  const conditions = [
    eq(userSavedPosts.userId, viewerId),
    ...buildVisibilityConditions(viewerId, { includeIncomingPrivacy: true }),
  ];

  if (cursor) {
    requireCursorKind(cursor, 'chronological');
    conditions.push(sql`(
      ${userSavedPosts.createdAt}, ${userSavedPosts.postId}
    ) < (
      ${new Date(cursor.createdAt)}, ${cursor.id}::uuid
    )`);
  }

  const rows = await dbRead
    .select({
      ...wallPostFields(viewerId),
      savedAt: userSavedPosts.createdAt,
    })
    .from(userSavedPosts)
    .innerJoin(posts, eq(posts.id, userSavedPosts.postId))
    .innerJoin(users, eq(users.userId, posts.userId))
    .where(and(...conditions))
    .orderBy(desc(userSavedPosts.createdAt), desc(userSavedPosts.postId))
    .limit(limit + 1);

  return createPostPage(rows, limit, viewerId, (row) => (
    createWallChronologicalCursor(row.savedAt, row.id)
  ));
}

/** Reads flat replies only after the parent Note passes the same visibility gate. */
export async function getWallPostComments(
  postId: string,
  viewerId: string | null,
  params: WallListParams,
): Promise<WallPageDto<WallPostCommentDto> | null> {
  const visiblePost = await getWallPost(postId, viewerId);
  if (!visiblePost) return null;

  const limit = normalizeLimit(params.limit);
  const cursor = parseCursor(params.cursor);
  const conditions = [
    eq(postComments.postId, postId),
    isNull(postComments.deletedAt),
    isNull(postComments.parentId),
  ];

  if (viewerId) {
    conditions.push(sql`NOT EXISTS (
      SELECT 1 FROM ${userBlocks}
      WHERE (
        ${userBlocks.userId} = ${viewerId}
        AND ${userBlocks.blockedUserId} = ${postComments.userId}
      ) OR (
        ${userBlocks.userId} = ${postComments.userId}
        AND ${userBlocks.blockedUserId} = ${viewerId}
      )
    )`);
  }

  if (cursor) {
    requireCursorKind(cursor, 'chronological');
    conditions.push(sql`(
      ${postComments.createdAt}, ${postComments.id}
    ) > (
      ${new Date(cursor.createdAt)}, ${cursor.id}::uuid
    )`);
  }

  const rows = await dbRead
    .select({
      id: postComments.id,
      postId: postComments.postId,
      userId: postComments.userId,
      content: postComments.content,
      createdAt: postComments.createdAt,
      updatedAt: postComments.updatedAt,
      authorId: users.userId,
      authorUsername: users.username,
      authorName: users.name,
      authorImageUrl: users.imageUrl,
      authorAvatarFrame: users.avatarFrame,
      authorTier: users.tier,
    })
    .from(postComments)
    .innerJoin(users, eq(users.userId, postComments.userId))
    .where(and(...conditions))
    .orderBy(asc(postComments.createdAt), asc(postComments.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);

  return {
    items: pageRows.map((row) => mapWallCommentRow(row, viewerId)),
    nextCursor: hasMore && last
      ? createWallChronologicalCursor(last.createdAt, last.id)
      : null,
  };
}

/** Counts at most 100 new feed rows using the feed's exact visibility predicate. */
export async function countWallPostsSince(
  viewerId: string | null,
  params: WallCountSinceParams,
): Promise<number> {
  const since = parseSince(params.since);
  if (params.tab === 'following' && !viewerId) {
    throw new WallServiceError('WALL_POST_UNAVAILABLE', 401, 'Authentication is required for Following');
  }

  const conditions = [
    ...buildVisibilityConditions(viewerId),
    isNull(posts.wallUserId),
    gt(posts.createdAt, since),
  ];

  if (params.flair) conditions.push(eq(posts.flair, params.flair));

  if (params.tab === 'following') {
    const authenticatedViewerId = viewerId;
    if (!authenticatedViewerId) {
      throw new WallServiceError('WALL_POST_UNAVAILABLE', 401, 'Authentication is required for Following');
    }
    conditions.push(combineOr(
      eq(posts.userId, authenticatedViewerId),
      sql`EXISTS (
        SELECT 1 FROM ${userFollows}
        WHERE ${userFollows.followerId} = ${authenticatedViewerId}
          AND ${userFollows.followingId} = ${posts.userId}
      )`,
    ));
  }

  const rows = await dbRead
    .select({ id: posts.id })
    .from(posts)
    .where(and(...conditions))
    .limit(COUNT_DISPLAY_CAP);

  return rows.length;
}

function wallPostSelect(viewerId: string | null, client: typeof dbRead = dbRead) {
  return client
    .select(wallPostFields(viewerId))
    .from(posts)
    .innerJoin(users, eq(users.userId, posts.userId));
}

function wallPostFields(viewerId: string | null) {
  return {
      id: posts.id,
      userId: posts.userId,
      wallUserId: posts.wallUserId,
      type: posts.type,
      content: posts.content,
      flair: posts.flair,
      attachment: posts.attachmentSnapshot,
      isSpoiler: posts.isSpoiler,
      isLocked: posts.isLocked,
      pinnedAt: posts.pinnedAt,
      hiddenByWallOwnerAt: posts.hiddenByWallOwnerAt,
      likesCount: posts.likesCount,
      commentsCount: posts.commentsCount,
      savesCount: posts.savesCount,
      reactionCounts: posts.reactionCounts,
      createdAt: posts.createdAt,
      updatedAt: posts.updatedAt,
      authorId: users.userId,
      authorUsername: users.username,
      authorName: users.name,
      authorImageUrl: users.imageUrl,
      authorAvatarFrame: users.avatarFrame,
      authorTier: users.tier,
      viewerReaction: viewerId
        ? sql<WallReactionType | null>`(
          SELECT ${userLikes.reaction}
          FROM ${userLikes}
          WHERE ${userLikes.userId} = ${viewerId}
            AND ${userLikes.targetType} = 'post'
            AND ${userLikes.targetId} = ${posts.id}
          LIMIT 1
        )`
        : sql<WallReactionType | null>`NULL`,
      viewerHasSaved: viewerId
        ? sql<boolean>`EXISTS (
          SELECT 1 FROM ${userSavedPosts}
          WHERE ${userSavedPosts.userId} = ${viewerId}
            AND ${userSavedPosts.postId} = ${posts.id}
        )`
        : sql<boolean>`false`,
      discoverScore,
      pinnedRank,
    };
}

function buildVisibilityConditions(
  viewerId: string | null,
  options: {
    allowOwnerHiddenFor?: string;
    includeIncomingPrivacy?: boolean;
  } = {},
): SQL[] {
  const conditions: SQL[] = [
    isNull(posts.deletedAt),
    isNull(posts.channelId),
    sql`NOT (
      ${posts.wallUserId} IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM ${userBlocks}
        WHERE ${userBlocks.userId} = ${posts.wallUserId}
          AND ${userBlocks.blockedUserId} = ${posts.userId}
      )
    )`,
  ];

  if (options.allowOwnerHiddenFor && viewerId === options.allowOwnerHiddenFor) {
    conditions.push(combineOr(
      isNull(posts.hiddenByWallOwnerAt),
      eq(posts.wallUserId, options.allowOwnerHiddenFor),
    ));
  } else {
    conditions.push(isNull(posts.hiddenByWallOwnerAt));
  }

  if (viewerId) {
    conditions.push(sql`NOT EXISTS (
      SELECT 1 FROM ${userBlocks}
      WHERE (
        ${userBlocks.userId} = ${viewerId}
        AND ${userBlocks.blockedUserId} = ${posts.userId}
      ) OR (
        ${userBlocks.userId} = ${posts.userId}
        AND ${userBlocks.blockedUserId} = ${viewerId}
      )
    )`);
  }

  if (options.includeIncomingPrivacy) {
    conditions.push(combineOr(
      isNull(posts.wallUserId),
      viewerId ? eq(posts.wallUserId, viewerId) : sql`false`,
      sql`EXISTS (
        SELECT 1 FROM ${users} wall_owner
        WHERE wall_owner.user_id = ${posts.wallUserId}
          AND COALESCE((wall_owner.privacy_preferences->>'showWallOnProfile')::boolean, true)
      )`,
    ));
  }

  return conditions;
}

function mapWallPostRow(row: WallPostRow, viewerId: string | null): WallPostDto {
  const isAuthor = viewerId === row.userId;
  const isWallOwner = viewerId !== null && viewerId === row.wallUserId;
  const controlsSurface = row.wallUserId === null ? isAuthor : isWallOwner;

  return {
    id: row.id,
    userId: row.userId,
    wallUserId: row.wallUserId,
    type: row.type,
    content: row.content,
    flair: row.flair,
    attachment: row.attachment,
    isSpoiler: row.isSpoiler,
    isLocked: row.isLocked,
    isPinned: row.pinnedAt !== null,
    isHiddenFromWall: row.hiddenByWallOwnerAt !== null,
    pinnedAt: row.pinnedAt?.toISOString() ?? null,
    likesCount: row.likesCount,
    commentsCount: row.commentsCount,
    savesCount: row.savesCount,
    reactionCounts: row.reactionCounts,
    author: {
      id: row.authorId,
      username: row.authorUsername,
      name: row.authorName,
      imageUrl: row.authorImageUrl,
      avatarFrame: row.authorAvatarFrame,
      tier: row.authorTier,
    },
    viewerReaction: row.viewerReaction,
    viewerHasSaved: row.viewerHasSaved,
    viewerActions: {
      canEdit: isAuthor,
      canDelete: isAuthor,
      canPin: controlsSurface && row.hiddenByWallOwnerAt === null,
      canLock: controlsSurface && row.hiddenByWallOwnerAt === null,
      canHideFromWall: isWallOwner,
      canReport: viewerId !== null && !isAuthor,
      canReply: viewerId !== null && !row.isLocked && row.hiddenByWallOwnerAt === null,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapWallCommentRow(row: WallCommentRow, viewerId: string | null): WallPostCommentDto {
  return {
    id: row.id,
    postId: row.postId,
    userId: row.userId,
    parentId: null,
    content: row.content,
    author: {
      id: row.authorId,
      username: row.authorUsername,
      name: row.authorName,
      imageUrl: row.authorImageUrl,
      avatarFrame: row.authorAvatarFrame,
      tier: row.authorTier,
    },
    canDelete: viewerId === row.userId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function createPostPage<TRow extends WallPostRow>(
  rows: TRow[],
  limit: number,
  viewerId: string | null,
  cursorFor: (row: TRow) => string,
): WallPageDto<WallPostDto> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);

  return {
    items: pageRows.map((row) => mapWallPostRow(row, viewerId)),
    nextCursor: hasMore && last ? cursorFor(last) : null,
  };
}

function parseCursor(value: string | undefined): WallCursor | null {
  if (!value) return null;
  const cursor = decodeWallCursor(value);
  if (!cursor) {
    throw new WallServiceError('WALL_INVALID_CURSOR', 400, 'The Wall cursor is invalid');
  }
  return cursor;
}

function requireCursorKind<TKind extends WallCursor['kind']>(
  cursor: WallCursor,
  kind: TKind,
): asserts cursor is Extract<WallCursor, { kind: TKind }> {
  if (cursor.kind !== kind) {
    throw new WallServiceError('WALL_INVALID_CURSOR', 400, 'The Wall cursor is for a different surface');
  }
}

function chronologicalAfter(createdAt: string, id: string): SQL {
  return sql`(
    ${posts.createdAt}, ${posts.id}
  ) < (
    ${new Date(createdAt)}, ${id}::uuid
  )`;
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isSafeInteger(limit) || !limit || limit < 1) {
    return WALL_LIMITS.defaultPageSize;
  }
  return Math.min(limit, WALL_LIMITS.maximumPageSize);
}

function parseSince(value: string): Date {
  const since = new Date(value);
  const timestamp = since.getTime();
  const now = Date.now();
  if (!Number.isFinite(timestamp)
    || timestamp < now - MAX_COUNT_SINCE_AGE_MS
    || timestamp > now + MAX_CLOCK_SKEW_MS) {
    throw new WallServiceError('WALL_INVALID_SINCE', 400, 'The Wall polling timestamp is invalid');
  }
  return since;
}

function combineOr(...conditions: SQL[]): SQL {
  return or(...conditions) ?? sql`false`;
}

function combineAnd(...conditions: SQL[]): SQL {
  return and(...conditions) ?? sql`true`;
}
