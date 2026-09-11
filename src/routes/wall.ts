import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../hono/env.js';
import { optionalAuth, requireAuth, requireVerifiedEmail } from '../middleware/nextauth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { requireNotMuted, requireNotSuspended } from '../middleware/trust-safety.js';
import { wallCreateRateLimit } from '../middleware/wall-rate-limit.js';
import {
  createWallComment,
  createWallPost,
  deleteWallComment,
  deleteWallPost,
  pinWallPost,
  removeWallReaction,
  saveWallPost,
  setWallPostHidden,
  setWallPostLock,
  setWallReaction,
  unpinWallPost,
  unsaveWallPost,
  updateWallPost,
} from '../services/wall-mutations.js';
import {
  countWallPostsSince,
  getSavedWallPosts,
  getWallFeed,
  getWallPost,
  getWallPostComments,
  getWallUserPosts,
  suggestWallUsers,
  WallServiceError,
} from '../services/wall.js';
import type { WallFeedTab, WallPostFlair } from '../types/wall.js';
import { isWallPostFlair } from '../types/wall.js';
import { cApiError } from '../utils/error.js';
import { WALL_ENABLED, WALL_OBSERVABILITY_SAMPLE_RATE } from '../config/wall.js';
import { logger } from '../utils/logger.js';

const router = new Hono<AppEnv>();

router.use('*', async (c, next) => {
  if (!WALL_ENABLED) {
    return c.json({
      success: false,
      error: 'The Wall is temporarily unavailable',
      code: 'WALL_POST_UNAVAILABLE',
    }, 503);
  }

  const startedAt = Date.now();
  await next();
  const status = c.res.status;
  if (status >= 500 || Math.random() < WALL_OBSERVABILITY_SAMPLE_RATE) {
    logger[status >= 500 ? 'error' : 'info']('wall_request', {
      method: c.req.method,
      route: normalizeWallRoutePath(c.req.path),
      status,
      durationMs: Date.now() - startedAt,
      authenticated: Boolean(c.get('userId')),
    });
  }
});

const feedReadLimit = rateLimit(
  { maxRequests: 60, windowSeconds: 60, prefix: 'wall-feed' },
  { ipFallback: true },
);
const profileReadLimit = rateLimit(
  { maxRequests: 30, windowSeconds: 60, prefix: 'wall-profile' },
  { ipFallback: true },
);
const detailReadLimit = rateLimit(
  { maxRequests: 120, windowSeconds: 60, prefix: 'wall-detail' },
  { ipFallback: true },
);
const commentsReadLimit = rateLimit(
  { maxRequests: 60, windowSeconds: 60, prefix: 'wall-comments' },
  { ipFallback: true },
);
const savedReadLimit = rateLimit(
  { maxRequests: 30, windowSeconds: 60, prefix: 'wall-saved' },
);
const pollingReadLimit = rateLimit(
  { maxRequests: 20, windowSeconds: 60, prefix: 'wall-poll' },
  { ipFallback: true },
);
const reactionWriteLimit = rateLimit({
  maxRequests: 60,
  windowSeconds: 60,
  prefix: 'wall-reaction-write',
});
const saveWriteLimit = rateLimit({
  maxRequests: 60,
  windowSeconds: 60,
  prefix: 'wall-save-write',
});
const commentWriteLimit = rateLimit({
  maxRequests: 30,
  windowSeconds: 60,
  prefix: 'wall-comment-write',
});
const ownerWriteLimit = rateLimit({
  maxRequests: 30,
  windowSeconds: 60,
  prefix: 'wall-owner-write',
});

/** GET /api/wall/feed — Following or engagement-ranked Discover Notes. */
router.get('/feed', optionalAuth, feedReadLimit, async (c) => {
  try {
    const tab = parseFeedTab(c.req.query('tab'));
    const flair = parseFlair(c.req.query('flair'));
    const page = await getWallFeed(c.get('userId') ?? null, {
      tab,
      flair,
      cursor: c.req.query('cursor'),
      limit: parseLimit(c.req.query('limit')),
    });

    c.header('Vary', 'Cookie, Authorization');
    c.header('Cache-Control', tab === 'discover' && !c.get('userId')
      ? 'public, max-age=60, stale-while-revalidate=30'
      : 'private, no-store');
    return c.json(page);
  } catch (error) {
    return wallRouteError(c, error, 'Failed to retrieve Wall feed');
  }
});

/** GET /api/wall/posts/saved — private flat Reading Vault. */
router.get('/posts/saved', requireAuth, savedReadLimit, async (c) => {
  try {
    const userId = requireContextUserId(c);
    const page = await getSavedWallPosts(userId, {
      cursor: c.req.query('cursor'),
      limit: parseLimit(c.req.query('limit')),
    });
    c.header('Cache-Control', 'private, no-store');
    return c.json(page);
  } catch (error) {
    return wallRouteError(c, error, 'Failed to retrieve saved Notes');
  }
});

/** GET /api/wall/posts/count-since — bounded visible-new-item polling. */
router.get('/posts/count-since', optionalAuth, pollingReadLimit, async (c) => {
  try {
    const since = c.req.query('since');
    if (!since) {
      throw new WallServiceError('WALL_INVALID_SINCE', 400, 'A polling timestamp is required');
    }

    const count = await countWallPostsSince(c.get('userId') ?? null, {
      tab: parseFeedTab(c.req.query('tab')),
      since,
      flair: parseFlair(c.req.query('flair')),
    });
    c.header('Cache-Control', 'private, no-store');
    return c.json({ count, capped: count >= 100 });
  } catch (error) {
    return wallRouteError(c, error, 'Failed to count new Notes');
  }
});

/** GET /api/wall/posts/:id/comments — oldest-first flat replies. */
router.get('/posts/:id/comments', optionalAuth, commentsReadLimit, async (c) => {
  try {
    const page = await getWallPostComments(
      c.req.param('id'),
      c.get('userId') ?? null,
      {
        cursor: c.req.query('cursor'),
        limit: parseLimit(c.req.query('limit')),
      },
    );
    if (!page) {
      throw new WallServiceError('WALL_POST_NOT_FOUND', 404, 'Note not found');
    }
    c.header('Cache-Control', 'private, no-store');
    return c.json(page);
  } catch (error) {
    return wallRouteError(c, error, 'Failed to retrieve Note replies');
  }
});

/** GET /api/wall/posts/:id — visibility-safe Note permalink data. */
router.get('/posts/:id', optionalAuth, detailReadLimit, async (c) => {
  try {
    const post = await getWallPost(c.req.param('id'), c.get('userId') ?? null);
    if (!post) {
      throw new WallServiceError('WALL_POST_NOT_FOUND', 404, 'Note not found');
    }

    const isSharedCacheEligible = !c.get('userId') && post.wallUserId === null;
    c.header('Vary', 'Cookie, Authorization');
    c.header('Cache-Control', isSharedCacheEligible
      ? 'public, max-age=300, stale-while-revalidate=60'
      : 'private, no-store');
    return c.json({ post });
  } catch (error) {
    return wallRouteError(c, error, 'Failed to retrieve Note');
  }
});

/** GET /api/wall/users/suggest — bounded, block-aware composer mention suggestions. */
router.get('/users/suggest', optionalAuth, profileReadLimit, async (c) => {
  try {
    const items = await suggestWallUsers(c.req.query('q') ?? '', c.get('userId') ?? null);
    c.header('Cache-Control', 'private, max-age=30');
    return c.json({ items });
  } catch (error) {
    return wallRouteError(c, error, 'Failed to suggest Wall mentions');
  }
});

/** GET /api/wall/users/:identifier/posts — exact profile Wall predicate. */
router.get('/users/:identifier/posts', optionalAuth, profileReadLimit, async (c) => {
  try {
    const page = await getWallUserPosts(
      c.req.param('identifier'),
      c.get('userId') ?? null,
      {
        cursor: c.req.query('cursor'),
        limit: parseLimit(c.req.query('limit')),
      },
    );
    if (!page) {
      throw new WallServiceError('WALL_TARGET_NOT_FOUND', 404, 'Wall owner not found');
    }
    c.header('Cache-Control', 'private, no-store');
    return c.json(page);
  } catch (error) {
    return wallRouteError(c, error, 'Failed to retrieve profile Wall');
  }
});

/** POST /api/wall/posts — idempotent personal or incoming Note creation. */
router.post(
  '/posts',
  requireAuth,
  requireVerifiedEmail,
  requireNotSuspended,
  requireNotMuted,
  wallCreateRateLimit,
  async (c) => {
    try {
      const body: unknown = c.get('body');
      const post = await createWallPost(requireContextUserId(c), body);
      c.header('Cache-Control', 'private, no-store');
      return c.json({ post });
    } catch (error) {
      return wallRouteError(c, error, 'Failed to create Note');
    }
  },
);

/** PATCH /api/wall/posts/:id — author-only mutable fields. */
router.patch(
  '/posts/:id',
  requireAuth,
  requireVerifiedEmail,
  requireNotSuspended,
  requireNotMuted,
  ownerWriteLimit,
  async (c) => {
    try {
      const body: unknown = c.get('body');
      const post = await updateWallPost(requireContextUserId(c), c.req.param('id'), body);
      return c.json({ post });
    } catch (error) {
      return wallRouteError(c, error, 'Failed to update Note');
    }
  },
);

/** DELETE /api/wall/posts/:id — idempotent author soft delete. */
router.delete(
  '/posts/:id',
  requireAuth,
  requireVerifiedEmail,
  requireNotSuspended,
  requireNotMuted,
  ownerWriteLimit,
  async (c) => {
    try {
      await deleteWallPost(requireContextUserId(c), c.req.param('id'));
      return c.json({ success: true });
    } catch (error) {
      return wallRouteError(c, error, 'Failed to delete Note');
    }
  },
);

/** PUT /api/wall/posts/:id/reaction — create or swap one lore reaction. */
router.put(
  '/posts/:id/reaction',
  requireAuth,
  requireVerifiedEmail,
  requireNotSuspended,
  requireNotMuted,
  reactionWriteLimit,
  async (c) => {
    try {
      const body: unknown = c.get('body');
      const post = await setWallReaction(requireContextUserId(c), c.req.param('id'), body);
      return c.json({ post });
    } catch (error) {
      return wallRouteError(c, error, 'Failed to set Note reaction');
    }
  },
);

/** DELETE /api/wall/posts/:id/reaction — idempotent reaction removal. */
router.delete(
  '/posts/:id/reaction',
  requireAuth,
  requireVerifiedEmail,
  requireNotSuspended,
  requireNotMuted,
  reactionWriteLimit,
  async (c) => {
    try {
      const post = await removeWallReaction(requireContextUserId(c), c.req.param('id'));
      return c.json({ post });
    } catch (error) {
      return wallRouteError(c, error, 'Failed to remove Note reaction');
    }
  },
);

/** PUT /api/wall/posts/:id/save — idempotent private save. */
router.put(
  '/posts/:id/save',
  requireAuth,
  requireVerifiedEmail,
  requireNotSuspended,
  saveWriteLimit,
  async (c) => {
    try {
      const post = await saveWallPost(requireContextUserId(c), c.req.param('id'));
      return c.json({ post });
    } catch (error) {
      return wallRouteError(c, error, 'Failed to save Note');
    }
  },
);

/** DELETE /api/wall/posts/:id/save — idempotent private unsave. */
router.delete(
  '/posts/:id/save',
  requireAuth,
  requireVerifiedEmail,
  requireNotSuspended,
  saveWriteLimit,
  async (c) => {
    try {
      const post = await unsaveWallPost(requireContextUserId(c), c.req.param('id'));
      return c.json({ post });
    } catch (error) {
      return wallRouteError(c, error, 'Failed to unsave Note');
    }
  },
);

/** POST /api/wall/posts/:id/comments — create a flat reply. */
router.post(
  '/posts/:id/comments',
  requireAuth,
  requireVerifiedEmail,
  requireNotSuspended,
  requireNotMuted,
  commentWriteLimit,
  async (c) => {
    try {
      const body: unknown = c.get('body');
      const comment = await createWallComment(requireContextUserId(c), c.req.param('id'), body);
      return c.json({ comment });
    } catch (error) {
      return wallRouteError(c, error, 'Failed to reply to Note');
    }
  },
);

/** DELETE /api/wall/comments/:id — author-only reply soft delete. */
router.delete(
  '/comments/:id',
  requireAuth,
  requireVerifiedEmail,
  requireNotSuspended,
  requireNotMuted,
  commentWriteLimit,
  async (c) => {
    try {
      await deleteWallComment(requireContextUserId(c), c.req.param('id'));
      return c.json({ success: true });
    } catch (error) {
      return wallRouteError(c, error, 'Failed to delete Note reply');
    }
  },
);

router.put('/posts/:id/pin', requireAuth, requireVerifiedEmail, requireNotSuspended, requireNotMuted, ownerWriteLimit, async (c) => {
  try {
    const post = await pinWallPost(requireContextUserId(c), c.req.param('id'));
    return c.json({ post });
  } catch (error) {
    return wallRouteError(c, error, 'Failed to pin Note');
  }
});

router.delete('/posts/:id/pin', requireAuth, requireVerifiedEmail, requireNotSuspended, requireNotMuted, ownerWriteLimit, async (c) => {
  try {
    const post = await unpinWallPost(requireContextUserId(c), c.req.param('id'));
    return c.json({ post });
  } catch (error) {
    return wallRouteError(c, error, 'Failed to unpin Note');
  }
});

router.put('/posts/:id/lock', requireAuth, requireVerifiedEmail, requireNotSuspended, requireNotMuted, ownerWriteLimit, async (c) => {
  try {
    const post = await setWallPostLock(requireContextUserId(c), c.req.param('id'), true);
    return c.json({ post });
  } catch (error) {
    return wallRouteError(c, error, 'Failed to lock Note');
  }
});

router.delete('/posts/:id/lock', requireAuth, requireVerifiedEmail, requireNotSuspended, requireNotMuted, ownerWriteLimit, async (c) => {
  try {
    const post = await setWallPostLock(requireContextUserId(c), c.req.param('id'), false);
    return c.json({ post });
  } catch (error) {
    return wallRouteError(c, error, 'Failed to unlock Note');
  }
});

router.put('/posts/:id/hide-from-wall', requireAuth, requireVerifiedEmail, requireNotSuspended, requireNotMuted, ownerWriteLimit, async (c) => {
  try {
    await setWallPostHidden(requireContextUserId(c), c.req.param('id'), true);
    return c.json({ success: true, hidden: true });
  } catch (error) {
    return wallRouteError(c, error, 'Failed to hide incoming Note');
  }
});

router.delete('/posts/:id/hide-from-wall', requireAuth, requireVerifiedEmail, requireNotSuspended, requireNotMuted, ownerWriteLimit, async (c) => {
  try {
    const post = await setWallPostHidden(requireContextUserId(c), c.req.param('id'), false);
    return c.json({ post, hidden: false });
  } catch (error) {
    return wallRouteError(c, error, 'Failed to restore incoming Note');
  }
});

function parseFeedTab(value: string | undefined): WallFeedTab {
  const tab = value ?? 'discover';
  if (tab === 'following' || tab === 'discover') return tab;
  throw new WallServiceError('WALL_INVALID_TAB', 400, 'Unsupported Wall feed tab');
}

function normalizeWallRoutePath(path: string): string {
  return path
    .replace(/\/users\/[^/]+\/posts$/u, '/users/:identifier/posts')
    .replace(/\/posts\/[^/]+/u, '/posts/:id')
    .replace(/\/comments\/[^/]+$/u, '/comments/:id');
}

function parseFlair(value: string | undefined): WallPostFlair | undefined {
  if (!value) return undefined;
  if (isWallPostFlair(value)) return value;
  throw new WallServiceError('WALL_INVALID_FLAIR', 400, 'Unsupported Wall flair');
}

function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const limit = Number(value);
  return Number.isSafeInteger(limit) ? limit : undefined;
}

function requireContextUserId(c: Context<AppEnv>): string {
  const userId = c.get('userId');
  if (!userId) {
    throw new WallServiceError('WALL_POST_UNAVAILABLE', 401, 'Authentication is required');
  }
  return userId;
}

function wallRouteError(c: Context<AppEnv>, error: unknown, fallback: string) {
  if (error instanceof WallServiceError) {
    return c.json({
      success: false,
      error: error.message,
      code: error.code,
    }, error.status);
  }

  console.error(`[wall] ${fallback}`, error);
  return cApiError(c, fallback, error);
}

export default router;
