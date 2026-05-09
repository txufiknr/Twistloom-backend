import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, real, jsonb, uuid, index, primaryKey, integer, unique, type UpdateDeleteAction, boolean } from "drizzle-orm/pg-core";
import type { Gender } from "../types/user.js";
import type { LikeTargetType } from "../types/user.js";
import type { StoryMC } from "../types/character.js";
import type { BookStatus } from "../types/book.js";
import type { SessionStatus } from "../types/session.js";
import type { AIChatProvider } from "../types/ai-chat.js";
import type { PsychologicalProfile, PsychologicalFlags, HiddenState, MemoryIntegrity, Difficulty, Action, StateDelta, Ending, ActionHistory, PlotFlag } from "../types/story.js";
import type { CharacterMemory, Injury } from "../types/character.js";
import type { PlaceMemory } from "../types/places.js";
import { generateId } from "../utils/uuid.js";
import { BOOK_AVERAGE_PAGES } from "../config/story.js";
import type { StoryThread } from "../types/thread.js";
import type { TransactionType } from "../types/credits.js";

/** Pre-defined columns */
const id = () => uuid("id").primaryKey().$defaultFn(generateId);
const userId = () => uuid("user_id").notNull();
const bookId = (onDelete: UpdateDeleteAction = "cascade") => uuid("book_id").notNull().references(() => books.id, { onDelete });
const pageId = (onDelete: UpdateDeleteAction = "cascade") => uuid("page_id").notNull().references(() => pages.id, { onDelete });
const gender = text("gender").$type<Gender | null>();
const date = text("date").notNull(); // YYYY-MM-DD format
const createdAt = timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date());
const lastActive = timestamp("last_active", { withTimezone: true }).defaultNow().notNull();
const branchId = text("branch_id").notNull().default("main"); // Which reality you're in
const image = text("image"); // ImageKit URL
const imageId = text("image_id"); // ImageKit file ID for deletion

/**
 * Create story pages table
 * @summary Store individual story pages with metadata and updates
 * @example
 * {
 *   "id": "page123",
 *   "book_id": "book456",
 *   "page_number": 1,
 *   "page": "The hallway stretched endlessly before me...",
 *   "mood": "eerie",
 *   "actions": ["investigate noise", "run away", "call for help"],
 *   "action_types": ["explore", "escape", "social"],
 *   "add_trauma_tag": "heard a voice",
 *   "character_updates": {...},
 *   "place_updates": {...},
 *   "created_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const pages = pgTable(
  "pages",
  {
    id: id(),
    userId: userId(), // Initiator
    parentId: uuid("parent_id"),
    branchId, // Which reality you're in
    bookId: bookId("cascade"), // Delete if book is deleted
    page: integer("page").notNull(), // Page number
    text: text("text").notNull(), // 60 words max, first-person POV
    mood: text("mood"), // Current emotional atmosphere
    place: text("place"), // Current place where the story is taking place
    timeOfDay: text("time_of_day"),
    charactersPresent: jsonb("characters").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // Characters present in the page
    keyEvents: jsonb("key_events").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // Key events that occurred in the page
    importantObjects: jsonb("important_objects").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // Important objects mentioned in the page
    actions: jsonb("actions").$type<Action[]>().notNull().default(sql`'[]'::jsonb`), // 2-3 branching actions
    stateDelta: jsonb("delta").$type<StateDelta>().notNull(),
    aiProvider: text("ai_provider").$type<AIChatProvider | 'none'>(),
    aiModel: text("ai_model"),
    pendingGenerationCount: integer("pending_generation_count").notNull().default(0), // Count of actions without pre-generated destinations
    isGeneratingStartedAt: timestamp("is_generating_started_at", { withTimezone: true }), // When candidate generation started. `null` means not generating.
    visitCount: integer("visit_count").notNull().default(0), // Count of times this page has been visited (denormalized for performance)
    createdAt,
    updatedAt,
  },
  (t) => [
    // Index for book pagination
    index("pages_book_page_idx").on(t.bookId, t.page),
    // Index for book ordering
    index("pages_book_order_idx").on(t.bookId, t.page.desc()),
    // Index for creation time
    index("pages_created_at_idx").on(t.createdAt),
    // Composite index for trigger performance (branchesCount maintenance)
    index("pages_book_branch_idx").on(t.bookId, t.branchId),
    // Prevent duplicate branches for same parent page
    unique("pages_parent_branch_unique").on(t.parentId, t.branchId),
    // Index for pending generation cron job
    index("pages_pending_generation_idx").on(t.pendingGenerationCount),
    // -- 4) Optionally add an index for queries:
    // CREATE INDEX pages_is_generating_started_at_idx ON pages (is_generating_started_at);
  ]
);

/**
 * Create story state table
 * @summary Store complete story progression and psychological state
 * @example
 * {
 *   "id": "state123",
 *   "book_id": "book456",
 *   "page": 5,
 *   "max_page": 20,
 *   "flags": {...},
 *   "trauma_tags": [...],
 *   "plot_flags": [...],
 *   "inventory": [...],
 *   "psychological_profile": {...},
 *   "hidden_state": {...},
 *   "memory_integrity": "fragmented",
 *   "difficulty": "medium",
 *   "viable_ending": {...},
 *   "characters": {...},
 *   "places": {...},
 *   "actions_history": [...],
 *   "context_history": "...",
 *   "is_major_event": false,
 *   "threads": [...],
 *   "injuries": [...],
 *   "created_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const storyStates = pgTable(
  "story_states",
  {
    pageId: pageId("cascade"), // Delete if page is deleted (primary key)
    bookId: bookId("cascade"), // Delete if book is deleted
    page: integer("page").notNull(),
    maxPage: integer("max_page").notNull(),
    flags: jsonb("flags").$type<PsychologicalFlags>().notNull(), // Psychological flags structure
    traumaTags: jsonb("trauma_tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    plotFlags: jsonb("plot_flags").$type<PlotFlag[]>().notNull().default(sql`'[]'::jsonb`), // Narrative flags and hints
    inventory: jsonb("inventory").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // Items and resources
    psychologicalProfile: jsonb("psychological_profile").$type<PsychologicalProfile>().notNull(), // PsychologicalProfile structure
    hiddenState: jsonb("hidden_state").$type<HiddenState>().notNull(), // Hidden narrative state structure
    memoryIntegrity: text("memory_integrity").$type<MemoryIntegrity>().notNull().default("stable"), // "stable" | "fragmented" | "corrupted"
    difficulty: text("difficulty").$type<Difficulty>().notNull().default("low"), // "low" | "medium" | "high" | "nightmare"
    viableEnding: jsonb("viable_ending").$type<Ending>(),
    characters: jsonb("characters").$type<Record<string, CharacterMemory>>().notNull().default(sql`'{}'::jsonb`), // Character records
    places: jsonb("places").$type<Record<string, PlaceMemory>>().notNull().default(sql`'{}'::jsonb`), // Place records
    threads: jsonb("threads").$type<StoryThread[]>().notNull().default(sql`'[]'::jsonb`), // Ongoing narrative threads
    actionsHistory: jsonb("actions_history").$type<ActionHistory[]>().notNull().default(sql`'[]'::jsonb`), // History of user actions
    injuries: jsonb("injuries").$type<Injury[]>().notNull().default(sql`'[]'::jsonb`), // MC injuries
    contextHistory: text("context_history").notNull().default(""), // AI-summarized story context from page 1 to current
    isMajorEvent: boolean("is_major_event").notNull().default(false),
    createdAt,
    updatedAt,
  },
  (t) => [
    // Primary key: state is unique per page (branch-based architecture)
    primaryKey({ columns: [t.pageId] }),
    // Index for book queries
    index("story_states_book_idx").on(t.bookId),
    // Index for current page
    index("story_states_page_idx").on(t.page),
    // Index for difficulty filtering
    index("story_states_difficulty_idx").on(t.difficulty),
    // Index for progression tracking
    index("story_states_progress_idx").on(t.page.desc()),
  ]
);

/**
 * Create user table
 * @summary Store user profile information
 * @example
 * {
 *   "user_id": "user123",
 *   "name": "John Doe",
 *   "gender": "male",
 *   "bio": "I'm a writer and a reader.",
 *   "created_at": "2023-01-01T00:00:00.000Z",
 *   "updated_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const users = pgTable(
  "users",
  {
    userId: userId().primaryKey(),
    name: text("name"),
    username: text("username").unique("users_username_unique"), // Unique constraint for login
    email: text("email").unique("users_email_unique"), // Unique constraint for login
    passwordHash: text("password_hash"), // Hashed password for email/password authentication
    stripeCustomerID: text("stripe_customer_id").unique("users_stripe_customer_id_unique"),
    credits: integer("credits").notNull().default(50),
    penName: text("pen_name"),
    bio: text("bio"), // User bio/description
    gender,
    image, // Profile image ImageKit URL
    imageId, // ImageKit file ID for deletion
    lastActive,
    createdAt,
    updatedAt,
  },
  (t) => [
    // Index for gender-based analytics
    index("users_gender_idx").on(t.gender),
    // Index for user creation trends
    index("users_created_at_idx").on(t.createdAt),
  ]
);

/**
 * Create user auth table
 * @summary Stores authentication-related data separate from user profile
 * Separation of concerns for security, maintainability, and GDPR compliance
 * 
 * @example
 * {
 *   "user_id": "user123",
 *   "failed_login_attempts": 0,
 *   "lock_until": null,
 *   "password_reset_token": null,
 *   "password_reset_expires": null,
 *   "email_verified": "2023-01-01T00:00:00.000Z",
 *   "email_verification_token": null,
 *   "created_at": "2023-01-01T00:00:00.000Z",
 *   "updated_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const userAuth = pgTable(
  "user_auth",
  {
    userId: userId().primaryKey().references(() => users.userId, { onDelete: "cascade" }),
    // Account lockout fields
    failedLoginAttempts: integer("failed_login_attempts").default(0),
    lockUntil: timestamp("lock_until", { withTimezone: true }),
    // Password reset fields
    passwordResetToken: text("password_reset_token").unique("user_auth_password_reset_token_unique"),
    passwordResetExpires: timestamp("password_reset_expires", { withTimezone: true }),
    // Email verification fields
    emailVerified: timestamp("email_verified", { withTimezone: true }),
    emailVerificationToken: text("email_verification_token").unique("user_auth_email_verification_token_unique"),
    emailVerificationExpires: timestamp("email_verification_expires", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    // Index for account lockout queries
    index("user_auth_lock_until_idx").on(t.lockUntil).where(sql`${t.lockUntil} IS NOT NULL`),
    // Index for password reset queries
    index("user_auth_password_reset_token_idx").on(t.passwordResetToken).where(sql`${t.passwordResetToken} IS NOT NULL`),
    // Index for email verification queries
    index("user_auth_email_verification_token_idx").on(t.emailVerificationToken).where(sql`${t.emailVerificationToken} IS NOT NULL`),
  ]
);

/**
 * Create books table
 * @summary Store book metadata and main character information
 * @example
 * {
 *   "id": "book123",
 *   "user_id": "user456",
 *   "display_title": "The Haunting",
 *   "hook": "A mysterious ghost haunts an old mansion...",
 *   "summary": "A psychological thriller about...",
 *   "keywords": ["ghost", "mansion", "mystery"],
 *   "status": "active",
 *   "trending_score": 0.85,
 *   "mc": {
 *     "name": "Sarah Chen",
 *     "age": 28,
 *     "gender": "female"
 *   },
 *   "created_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const books = pgTable(
  "books",
  {
    id: id(),
    userId: userId().references(() => users.userId, { onDelete: "set null" }),
    slug: text("slug").unique(), // SEO-friendly URL identifier (null if not implemented)
    title: text("title").notNull(),
    totalPages: integer("total_pages").notNull().default(BOOK_AVERAGE_PAGES),
    language: text("language"),
    hook: text("hook"),
    summary: text("summary"),
    image, // Cover image ImageKit URL
    imageId, // ImageKit file ID for deletion
    trendingScore: real("trending_score").default(0),
    isOriginal: boolean("is_original").notNull().default(false),
    keywords: jsonb("keywords").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // e.g. ['thriller', 'action', 'crime', 'horror', 'killer', 'murder', 'mystery', 'suspense']
    status: text("status").$type<BookStatus | null>().default('active'),
    mc: jsonb("mc").$type<StoryMC>().notNull(), // Main character profile with name, age, gender
    likesCount: integer("likes_count").notNull().default(0), // Total likes for this book
    readCount: integer("read_count").notNull().default(0), // Total reads/sessions for this book
    branchesCount: integer("branches_count").notNull().default(0), // Total unique branches (maintained by trigger)
    topPick: timestamp("top_pick", { withTimezone: true }), // Editor's pick
    createdAt,
    updatedAt,
  },
  (t) => [
    // Optimize trending sorting by pre-calculated score (cron-based with time decay)
    index("books_trending_score_idx").on(t.trendingScore.desc()),
    // Optimize newest sorting by creation date
    index("books_created_at_idx").on(t.createdAt.desc()),
    // Optimize top-picks sorting
    index("books_top_pick_idx").on(t.topPick.desc()).where(sql`${t.topPick} IS NOT NULL`),
    // Optimize originals sorting (filter by isOriginal, sort by createdAt)
    index("books_is_original_idx").on(t.isOriginal, t.createdAt.desc()),
    // Optimize time-window queries
    index("books_recent_idx").on(t.updatedAt),
    // Index for user book queries
    index("books_user_idx").on(t.userId),
    // Index for status filtering
    index("books_status_idx").on(t.status),
    // Index for language filtering
    index("books_language_idx").on(t.language),
    // GIN index for keywords JSONB array (enables efficient array operations)
    index("books_keywords_gin_idx").using("gin", t.keywords),
    // GIN index for title with pg_trgm (enables efficient ILIKE search with leading wildcards)
    index("books_title_gin_idx").using("gin", sql`title gin_trgm_ops`),
    // GIN index for hook with pg_trgm (enables efficient ILIKE search with leading wildcards)
    index("books_hook_gin_idx").using("gin", sql`hook gin_trgm_ops`),
    // GIN index for summary with pg_trgm (enables efficient ILIKE search with leading wildcards)
    index("books_summary_gin_idx").using("gin", sql`summary gin_trgm_ops`),
  ]
);

/**
 * Create user page progress tracking table
 * @summary Track user's action choices per page for branch reconstruction
 */
export const userPageProgress = pgTable(
  "user_page_progress",
  {
    id: id(),
    userId: userId().references(() => users.userId, { onDelete: "set null" }),
    bookId: bookId("set null"),
    actionedPageId: uuid("actioned_page_id").notNull(), // page which action selected from
    nextPageId: uuid("next_page_id").notNull(), // action's destination page ID
    action: jsonb("action").$type<Action>().notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    // Unique constraint on (userId, bookId, pageId) to ensure unique progress per branch
    unique("user_page_progress_user_book_page_unique").on(t.userId, t.bookId, t.actionedPageId),
    // Index for user's progress in a book
    index("user_page_progress_user_book_idx").on(t.userId, t.bookId),
    // Index for finding specific page progress
    index("user_page_progress_page_idx").on(t.actionedPageId),
    // Index for action tracking
    // index("user_page_progress_action_gin_idx").using("gin", t.action),
  ]
);

/**
 * Create usage table to track daily AI requests
 * @summary Track how many AI requests were made per day by provider and context
 */
export const usage = pgTable(
  "usage",
  {
    date, // YYYY-MM-DD format
    provider: text("provider").$type<AIChatProvider>().notNull(), // github | gemini | groq | cohere | cerebras | mistral | nvidia
    requests: integer("requests"), // Number of AI requests made
    context: text("context"), // Usage context, e.g. 'story-page', etc.
  },
  (t) => [
    // Composite primary key for date + provider + context
    primaryKey({ columns: [t.date, t.provider, t.context] }),
  ]
);

/**
 * Create user likes table
 * @summary Store user likes for books, comments, and other users
 * @example
 * {
 *   "user_id": "user123",
 *   "target_type": "book",
 *   "target_id": "book456",
 *   "created_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const userLikes = pgTable(
  "user_likes",
  {
    userId: userId(),
    targetType: text("target_type").$type<LikeTargetType>().notNull(), // "book" | "comment" | "user"
    targetId: uuid("target_id").notNull(), // ID of the liked item
    createdAt,
  },
  (t) => [
    // Composite primary key: one like per user+target combination
    primaryKey({ columns: [t.userId, t.targetType, t.targetId] }),
    
    // Index for user's likes
    index("user_likes_user_idx").on(t.userId),
    
    // Index for target popularity
    index("user_likes_target_idx").on(t.targetType, t.targetId),
    
    // Index for recent likes
    index("user_likes_created_idx").on(t.createdAt.desc()),
  ]
);

/**
 * Create user favorited books table
 * @summary Store user favorites for books to read later
 * @example
 * {
 *   "user_id": "user123",
 *   "book_id": "book456",
 *   "created_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const userFavorites = pgTable(
  "user_favorites",
  {
    userId: userId(),
    bookId: bookId("cascade"), // Delete if book is deleted
    collection: text("collection"),
    createdAt,
  },
  (t) => [
    // Composite primary key: one favorite per user+book combination
    primaryKey({ columns: [t.userId, t.bookId] }),
    
    // Index for user's favorites
    index("user_favorites_user_idx").on(t.userId),
    
    // Index for book popularity
    index("user_favorites_book_idx").on(t.bookId),
    
    // Index for recent favorites
    index("user_favorites_created_idx").on(t.createdAt.desc()),
  ]
);

/**
 * Create user comments table
 * @summary Store user comments on books and comment replies
 * @example
 * {
 *   "id": "comment123",
 *   "user_id": "user123",
 *   "book_id": "book456",
 *   "parent_comment_id": "comment789",
 *   "content": "This story is amazing!",
 *   "created_at": "2023-01-01T00:00:00.000Z",
 *   "updated_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const userComments = pgTable(
  "user_comments",
  {
    id: id(),
    userId: userId(),
    bookId: bookId("cascade"), // Delete if book is deleted
    pageId: uuid("page_id").references(() => pages.id, { onDelete: "cascade" }), // Delete if page is deleted
    parentCommentId: uuid("parent_comment_id"), // For threaded comments
    content: text("content").notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    // Index for user's comments
    index("user_comments_user_idx").on(t.userId),
    
    // Index for book comments
    index("user_comments_book_idx").on(t.bookId),
    
    // Index for comment threading
    index("user_comments_parent_idx").on(t.parentCommentId),
    
    // Index for recent comments
    index("user_comments_created_idx").on(t.createdAt.desc()),
    
    // Index for book comment ordering
    index("user_comments_book_order_idx").on(t.bookId, t.createdAt.desc()),
  ]
);

/**
 * Create user follows table
 * @summary Store user follow relationships
 * @example
 * {
 *   "follower_id": "user123",
 *   "following_id": "user456",
 *   "created_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const userFollows = pgTable(
  "user_follows",
  {
    followerId: uuid("follower_id").notNull().references(() => users.userId, { onDelete: "cascade" }),
    followingId: uuid("following_id").notNull().references(() => users.userId, { onDelete: "cascade" }),
    createdAt,
  },
  (t) => [
    // Composite primary key: one follow per follower+following combination
    primaryKey({ columns: [t.followerId, t.followingId] }),
    
    // Index for user's followers
    index("user_follows_following_idx").on(t.followingId),
    
    // Index for user's following
    index("user_follows_follower_idx").on(t.followerId),
    
    // Index for recent follows
    index("user_follows_created_idx").on(t.createdAt.desc()),
  ]
);

/**
 * Create user sessions table
 * @summary Track user reading sessions for each book
 * @example
 * {
 *   "user_id": "user123",
 *   "book_id": "book456",
 *   "page_id": "page789",
 *   "status": "active",
 *   "created_at": "2023-01-01T00:00:00.000Z",
 *   "updated_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const userSessions = pgTable(
  "user_sessions",
  {
    id: id(),
    userId: userId(),
    bookId: bookId("cascade"), // Delete if book is deleted
    pageId: pageId("set null"),
    previousPageId: uuid("previous_page_id"), // For navigation history
    status: text("status").$type<SessionStatus>().notNull().default("active"),
    createdAt,
    updatedAt,
  },
  (t) => [
    // Unique constraint on (userId, bookId) to ensure one session per user+book
    unique("user_sessions_user_book_unique").on(t.userId, t.bookId),
    // Index for status filtering
    index("user_sessions_status_idx").on(t.status),
    // Index for user's active sessions
    index("user_sessions_user_active_idx").on(t.userId).where(sql`status = 'active'`),
  ]
);

/**
 * Create user activity logs table
 * @summary Track user activities for analytics and engagement monitoring
 * @example
 * {
 *   "id": "log123",
 *   "user_id": "user123",
 *   "activity_type": "book_created",
 *   "target_type": "book",
 *   "target_id": "book456",
 *   "metadata": {"title": "The Haunting"},
 *   "ip_address": "192.168.1.1",
 *   "user_agent": "Mozilla/5.0...",
 *   "platform": "android",
 *   "app_version": "1.0.0",
 *   "created_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const userActivityLogs = pgTable(
  "user_activity_logs",
  {
    id: id(),
    userId: userId().references(() => users.userId, { onDelete: "cascade" }),
    activityType: text("activity_type").notNull(), // e.g., "book_created", "liked", "commented", "followed", "favorited", "session_updated"
    targetType: text("target_type"), // e.g., "book", "comment", "user"
    targetId: uuid("target_id"), // ID of the target entity
    metadata: jsonb("metadata"), // Additional context-specific data
    ipAddress: text("ip_address"), // User's IP address for security analytics
    userAgent: text("user_agent"), // Browser/app user agent
    platform: text("platform"), // e.g., "android", "ios", "web"
    appVersion: text("app_version"), // App version for analytics
    createdAt,
  },
  (t) => [
    // Index for user's activity history
    index("user_activity_logs_user_idx").on(t.userId, t.createdAt.desc()),
    // Index for activity type filtering
    index("user_activity_logs_type_idx").on(t.activityType),
    // Index for target-based queries
    index("user_activity_logs_target_idx").on(t.targetType, t.targetId),
    // Index for cleanup (old logs)
    index("user_activity_logs_created_idx").on(t.createdAt.desc()),
  ]
);

/**
 * Server-side user cache (cheap & powerful)
 * @summary Cache user data for faster retrieval
 * 
 * Cached users (key):
 * - user:{userId} - User data
 * - user:{userId}:favorites - User favorites
 * - user:{userId}:sessions - User sessions
 */
export const userCache = pgTable(
  "user_cache",
  {
    key: text("key").primaryKey(),
    payload: jsonb("payload").notNull(),
    updatedAt,
  },
  (t) => [
    // Index for JSONB queries (future-proof)
    index("user_cache_payload_gin").using("gin", t.payload),

    // Index for TTL cleanup & freshness checks
    index("user_cache_updated_at_idx").on(t.updatedAt),
  ]
);

/**
 * Create deleted images table
 * @summary Queue ImageKit file IDs for deletion when clusters are deleted
 * 
 * This table acts as a reliable queue system:
 * 1. Database trigger inserts heroImageId when cluster is deleted
 * 2. Daily cleanup job processes queued deletions
 * 3. Rows are immediately deleted after successful ImageKit deletion
 * 
 * @example
 * {
 *   "file_id": "abc123_imagekit_file_id",
 *   "created_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const deletedImages = pgTable(
  "deleted_images",
  {
    fileId: text("file_id").notNull().primaryKey(), // ImageKit file ID to be deleted
    createdAt, // When this deletion was queued
  },
  (t) => [
    // Index for efficient cleanup queries (oldest first)
    index("deleted_images_created_idx").on(t.createdAt),
  ]
);

/**
 * Create transactions table
 * @summary Track credit purchases and usage transactions for users
 * 
 * Records all credit-related transactions including:
 * - Purchases: User buys credits (amountUsd is set)
 * - Usage: User consumes credits for AI generation (amountUsd is null)
 * 
 * @example
 * {
 *   "id": "txn123",
 *   "user_id": "user456",
 *   "type": "purchase",
 *   "credits": 100,
 *   "amount_usd": 9.99,
 *   "created_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const transactions = pgTable(
  "transactions",
  {
    id: id(),
    userId: userId().references(() => users.userId, { onDelete: "cascade" }),
    type: text("type").$type<TransactionType>().notNull(),
    credits: integer("credits").notNull(),
    amountUsd: real("amount_usd"),
    context: text("context"), // Additional context for usage transactions (e.g., "book_creation")
    metadata: jsonb("metadata"), // Additional metadata for the transaction
    paymentIntentId: text("payment_intent_id").unique(), // Stripe payment intent for idempotency
    stripeEventId: text("stripe_event_id").unique(), // Stripe event ID for webhook idempotency
    createdAt,
  },
  (t) => [
    // Index for user's transaction history
    index("transactions_user_idx").on(t.userId),
    // Index for transaction type filtering
    index("transactions_type_idx").on(t.type),
    // Index for recent transactions
    index("transactions_created_idx").on(t.createdAt.desc()),
    // Index for context filtering
    index("transactions_context_idx").on(t.context),
    // Unique index for payment intent idempotency
    unique("transactions_payment_intent_unique").on(t.paymentIntentId),
    // Unique index for Stripe event idempotency
    unique("transactions_stripe_event_unique").on(t.stripeEventId),
  ]
);

/**
 * Webhook delivery tracking table
 * @summary Tracks Stripe webhook delivery status for monitoring and debugging
 * @example
 * {
 *   "id": "webhook123",
 *   "event_id": "evt_1234567890",
 *   "event_type": "checkout.session.completed",
 *   "delivered_at": "2023-01-01T00:00:00.000Z",
 *   "processed_at": "2023-01-01T00:00:01.000Z",
 *   "status": "success",
 *   "error_message": null
 * }
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: id(),
    eventId: text("event_id").notNull(), // Stripe event ID
    eventType: text("event_type").notNull(), // Stripe event type
    deliveredAt: timestamp("delivered_at").defaultNow().notNull(), // When webhook was received
    processedAt: timestamp("processed_at"), // When webhook was processed
    status: text("status").$type<'success' | 'failed' | 'retrying'>().notNull().default('retrying'),
    errorMessage: text("error_message"), // Error details if failed
    createdAt,
    updatedAt,
  },
  (t) => [
    // Index for event lookup
    index("webhook_deliveries_event_idx").on(t.eventId),
    // Index for status filtering
    index("webhook_deliveries_status_idx").on(t.status),
    // Index for cleanup (old failed deliveries)
    index("webhook_deliveries_created_idx").on(t.createdAt.desc()),
    // Unique constraint to prevent duplicate tracking
    unique("webhook_deliveries_event_unique").on(t.eventId),
  ]
);

/**
 * User notifications table
 * @summary Stores user notifications for various system events
 * @example
 * {
 *   "id": "notif123",
 *   "user_id": "user456",
 *   "type": "payment_success",
 *   "title": "Payment Successful",
 *   "message": "Your purchase of 100 credits was successful",
 *   "data": {"credits": 100, "amount": 9.99},
 *   "read": false,
 *   "created_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const userNotifications = pgTable(
  "user_notifications",
  {
    id: id(),
    userId: userId().references(() => users.userId, { onDelete: "cascade" }),
    type: text("type").notNull(), // Notification type: payment_success, refund, etc.
    title: text("title").notNull(),
    message: text("message").notNull(),
    data: jsonb("data"), // Additional structured data
    read: boolean("read").notNull().default(false),
    createdAt,
    updatedAt,
  },
  (t) => [
    // Index for user's notifications
    index("user_notifications_user_idx").on(t.userId, t.createdAt.desc()),
    // Index for unread notifications
    index("user_notifications_unread_idx").on(t.userId, t.read),
    // Index for notification type
    index("user_notifications_type_idx").on(t.type),
    // Index for cleanup (old read notifications)
    index("user_notifications_created_idx").on(t.createdAt.desc()),
  ]
);

/**
 * Page translations table
 * @summary Stores translated versions of page text for multi-language support
 * @example
 * {
 *   "id": "trans123",
 *   "page_id": "page456",
 *   "language": "es",
 *   "translated_text": "El pasillo se extendía infinitamente ante mí...",
 *   "created_at": "2023-01-01T00:00:00.000Z",
 *   "updated_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const pageTranslations = pgTable(
  "page_translations",
  {
    id: id(),
    pageId: pageId("cascade"), // Delete if page is deleted
    language: text("language").notNull(), // Target language code (ISO 639-1: en, es, fr, etc.)
    translatedText: text("translated_text").notNull(), // Translated page text
    createdAt,
    updatedAt,
  },
  (t) => [
    // Unique constraint on (pageId, language) to ensure one translation per page per language
    unique("page_translations_page_language_unique").on(t.pageId, t.language),
    // Index for page translations lookup
    index("page_translations_page_idx").on(t.pageId),
    // Index for language filtering
    index("page_translations_language_idx").on(t.language),
    // Index for cleanup (old translations)
    index("page_translations_created_idx").on(t.createdAt.desc()),
  ]
);

/**
 * User check-ins table
 * @summary Tracks daily user check-ins and credit claims for daily rewards
 * @example
 * {
 *   "id": "checkin123",
 *   "user_id": "user456",
 *   "check_in_date": "2026-05-04",
 *   "credits_claimed": 30,
 *   "created_at": "2026-05-04T00:00:00.000Z",
 *   "updated_at": "2026-05-04T00:00:00.000Z"
 * }
 */
export const userCheckins = pgTable(
  "user_checkins",
  {
    id: id(),
    userId: userId().references(() => users.userId, { onDelete: "cascade" }),
    checkInDate: date, // UTC date in YYYY-MM-DD format
    creditsClaimed: integer("credits_claimed").notNull(), // Number of credits claimed for this check-in
    createdAt,
    updatedAt,
  },
  (t) => [
    // Unique constraint on (userId, checkInDate) to prevent multiple check-ins per day
    unique("user_checkins_user_date_unique").on(t.userId, t.checkInDate),
    // Index for user's check-in history
    index("user_checkins_user_idx").on(t.userId, t.checkInDate.desc()),
    // Index for daily statistics
    index("user_checkins_date_idx").on(t.checkInDate),
    // Index for cleanup (old check-ins)
    index("user_checkins_created_idx").on(t.createdAt.desc()),
  ]
);