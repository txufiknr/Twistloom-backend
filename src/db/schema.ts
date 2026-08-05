import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, real, jsonb, uuid, index, primaryKey, integer, unique, type UpdateDeleteAction, boolean, vector } from "drizzle-orm/pg-core";
import type { CheckinClaimType, FeedbackAdminStatus, FeedbackCategory, FeedbackStatus, Gender, Source, UserActivityType, UserTier } from "../types/user.js";
import type { LikeTargetType } from "../types/user.js";
import type { CharacterMemoryTranslation, CharacterPlan, HealthStatus, InjuryTranslation, InventoryItem, InventoryItemTranslation, StoryMC, StoryMCCandidate, StoryMCTranslation } from "../types/character.js";
import type { BookGenerationStatus, StoryGenerationStep, BookStatus, BookVisibility, Book, BookStats, UploadedImageType, BookMode } from "../types/book.js";
import type { AdvancedOptionsConfig } from "../types/book-creation.js";
import type { SessionStatus } from "../types/session.js";
import type { AIChatProvider } from "../types/ai-chat.js";
import type { PsychologicalProfile, PsychologicalFlags, HiddenState, MemoryIntegrity, Difficulty, Action, StateDelta, Ending, PlotFlag, ActionTranslation, StoryStateSource, FutureNote, FactHistory, SelectedAction, StoryState, StoryPage, SceneType, Mood, StoryMomentum, SceneCharacter, SanityState } from "../types/story.js";
import type { CharacterMemory, Injury } from "../types/character.js";
import type { PlaceMemory, PlaceMemoryTranslation, PlaceWeather } from "../types/places.js";
import type { ActionProgressStatus } from "../types/candidate-generation.js";
import type { StoryThread, StoryThreadTranslation } from "../types/story-thread.js";
import type { CustomActionOutcome, CustomActionRejectionCategory } from "../types/custom-action.js";
import type { CanonValidationOutcome, CanonViolation, CanonViolationType } from "../types/canon-validation.js";
import type { TransactionType } from "../types/credits.js";
import { PAYMENT_GATEWAY, type PaymentGateway } from "../types/payment.js";
import type { SubscriptionStatus, SubscriptionTransactionType } from "../types/subscription.js";
import type { ResourceAIProvider, ResourceAIScore, ResourceTimestamp, ResourceTranslatorType } from "../types/api.js";
import { BOOK_MIN_PAGES } from "../config/story.js";
import { FIRST_TIME_CREDITS } from "../config/credits.js";

/** Pre-defined columns */
// const id = () => uuid("id").primaryKey().$defaultFn(generateId);
const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const userId = () => uuid("user_id").notNull();
const bookId = (onDelete: UpdateDeleteAction = "cascade") => uuid("book_id").notNull().references(() => books.id, { onDelete });
const pageId = (onDelete: UpdateDeleteAction = "cascade") => uuid("page_id").notNull().references(() => pages.id, { onDelete });
const gender = text("gender").$type<Gender>(); // 'male', 'female', 'unknown'
const date = text("date").notNull(); // YYYY-MM-DD format
const createdAt = timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date());
const lastActive = timestamp("last_active", { withTimezone: true }).defaultNow().notNull();
const branchId = text("branch_id").notNull().default("main"); // Which reality you're in

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
    mood: text("mood").$type<Mood>(), // Current emotional atmosphere
    placeId: text("place_id"), // Current place ID where the story is taking place
    weather: text("weather").$type<PlaceWeather>(), // Current weather conditions at the place
    calendarDate: text("calendar_date"), // Current in-world date (e.g., "2026-07-26")
    elapsedDays: integer("elapsed_days"), // Days elapsed since the story begin
    timeOfDay: text("time_of_day"), // Current time mark (e.g., time range, 'night', 'HH:mm', 'unknown')
    sceneType: text("scene_type").$type<SceneType>(), // Current narrative function
    momentum: text("momentum").$type<StoryMomentum>(), // Current pressure level
    charactersPresent: jsonb("characters_present").$type<SceneCharacter[]>().notNull().default(sql`'[]'::jsonb`), // Characters present
    keyEvents: text("key_events").array().notNull().default(sql`ARRAY[]::text[]`),
    keyObjects: text("key_objects").array().notNull().default(sql`ARRAY[]::text[]`),
    actions: jsonb("actions").$type<Action[]>().notNull().default(sql`'[]'::jsonb`), // 2-3 branching actions
    stateDelta: jsonb("delta").$type<StateDelta>().notNull().default(sql`'{}'::jsonb`), // Incremental delta (chronological)
    aiProvider: text("ai_provider").$type<AIChatProvider | 'none'>(),
    aiModel: text("ai_model"),
    aiEvalProvider: text("ai_eval_provider").$type<AIChatProvider | 'none'>(),
    aiEvalModel: text("ai_eval_model"),
    scoreBefore: integer("score_before"), // Evaluation score (0-100)
    scoreAfter: integer("score_after"), // Refinement score (0-100)
    pendingGenerationCount: integer("pending_generation_count").notNull().generatedAlwaysAs(
      // Count of actions without pre-generated destinations
      sql`(
        jsonb_array_length(actions) -
        jsonb_array_length(
          jsonb_path_query_array(
            actions,
            '$[*] ? (exists(@.destinationPageIds) && @.destinationPageIds.type() == "array" && @.destinationPageIds.size() > 0)'
          )
        )
      )`,
    ),
    isGeneratingStartedAt: timestamp("is_generating_started_at", { withTimezone: true }), // When candidate generation started. `null` means not generating.
    visitCount: integer("visit_count").notNull().default(0), // Count of times this page has been visited (denormalized for performance)
    createdAt,
    updatedAt,
  } satisfies Record<keyof StoryPage | 'id' | 'userId' | 'parentId' | 'branchId' | 'bookId' | 'page' | 'pendingGenerationCount' | 'isGeneratingStartedAt' | 'visitCount' | 'elapsedDays' | ResourceAIProvider | ResourceAIScore | ResourceTimestamp, unknown>,
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
    // Partial index for the retry-pending-generations cron: only pages that need
    // candidate generation are scanned (`WHERE pending_generation_count > 0`),
    // keeping the index far smaller than the full-column index above.
    index("pages_pending_generation_active_idx")
      .on(t.pendingGenerationCount)
      .where(sql`${t.pendingGenerationCount} > 0`),
    // Partial index for stuck-generation cleanup (`cleanupStuckGenerations()`):
    // only in-flight rows (`WHERE is_generating_started_at IS NOT NULL`) are
    // scanned when resetting stale generation markers.
    index("pages_is_generating_started_active_idx")
      .on(t.isGeneratingStartedAt)
      .where(sql`${t.isGeneratingStartedAt} IS NOT NULL`),
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
 *   "future_notes": [...],
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
    traumaTags: text("trauma_tags").array().notNull().default(sql`ARRAY[]::text[]`),
    futureNotes: jsonb("future_notes").$type<FutureNote[]>().notNull().default(sql`'[]'::jsonb`),
    factsHistory: jsonb("facts_history").$type<Record<string, FactHistory[]>>().notNull().default(sql`'{}'::jsonb`), // Chronological history of discovered facts
    plotFlags: jsonb("plot_flags").$type<PlotFlag[]>().notNull().default(sql`'[]'::jsonb`), // Narrative flags and hints
    inventory: jsonb("inventory").$type<InventoryItem[]>().notNull().default(sql`'[]'::jsonb`), // Items and resources
    psychologicalProfile: jsonb("psychological_profile").$type<PsychologicalProfile>().notNull(), // PsychologicalProfile structure
    hiddenState: jsonb("hidden_state").$type<HiddenState>().notNull(), // Hidden narrative state structure
    memoryIntegrity: text("memory_integrity").$type<MemoryIntegrity>().notNull().default("stable"), // "stable" | "fragmented" | "corrupted"
    difficulty: text("difficulty").$type<Difficulty>().notNull().default("low"), // "low" | "medium" | "high" | "nightmare"
    viableEnding: jsonb("viable_ending").$type<Ending>(),
    characters: jsonb("characters").$type<Record<string, CharacterMemory>>().notNull().default(sql`'{}'::jsonb`), // Character records
    plannedCharacters: jsonb("planned_characters").$type<CharacterPlan[]>().notNull().default(sql`'[]'::jsonb`), // Unintroduced characters
    places: jsonb("places").$type<Record<string, PlaceMemory>>().notNull().default(sql`'{}'::jsonb`), // Place records
    threads: jsonb("threads").$type<StoryThread[]>().notNull().default(sql`'[]'::jsonb`), // Ongoing narrative threads
    actionsHistory: jsonb("actions_history").$type<SelectedAction[]>().notNull().default(sql`'[]'::jsonb`), // History of actions leading to this state
    injuries: jsonb("injuries").$type<Injury[]>().notNull().default(sql`'[]'::jsonb`), // MC injuries
    healthStatus: jsonb("health_status").$type<HealthStatus>(), // MC's health status
    sanityState: jsonb("sanity_state").$type<SanityState>(), // Reader-facing sanity resource
    contextHistory: text("context_history").notNull().default(""), // AI-summarized story context from page 1 to current
    isMajorEvent: boolean("is_major_event").notNull().default(false),
    source: text("source").$type<StoryStateSource>().notNull().default("original"),
    createdAt,
    updatedAt,
  } satisfies Record<keyof StoryState | 'bookId' | 'source' | ResourceTimestamp, unknown>,
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
    name: text("name").notNull(),
    username: text("username").notNull().unique("users_username_unique"), // Unique constraint for login
    email: text("email").notNull().unique("users_email_unique"), // Unique constraint for login
    passwordHash: text("password_hash"), // Hashed password for email/password authentication
    /** Payment-provider customer ID (Stripe `cus_xxx` or Xendit customer ID) */
    customerId: text("customer_id").unique("users_customer_id_unique"),
    credits: integer("credits").notNull().default(FIRST_TIME_CREDITS),
    penName: text("pen_name"),
    bio: text("bio"), // User bio/description
    gender,
    imageUrl: text("image_url"),
    tier: text("tier").$type<UserTier>(),
    isNewUser: boolean("is_new_user").notNull().default(true), // For user onboarding
    referrerId: uuid("referrer_id"),
    /**
     * When referral credits were paid for this user (both sides).
     * Null = linked but not yet rewarded (e.g. email not verified).
     * Set once — idempotency guard against double-pay on re-verify / races.
     * Also the write-once edge that fires `users_referral_trigger`
     * (+1 `user_counters.referred_users` for the referrer).
     */
    referralRewardedAt: timestamp("referral_rewarded_at", { withTimezone: true }),
    source: text("source").$type<Source>(), // How user discovered the platform (set during onboarding)
    subscriptionId: uuid("subscription_id"),
    vipExpiresAt: timestamp("vip_expires_at", { withTimezone: true }),
    // Set once when a VIP trial starts; never cleared, even if the subscription is later
    // deleted/cancelled/refunded. This is what enforces one-trial-per-user, independent of
    // whatever happens to the underlying Stripe subscription record. See VIP_FREE_TRIAL_ROADMAP.md.
    vipTrialUsedAt: timestamp("vip_trial_used_at", { withTimezone: true }),
    // GDPR compliance: audit trail for terms of service acceptance
    termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
    termsVersion: text("terms_version"),
    // COPPA/GDPR: age confirmation timestamp
    ageConfirmedAt: timestamp("age_confirmed_at", { withTimezone: true }),
    tokenVersion: integer("token_version").notNull().default(0), // Session version for JWT revocation
    /**
     * Admin ban (P4). NULL = not banned. Non-null = banned since this timestamp.
     * Auth rejects when set; ban bumps tokenVersion to revoke JWTs.
     */
    bannedAt: timestamp("banned_at", { withTimezone: true }),
    /**
     * Account / app language of record (`en` | `id`).
     * Synced fire-and-forget from frontend language picker. Email uses this
     * unless email_preferences.emailLocale override is set.
     */
    preferredLocale: text("preferred_locale").notNull().default("en"),
    /**
     * Optional product/engagement email prefs (weekly, monthly, announcements)
     * plus optional emailLocale override (null = follow preferredLocale).
     * Security & billing never consult engagement toggles. Null until onboarding
     * applies defaults — see DEFAULT_EMAIL_PREFERENCES.
     */
    emailPreferences: jsonb("email_preferences").$type<{
      weeklyRecommendations: boolean;
      monthlyActivitySummary: boolean;
      productAnnouncements: boolean;
      emailLocale?: "en" | "id" | null;
    }>(),
    lastActive,
    createdAt,
    updatedAt,
  },
  (t) => [
    // Index for gender-based analytics
    index("users_gender_idx").on(t.gender),
    // Index for user creation trends
    index("users_created_at_idx").on(t.createdAt),
    // Index for VIP expiration queries
    index("users_vip_expires_idx").on(t.vipExpiresAt).where(sql`${t.vipExpiresAt} IS NOT NULL`),
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
 * User providers table for account linking
 * @summary Tracks which authentication providers are linked to each user account
 * Enables dual-auth (credentials + Google) with the ability to link/unlink independently.
 *
 * One row per provider per user (composite PK).
 * provider_account_id stores the Google `sub` for OAuth providers (null for credentials).
 *
 * @example
 * {
 *   "user_id": "user123",
 *   "provider": "google",
 *   "provider_account_id": "1234567890",
 *   "created_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const userProviders = pgTable(
  "user_providers",
  {
    userId: userId().references(() => users.userId, { onDelete: "cascade" }),
    provider: text("provider").$type<'credentials' | 'google'>().notNull(),
    providerAccountId: text("provider_account_id"),
    createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.provider] }),
    // Prevent same Google account from linking to multiple Twistloom users
    unique("user_providers_account_unique").on(t.provider, t.providerAccountId),
    // Index for user provider lookups
    index("user_providers_user_idx").on(t.userId),
  ]
);

/**
 * Create auth sessions table for per-device logout
 * @summary Track every active device login with unique session IDs for selective logout
 * @example
 * {
 *   "id": "session123", // Unique ID for this device session (embedded in JWT)
 *   "user_id": "user456",
 *   "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)...",
 *   "ip_address": "192.168.1.1",
 *   "device_name": "Chrome on Windows",
 *   "last_active_at": "2024-01-15T10:30:00.000Z",
 *   "created_at": "2024-01-01T00:00:00.000Z",
 *   "updated_at": "2024-01-15T10:30:00.000Z"
 * }
 */
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: id(), // Unique ID for this device session (embedded in JWT payload)
    userId: userId().references(() => users.userId, { onDelete: "cascade" }),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    deviceName: text("device_name"),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).defaultNow(),
    createdAt,
    updatedAt,
  },
  (t) => [
    // Index for user session queries
    index("auth_sessions_user_idx").on(t.userId),
    // Index for session ID lookups (used in JWT verification)
    index("auth_sessions_id_idx").on(t.id),
    // Index for cleanup (inactive sessions)
    index("auth_sessions_last_active_idx").on(t.lastActiveAt),
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
    userId: uuid("user_id").references(() => users.userId, { onDelete: "set null" }), // Preserve books when users are deleted
    slug: text("slug").unique(), // SEO-friendly URL identifier
    title: text("title").notNull(),
    totalPages: integer("total_pages").notNull().default(BOOK_MIN_PAGES),
    language: text("language").notNull().default('en'),
    hook: text("hook"),
    summary: text("summary"),
    imageId: text("image_id").references(() => uploadedImages.imageId, { onDelete: "set null" }), // Cover image
    trendingScore: real("trending_score").default(0),
    isOriginal: boolean("is_original").notNull().default(false),
    keywords: text("keywords").array().notNull().default(sql`ARRAY[]::text[]`), // e.g. ['reality-bending', 'psychological-horror', 'unreliable-narrator', 'time-loop-feel', 'paranormal', 'forgotten-trauma']
    mode: text("mode").$type<BookMode>().notNull().default('interactive'), // Book creation mode (story format)
    status: text("status").$type<BookStatus>().notNull().default('draft'),
    visibility: text("visibility").$type<BookVisibility>().notNull().default('private'),
    mc: jsonb("mc").$type<StoryMC>().notNull(), // Main character profile with name, age, gender, bio, and image
    likesCount: integer("likes_count").notNull().default(0), // Total likes for this book
    readCount: integer("read_count").notNull().default(0), // Total reads/sessions for this book
    branchesCount: integer("branches_count").notNull().default(0), // Total unique branches (maintained by trigger)
    commentsCount: integer("comments_count").notNull().default(0), // Total parent comments (maintained by trigger)
    testimonialsCount: integer("testimonials_count").notNull().default(0), // Total testimonials (maintained by trigger)
    rating: real("rating"), // Average rating (1-5 scale, 1 decimal) of approved testimonials (maintained by trigger)
    ratingCount: integer("rating_count"), // Count of approved testimonials carrying a rating (maintained by trigger)
    completeCount: integer("complete_count").notNull().default(0), // Total unique users who completed the book (maintained by trigger)
    completionRate: real("completion_rate"), // Completed/started percentage (maintained by trigger)
    topPick: timestamp("top_pick", { withTimezone: true }), // Editor's pick
    creditsPrice: integer("credits_price"),
    originalThemeInput: text("original_theme_input"),
    storyStartDate: text("story_start_date"),
    advancedOptions: jsonb("advanced_options").$type<AdvancedOptionsConfig>(),
    ending: jsonb("ending").$type<Ending>(),
    createdAt,
    updatedAt,
  } satisfies Record<keyof Omit<Book, 'stats' | 'imageUrl'> | keyof BookStats | ResourceTimestamp, unknown>,
  (t) => [
    // Optimize trending sorting by pre-calculated score (cron-based with time decay)
    index("books_trending_score_idx").on(t.trendingScore.desc()),
    // Optimize newest sorting by creation date
    index("books_created_at_idx").on(t.createdAt.desc()),
    // Optimize top-picks sorting
    index("books_top_pick_idx").on(t.topPick.desc()).where(sql`${t.topPick} IS NOT NULL`),
    // Optimize rating threshold filtering (rating >= X / rating <= X) and future "top-rated"
    // sorting. Partial: only rated books qualify for any rating filter, and the predicate is
    // implied by every rating filter condition so Postgres can always use this index.
    index("books_rating_idx").on(t.rating.desc()).where(sql`${t.rating} IS NOT NULL`),
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
    // Unique index for slug lookups (optimizes book retrieval by slug)
    index("books_slug_idx").on(t.slug),
    // GIN index for keywords array (enables efficient array operations)
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
 * Branches table for human-readable display names
 * @summary Store human-readable branch display names for non-main branches
 * 
 * Only non-main branches are stored here. The 'main' branch is identified by
 * the text literal "main" on pages.branch_id and has no row in this table
 * (its display name falls back to the book title at query time).
 * 
 * Rows are created atomically alongside page insertion inside persistPageWithState.
 * displayName uniqueness per book is enforced by a unique constraint.
 * slug is auto-derived via generatedAlwaysAs.
 * 
 * @example
 * {
 *   "branch_id": "0194f2d1-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
 *   "book_id": "book456",
 *   "display_name": "The Dark Path",
 *   "slug": "the-dark-path",
 *   "created_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const branches = pgTable(
  "branches",
  {
    branchId: text("branch_id").primaryKey(),
    bookId: bookId("cascade"),
    displayName: text("display_name").notNull(),
    slug: text("slug").notNull().generatedAlwaysAs(
      sql`lower(regexp_replace(regexp_replace(display_name, '[^a-zA-Z0-9\\s]', '', 'g'), '\\s+', '-', 'g'))`
    ),
    createdAt,
  },
  (t) => [
    unique("branches_book_name_unique").on(t.bookId, t.displayName),
    unique("branches_book_slug_unique").on(t.bookId, t.slug),
    index("branches_book_idx").on(t.bookId),
  ]
);

/**
 * Async book generations tracking table
 * @summary Track async book creation generation status and parameters
 * @example
 * {
 *   "id": "gen123",
 *   "book_id": "book456",
 *   "user_id": "user789",
 *   "theme": "psychological thriller",
 *   "mc_candidate": {
 *     "name": "Sarah Chen",
 *     "age": 28,
 *     "gender": "female",
 *     "bio": "A detective with a troubled past"
 *   },
 *   "generate_cover": true,
 *   "generation_status": "in_progress",
 *   "generation_step": "generating",
 *   "generation_progress": 50,
 *   "generation_error": null,
 *   "generation_started_at": "2023-01-01T00:00:00.000Z",
 *   "generation_completed_at": null,
 *   "created_at": "2023-01-01T00:00:00.000Z",
 *   "updated_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const bookGenerations = pgTable(
  "book_generations",
  {
    bookId: bookId("cascade").primaryKey(),
    userId: userId(),
    theme: text("theme"),
    aiComment: text("ai_comment"),
    aiValidationCompleted: boolean("ai_validation_completed").notNull().default(false),
    aiProvider: text("ai_provider").$type<AIChatProvider | 'none'>(),
    aiModel: text("ai_model"),
    language: text("language"),
    titleIdea: text("title_idea"),
    mode: text("mode").$type<BookMode>().notNull().default('interactive'), // Book creation mode (story format)
    mcCandidate: jsonb("mc_candidate").$type<StoryMCCandidate>(),
    generateCoverImage: boolean("generate_cover_image").notNull().default(false),
    generationStatus: text("generation_status").$type<BookGenerationStatus>().default('pending'),
    generationStep: text("generation_step").$type<StoryGenerationStep>(),
    generationError: text("generation_error"),
    generationStartedAt: timestamp("generation_started_at", { withTimezone: true }),
    generationCompletedAt: timestamp("generation_completed_at", { withTimezone: true }),
    generationDurationMs: integer("generation_duration_ms").generatedAlwaysAs(
      // Auto-calculated from generation_started_at and generation_completed_at
      sql`CASE
        WHEN generation_completed_at IS NOT NULL AND generation_started_at IS NOT NULL
        THEN EXTRACT(EPOCH FROM (generation_completed_at - generation_started_at))::int * 1000
      END`
    ),
    isGeneratingStartedAt: timestamp("is_generating_started_at", { withTimezone: true }),
    isRefunded: timestamp("is_refunded"),
    cancellationRequestedAt: timestamp("cancellation_requested_at", { withTimezone: true }),
    aiFinalComment: text("ai_final_comment"),
    advancedOptions: jsonb("advanced_options").$type<AdvancedOptionsConfig>(),
    createdAt,
    updatedAt,
  },
  (t) => [
    // Index for book generation queries
    index("book_generations_book_idx").on(t.bookId),
    // Index for user queries (e.g., fetching user's pending generations)
    index("book_generations_user_idx").on(t.userId),
    // Index for generation status filtering
    index("book_generations_status_idx").on(t.generationStatus),
    // Index for active generations
    index("book_generations_active_idx").on(t.generationStatus).where(sql`${t.generationStatus} = 'in_progress'`),
    // Index for locking - find stale generations
    index("book_generations_locking_idx").on(t.isGeneratingStartedAt),
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
    userId: userId().references(() => users.userId, { onDelete: "cascade" }),
    bookId: bookId("cascade"),
    actionedPageId: uuid("actioned_page_id").notNull(), // page which action selected from
    nextPageId: uuid("next_page_id").notNull(), // action's destination page ID
    action: jsonb("action").$type<SelectedAction>().notNull(),
    isPaid: boolean("is_paid"),
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
    // Composite index for complete count queries (optimized for completeCount query)
    index("user_page_progress_book_actioned_idx").on(t.bookId, t.actionedPageId),
    // Index for action tracking
    // index("user_page_progress_action_gin_idx").using("gin", t.action),
  ]
);

/**
 * Action progress tracking table
 * @summary Track per-action generation progress for branching candidates
 * @example
 * {
 *   "id": "progress123",
 *   "page_id": "page456",
 *   "action_text": "Investigate the noise",
 *   "status": "completed",
 *   "progress": 100,
 *   "error": null,
 *   "started_at": "2023-01-01T00:00:00.000Z",
 *   "completed_at": "2023-01-01T00:05:00.000Z",
 *   "created_at": "2023-01-01T00:00:00.000Z",
 *   "updated_at": "2023-01-01T00:05:00.000Z"
 * }
 */
export const actionProgress = pgTable(
  "action_progress",
  {
    id: id(),
    pageId: pageId("cascade"),
    /** Action text (unique identifier for the action) */
    actionText: text("action_text").notNull(),
    /** Current status of the action generation */
    status: text("status").$type<ActionProgressStatus>().notNull().default('started'),
    /** Action destination page ID (when status is 'completed') */
    // destinationPageIds: jsonb("destination_page_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    destinationPageIds: text("destination_page_ids").array().notNull().default(sql`ARRAY[]::text[]`),
    /** Error message if status is 'failed' */
    error: text("error"),
    /** Timestamp when action generation started */
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** Timestamp when action generation completed */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    // Unique constraint on (pageId, actionText) to ensure one progress entry per action
    unique("action_progress_page_action_unique").on(t.pageId, t.actionText),
    // Index for querying progress by page
    index("action_progress_page_idx").on(t.pageId),
    // Index for filtering by status (e.g., find all failed actions)
    index("action_progress_status_idx").on(t.status),
    // Index for active generations (in-progress actions)
    index("action_progress_active_idx").on(t.status).where(sql`${t.status} = 'started'`),
  ]
);

/**
 * Create usage table to track daily AI requests
 * @summary Track how many AI requests were made per day by provider, model, and context,
 * with token and duration metrics for cost analysis and performance monitoring.
 */
export const usage = pgTable(
  "usage",
  {
    date,
    provider: text("provider").$type<AIChatProvider>().notNull(),
    model: text("model"), // Specific model used (e.g., "gemini-2.0-flash", "llama-3.3-70b")
    requests: integer("requests").notNull().default(0),
    inputTokens: integer("input_tokens"), // Prompt tokens consumed
    outputTokens: integer("output_tokens"), // Completion tokens generated
    totalTokens: integer("total_tokens"), // Total tokens (input + output)
    cachedTokens: integer("cached_tokens"), // Tokens served from provider-side cache
    durationMs: integer("duration_ms"), // Wall-clock request duration in milliseconds
    context: text("context"), // Usage context, e.g. 'story-page', 'ai-stream-sse', etc.
  },
  (t) => [
    // Composite primary key for date + provider + context + model
    primaryKey({ columns: [t.date, t.provider, t.context, t.model] }),
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
    userId: userId().references(() => users.userId, { onDelete: "cascade" }), // Cascade delete when user is deleted
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
    userId: userId().references(() => users.userId, { onDelete: "cascade" }), // Cascade delete when user is deleted
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
    userId: userId().references(() => users.userId, { onDelete: "cascade" }), // Cascade delete when user is deleted
    bookId: bookId("cascade"), // Delete if book is deleted
    pageId: uuid("page_id").references(() => pages.id, { onDelete: "cascade" }), // Delete if page is deleted
    paragraphNumber: integer("paragraph_number"), // 1-based paragraph index within the page (null for page-level comments)
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
    
    // Composite index for parent comments count (optimized for commentsCount query)
    index("user_comments_book_parent_idx").on(t.bookId, t.parentCommentId),

    // Composite index for per-page comments (page-level + paragraph-level)
    index("user_comments_book_page_idx").on(t.bookId, t.pageId),

    // Composite index for per-paragraph comments (optimized for paragraph-scoped queries)
    index("user_comments_book_page_para_idx").on(t.bookId, t.pageId, t.paragraphNumber),

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
    userId: userId().references(() => users.userId, { onDelete: "cascade" }), // Cascade delete when user is deleted
    bookId: bookId("cascade"), // Delete if book is deleted
    pageId: pageId("set null"), // Reset to page 1 when page is deleted, but if possible, should revert this into previous page (from userPageProgress)
    previousPageId: uuid("previous_page_id"), // For navigation history
    // Branch-aware "active-tip" frontier: the page the reader is currently progressing
    // through (forward progress OR a different branch), preserved on back-navigation.
    // `frontierAncestorIds` holds the frontier page's own id plus the page ids in
    // its actionsHistory, enabling the ancestry rule without re-deriving history.
    frontierPageId: uuid("frontier_page_id").references(() => pages.id, { onDelete: "set null" }), // Active-tip page id (branch-aware frontier)
    frontierPageNumber: integer("frontier_page_number").notNull().default(1), // Display hint only — NOT used for gating
    frontierAncestorIds: uuid("frontier_ancestor_ids").array().notNull().default(sql`ARRAY[]::uuid[]`), // frontier page id + its actionsHistory pageIds
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
 * Create user completed books table
 * @summary Track books that users have completed (reached the last page)
 * @example
 * {
 *   "user_id": "user123",
 *   "book_id": "book456",
 *   "branch_id": "branch789",
 *   "completed_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const userCompletedBooks = pgTable(
  "user_completed_books",
  {
    id: id(),
    userId: userId().references(() => users.userId, { onDelete: "cascade" }),
    bookId: bookId("cascade"), // Delete if book is deleted
    pageId: pageId("cascade"), // Track which last page (canonical ending identifier)
    branchId: uuid("branch_id").notNull(), // Track which branch the user completed (metadata only)
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One row = one unique ending discovered by one user. Reaching the same ending again is ignored.
    unique("user_completed_books_user_book_page_unique").on(t.userId, t.bookId, t.pageId),
    // Index for user's completed books
    index("user_completed_books_user_idx").on(t.userId, t.completedAt.desc()),
    // Index for book's completions
    index("user_completed_books_book_idx").on(t.bookId),
    // Index for branch-specific queries
    index("user_completed_books_branch_idx").on(t.branchId),
    // Index for page-specific queries
    index("user_completed_books_page_idx").on(t.pageId),
  ]
);

/**
 * Create user action hints table
 * @summary Track action hints purchased by users for specific pages
 * @example
 * {
 *   "id": "hint123",
 *   "user_id": "user456",
 *   "page_id": "page789",
 *   "action_text": "Investigate the noise",
 *   "created_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const userActionHints = pgTable(
  "user_action_hints",
  {
    id: id(),
    userId: userId().references(() => users.userId, { onDelete: "cascade" }),
    pageId: pageId("cascade"), // Delete if page is deleted
    actionText: text("action_text").notNull(), // The action text for which hint was purchased
    createdAt,
  },
  (t) => [
    // Unique constraint on (userId, pageId, actionText) to prevent duplicate hint purchases
    unique("user_action_hints_user_page_action_unique").on(t.userId, t.pageId, t.actionText),
    // Index for user's purchased hints
    index("user_action_hints_user_idx").on(t.userId),
    // Index for page-specific hints
    index("user_action_hints_page_idx").on(t.pageId),
    // Index for recent hint purchases
    index("user_action_hints_created_idx").on(t.createdAt.desc()),
  ]
);

/**
 * Create user purchased books table
 * @summary Track books that users have purchased with credits
 * @example
 * {
 *   "id": "purchase123",
 *   "user_id": "user456",
 *   "book_id": "book789",
 *   "credits_price": 50,
 *   "created_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const userPurchasedBooks = pgTable(
  "user_purchased_books",
  {
    id: id(),
    userId: userId().references(() => users.userId, { onDelete: "cascade" }),
    bookId: bookId("cascade"), // Delete if book is deleted
    creditsPrice: integer("credits_price").notNull(), // The price paid in credits at time of purchase
    createdAt,
  },
  (t) => [
    // Unique constraint on (userId, bookId) to prevent duplicate purchases
    unique("user_purchased_books_user_book_unique").on(t.userId, t.bookId),
    // Index for user's purchased books
    index("user_purchased_books_user_idx").on(t.userId, t.createdAt.desc()),
    // Index for book's purchases
    index("user_purchased_books_book_idx").on(t.bookId),
    // Index for recent purchases
    index("user_purchased_books_created_idx").on(t.createdAt.desc()),
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
    activityType: text("activity_type").$type<UserActivityType>().notNull(), // e.g., "book_created", "liked", "commented", "followed", "favorited", "session_updated"
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
 * - Purchases: User buys credits (amountCents is set; gateway identifies the provider)
 * - Usage: User consumes credits for AI generation (amountCents is null)
 *
 * Provider IDs are gateway-agnostic: Stripe payment intents / event IDs or
 * Xendit payment / event IDs. Uniqueness is scoped by `(gateway, provider_*)`.
 *
 * @example
 * {
 *   "id": "txn123",
 *   "user_id": "user456",
 *   "type": "purchase",
 *   "credits": 100,
 *   "amount_cents": 999,
 *   "gateway": "stripe",
 *   "provider_payment_id": "pi_xxx",
 *   "provider_event_id": "evt_xxx",
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
    amountCents: integer("amount_cents"),
    context: text("context"), // Additional context for usage transactions (e.g., "book_creation")
    metadata: jsonb("metadata"), // Additional metadata for the transaction
    /** Payment gateway that produced this row */
    gateway: text("gateway").$type<PaymentGateway>().notNull().default(PAYMENT_GATEWAY.stripe),
    /** Gateway payment ID (Stripe `pi_xxx`, Xendit payment/invoice ID) — idempotency */
    providerPaymentId: text("provider_payment_id"),
    /** Gateway webhook event ID — idempotency */
    providerEventId: text("provider_event_id"),
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
    // Composite unique: payment ID is unique per gateway (allows NULL rows)
    unique("transactions_provider_payment_unique").on(t.gateway, t.providerPaymentId),
    // Composite unique: event ID is unique per gateway (allows NULL rows)
    unique("transactions_provider_event_unique").on(t.gateway, t.providerEventId),
  ]
);

/**
 * Webhook delivery tracking table
 * @summary Tracks payment-gateway webhook delivery status for monitoring and debugging
 * @example
 * {
 *   "id": "webhook123",
 *   "gateway": "stripe",
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
    /** Payment gateway that delivered this event */
    gateway: text("gateway").$type<PaymentGateway>().notNull().default(PAYMENT_GATEWAY.stripe),
    eventId: text("event_id").notNull(), // Provider event ID
    eventType: text("event_type").notNull(), // Provider event type
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
    // Index for gateway filtering
    index("webhook_deliveries_gateway_idx").on(t.gateway),
    // Index for status filtering
    index("webhook_deliveries_status_idx").on(t.status),
    // Index for cleanup (old failed deliveries)
    index("webhook_deliveries_created_idx").on(t.createdAt.desc()),
    // Unique per gateway so Stripe and Xendit event IDs cannot collide
    unique("webhook_deliveries_gateway_event_unique").on(t.gateway, t.eventId),
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
 * Book translations table
 * @summary Stores translated versions of book metadata for multi-language support
 * @example
 * {
 *   "id": "bookTrans123",
 *   "book_id": "book456",
 *   "language": "es",
 *   "title": "El Fantasma",
 *   "hook": "Un misterioso fantasma acecha una mansión antigua...",
 *   "summary": "Un thriller psicológico sobre...",
 *   "keywords": ["fantasma", "mansión", "misterio"],
 *   "created_at": "2023-01-01T00:00:00.000Z",
 *   "updated_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const bookTranslations = pgTable(
  "book_translations",
  {
    id: id(),
    bookId: bookId("cascade"), // Delete if book is deleted
    language: text("language").notNull(), // Target language code (ISO 639-1: en, es, fr, etc.)
    title: text("title"), // Translated book title
    hook: text("hook"), // Translated book hook
    summary: text("summary"), // Translated book summary
    keywords: text("keywords").array().notNull().default(sql`ARRAY[]::text[]`),
    mc: jsonb("mc").$type<StoryMCTranslation>().notNull().default(sql`'{}'::jsonb`), // Translated main character info
    providerType: text("provider_type").$type<ResourceTranslatorType>(), // AI or translator
    providerName: text("provider_name"), // Provider name
    aiModel: text("ai_model"), // AI model name
    createdAt,
    updatedAt,
  },
  (t) => [
    // Unique constraint on (bookId, language) to ensure one translation per book per language
    unique("book_translations_book_language_unique").on(t.bookId, t.language),
    // Index for book translations lookup
    index("book_translations_book_idx").on(t.bookId),
    // Index for language filtering
    index("book_translations_language_idx").on(t.language),
    // Index for cleanup (old translations)
    index("book_translations_created_idx").on(t.createdAt.desc()),
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
    text: text("translated_text").notNull(), // Translated page text
    timeOfDay: text("time_of_day"),
    mood: text("mood"),
    weather: text("weather"),
    keyEvents: text("key_events").array().notNull().default(sql`ARRAY[]::text[]`),
    keyObjects: text("important_objects").array().notNull().default(sql`ARRAY[]::text[]`), // TODO: key_objects
    contextHistory: text("context_history"),
    characters: jsonb("characters").$type<CharacterMemoryTranslation[]>().notNull().default(sql`'[]'::jsonb`),
    places: jsonb("places").$type<PlaceMemoryTranslation[]>().notNull().default(sql`'[]'::jsonb`),
    inventory: jsonb("inventory").$type<InventoryItemTranslation[]>().notNull().default(sql`'[]'::jsonb`),
    injuries: jsonb("injuries").$type<InjuryTranslation[]>().notNull().default(sql`'[]'::jsonb`),
    threads: jsonb("threads").$type<StoryThreadTranslation[]>().notNull().default(sql`'[]'::jsonb`),
    actions: jsonb("actions").$type<ActionTranslation[]>().notNull().default(sql`'[]'::jsonb`),
    actionsHistory: jsonb("actions_history").$type<ActionTranslation[]>().notNull().default(sql`'[]'::jsonb`),
    providerType: text("provider_type").$type<ResourceTranslatorType>(), // AI or translator
    providerName: text("provider_name"), // Provider name
    aiModel: text("ai_model"), // AI model name
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
 *   "date": "2026-05-04",
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
    claimType: text("claim_type").$type<CheckinClaimType>().notNull(),
    creditsClaimed: integer("credits_claimed").notNull(), // Credits for this specific claim type
    createdAt,
    updatedAt,
  },
  (t) => [
    // One row per claim type per day — prevents double-claiming the same type
    unique("user_checkins_user_date_type_unique").on(t.userId, t.checkInDate, t.claimType),
    // Index for user's check-in history
    index("user_checkins_user_idx").on(t.userId, t.checkInDate.desc()),
    // Index for daily statistics
    index("user_checkins_date_idx").on(t.checkInDate),
    // Index for cleanup (old check-ins)
    index("user_checkins_created_idx").on(t.createdAt.desc()),
  ]
);

/**
 * User Counters Table
 * Maintains atomic, denormalized metrics for active engagement tracking.
 * All columns map 1-to-1 to AchievementMetric values and are kept in sync
 * by the triggers in ensureUserCountersTriggers().
 */
export const userCounters = pgTable(
  "user_counters",
  {
    userId: uuid("user_id").primaryKey().references(() => users.userId, { onDelete: "cascade" }),

    // Reading experiences
    booksGenerated: integer("books_generated").notNull().default(0),
    booksCompleted: integer("books_completed").notNull().default(0),
    pagesRead: integer("pages_read").notNull().default(0),
    pagesGenerated: integer("pages_generated").notNull().default(0),
    branchesOpened: integer("branches_opened").notNull().default(0),

    // Engagement metrics
    topupCredits: integer("topup_credits").notNull().default(0),
    referredUsers: integer("referred_users").notNull().default(0),
    followersCount: integer("followers_count").notNull().default(0),
    followingCount: integer("following_count").notNull().default(0),
    commentsCount: integer("comments_count").notNull().default(0),

    // Custom actions authored (outcome = 'allow' in custom_actions table)
    customActionsWritten: integer("custom_actions_written").notNull().default(0),

    // Check-in streak tracking
    activeCheckinStreak: integer("active_checkin_streak").notNull().default(0),
    maxCheckinStreak: integer("max_checkin_streak").notNull().default(0),

    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
  }
);

/**
 * User Achievements Table
 * Records exactly when a user successfully qualified for a badge.
 */
export const userAchievements = pgTable(
  "user_achievements",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.userId, { onDelete: "cascade" }),
    achievementId: text("achievement_id").notNull(), // Links directly to Registry IDs
    unlockedAt: timestamp("unlocked_at", { withTimezone: true }).defaultNow().notNull(),
    /** tracks whether the frontend has flashed the achievement celebration toast to the user */
    isNotified: boolean("is_notified").notNull().default(false),
  },
  (t) => [
    // Multi-row index optimizing user lookup
    index("user_achievements_user_idx").on(t.userId),
    // Structural guard preventing identical double badge entries 
    unique("user_achievement_unique").on(t.userId, t.achievementId),
  ]
);

/**
 * Subscriptions table
 * @summary Track active user subscriptions and their status (gateway-agnostic)
 *
 * Provider IDs store Stripe (`sub_xxx` / `cus_xxx` / `price_xxx`) or Xendit
 * equivalents depending on `gateway`. Uniqueness is `(gateway, provider_subscription_id)`.
 *
 * @example
 * {
 *   "id": "sub123",
 *   "user_id": "user456",
 *   "gateway": "stripe",
 *   "provider_subscription_id": "sub_1234567890",
 *   "provider_customer_id": "cus_1234567890",
 *   "provider_price_id": "price_1234567890",
 *   "status": "active",
 *   "current_period_start": "2023-01-01T00:00:00.000Z",
 *   "current_period_end": "2023-02-01T00:00:00.000Z",
 *   "cancel_at_period_end": false,
 *   "canceled_at": null,
 *   "metadata": {},
 *   "created_at": "2023-01-01T00:00:00.000Z",
 *   "updated_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: id(),
    // Was missing a FK reference to users, unlike every other user-linked table in this
    // schema (e.g. subscriptionTransactions.userId below). Added for referential integrity.
    userId: uuid("user_id").notNull().references(() => users.userId, { onDelete: "cascade" }),
    /** Payment gateway for this subscription */
    gateway: text("gateway").$type<PaymentGateway>().notNull().default(PAYMENT_GATEWAY.stripe),
    /** Gateway subscription/plan ID (Stripe `sub_xxx`, Xendit plan/repl ID) */
    providerSubscriptionId: text("provider_subscription_id").notNull(),
    /** Gateway customer ID (Stripe `cus_xxx`, Xendit customer ID) */
    providerCustomerId: text("provider_customer_id").notNull(),
    /** Gateway price/plan ID (Stripe `price_xxx`, Xendit plan price ID) */
    providerPriceId: text("provider_price_id").notNull(),
    status: text("status").$type<SubscriptionStatus>().notNull(),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    // Mirrors Stripe's own trial_start/trial_end so trial state can be read locally without
    // an API round-trip. See VIP_FREE_TRIAL_ROADMAP.md.
    isTrial: boolean("is_trial").notNull().default(false),
    trialEnd: timestamp("trial_end", { withTimezone: true }),
    metadata: jsonb("metadata"),
    createdAt,
    updatedAt,
  },
  (t) => [
    index("subscriptions_user_idx").on(t.userId),
    index("subscriptions_status_idx").on(t.status),
    index("subscriptions_period_end_idx").on(t.currentPeriodEnd),
    index("subscriptions_gateway_idx").on(t.gateway),
    unique("subscriptions_provider_unique").on(t.gateway, t.providerSubscriptionId),
  ]
);

/**
 * Subscription transactions table
 * @summary Track subscription-related credit allocations separately from regular transactions
 *
 * Provider invoice/event IDs are gateway-agnostic; uniqueness is scoped by gateway.
 *
 * @example
 * {
 *   "id": "subtxn123",
 *   "subscription_id": "sub456",
 *   "user_id": "user789",
 *   "type": "activation",
 *   "credits_allocated": 50,
 *   "gateway": "stripe",
 *   "provider_invoice_id": "in_1234567890",
 *   "provider_event_id": "evt_1234567890",
 *   "created_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const subscriptionTransactions = pgTable(
  "subscription_transactions",
  {
    id: id(),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, { onDelete: "cascade" }).notNull(),
    userId: userId().references(() => users.userId, { onDelete: "cascade" }).notNull(),
    type: text("type").$type<SubscriptionTransactionType>().notNull(),
    creditsAllocated: integer("credits_allocated").notNull(),
    /** Payment gateway for this allocation */
    gateway: text("gateway").$type<PaymentGateway>().notNull().default(PAYMENT_GATEWAY.stripe),
    /** Gateway invoice/cycle ID (Stripe `in_xxx`, Xendit cycle/invoice ID) */
    providerInvoiceId: text("provider_invoice_id"),
    /** Gateway webhook event ID — write on create/renew for idempotency */
    providerEventId: text("provider_event_id"),
    // Free-form context for rows that aren't credit allocations, e.g. 'trial_expired'
    // snapshots the user's credit balance at the moment a trial ends without
    // converting (creditsRemainingAtCancellation) — see VIP_FREE_TRIAL_ROADMAP.md Q4.
    metadata: jsonb("metadata"),
    createdAt,
  },
  (t) => [
    index("subscription_transactions_subscription_idx").on(t.subscriptionId),
    index("subscription_transactions_user_idx").on(t.userId),
    index("subscription_transactions_type_idx").on(t.type),
    unique("sub_tx_provider_invoice_unique").on(t.gateway, t.providerInvoiceId),
    unique("sub_tx_provider_event_unique").on(t.gateway, t.providerEventId),
  ]
);

/**
 * Story prompts cache table
 * @summary Cache AI-generated story themes for reuse across users
 * 
 * This table stores pre-generated story prompts to reduce AI generation costs.
 * Prompts are served randomly to users while tracking their viewing history
 * to ensure freshness (users don't see the same prompt twice).
 * 
 * Features:
 * - Quality scoring for prompt validation
 * - Usage tracking for rotation
 * - Expiration-based freshness
 * - User-specific freshness via history tracking
 * 
 * @example
 * {
 *   "id": "prompt123",
 *   "content": "A psychological thriller about a disgraced investigative journalist who returns to her childhood hometown...",
 *   "ai_provider": "gemini",
 *   "ai_model": "gemini-2.5-flash",
 *   "quality_score": 0.95,
 *   "usage_count": 25,
 *   "unique_user_count": 20,
 *   "is_active": true,
 *   "expires_at": "2026-08-25T00:00:00.000Z",
 *   "last_served_at": "2026-05-25T10:30:00.000Z",
 *   "created_at": "2026-05-25T00:00:00.000Z",
 *   "updated_at": "2026-05-25T10:30:00.000Z"
 * }
 */
export const storyPrompts = pgTable(
  "story_prompts",
  {
    id: id(),
    /** Full generated prompt text (stored atomically as creative text) */
    content: text("content").notNull(),
    /** AI provider used for generation */
    aiProvider: text("ai_provider").$type<AIChatProvider | 'none'>(),
    /** AI model used for generation */
    aiModel: text("ai_model"),
    /** Quality score (0-1) based on validation */
    qualityScore: real("quality_score").default(1.0),
    /** Number of times this prompt has been served */
    usageCount: integer("usage_count").notNull().default(0),
    /** Number of unique users who have seen this prompt */
    uniqueUserCount: integer("unique_user_count").notNull().default(0),
    /** Initiator user id (who requested / generated this prompt) */
    userId: uuid("user_id").references(() => users.userId, { onDelete: "set null" }),
    /** Language code for which this prompt was generated (e.g. 'en') */
    language: text("language").notNull().default('en'),
    /** Whether this prompt is currently active for serving */
    isActive: boolean("is_active").notNull().default(true),
    /** Expiration date for freshness rotation */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Last served timestamp */
    lastServedAt: timestamp("last_served_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    // Index for active prompts
    index("story_prompts_active_idx").on(t.isActive).where(sql`${t.isActive} = true`),
    // Index for expiration cleanup
    index("story_prompts_expires_idx").on(t.expiresAt).where(sql`${t.expiresAt} IS NOT NULL`),
    // Index for quality-based selection
    index("story_prompts_quality_idx").on(t.qualityScore.desc()),
    // Index for usage tracking
    index("story_prompts_usage_idx").on(t.usageCount.desc()),
    // Index for freshness (last served)
    index("story_prompts_last_served_idx").on(t.lastServedAt),
    // Index for language filtering
    index("story_prompts_language_idx").on(t.language),
    // Index for initiator lookup
    index("story_prompts_initiator_idx").on(t.userId),
    // GIN index for content search (pg_trgm)
    index("story_prompts_content_gin_idx").using("gin", sql`content gin_trgm_ops`),
  ]
);

/**
 * User prompt history table
 * @summary Track which prompts each user has viewed to ensure freshness
 * 
 * This table tracks the viewing history of prompts per user to ensure
 * users don't see the same prompt twice. It also tracks conversion
 * (whether the user used the prompt to create a book).
 * 
 * @example
 * {
 *   "id": "history123",
 *   "user_id": "user456",
 *   "prompt_id": "prompt789",
 *   "viewed_at": "2026-05-25T10:30:00.000Z",
 *   "used_for_book": true,
 *   "book_id": "book123",
 *   "created_at": "2026-05-25T10:30:00.000Z"
 * }
 */
export const userPromptHistory = pgTable(
  "user_prompt_history",
  {
    id: id(),
    userId: userId().references(() => users.userId, { onDelete: "cascade" }),
    promptId: uuid("prompt_id").notNull().references(() => storyPrompts.id, { onDelete: "cascade" }),
    /** Timestamp when user viewed this prompt */
    viewedAt: timestamp("viewed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Whether user used this prompt to create a book */
    usedForBook: boolean("used_for_book").notNull().default(false),
    /** Book ID if user created a book from this prompt */
    bookId: uuid("book_id").references(() => books.id, { onDelete: "set null" }),
    createdAt,
  },
  (t) => [
    // Unique constraint to prevent duplicate views
    unique("user_prompt_history_user_prompt_unique").on(t.userId, t.promptId),
    // Index for user's prompt history
    index("user_prompt_history_user_idx").on(t.userId, t.viewedAt.desc()),
    // Index for prompt popularity
    index("user_prompt_history_prompt_idx").on(t.promptId),
    // Index for conversion tracking
    index("user_prompt_history_used_idx").on(t.usedForBook),
  ]
);

/**
 * Custom actions table
 * @summary Store custom action validation results for analytics and audit
 *
 * Records every custom action attempt (allow, allow_as_attempt, reject)
 * to support threshold tuning, abuse detection, and telemetry.
 *
 * @example
 * {
 *   "id": "ca123",
 *   "book_id": "book456",
 *   "page_id": "page789",
 *   "user_id": "user012",
 *   "original_text": "I try to pick the lock",
 *   "canonical_intent": "attempt lockpicking escape",
 *   "outcome": "allow",
 *   "plausibility_score": 0.85,
 *   "created_at": "2026-06-22T00:00:00.000Z"
 * }
 */
export const customActions = pgTable(
  "custom_actions",
  {
    id: id(),
    bookId: bookId("cascade"),
    pageId: pageId("cascade"),
    userId: userId().references(() => users.userId, { onDelete: "cascade" }),

    originalText: text("original_text").notNull(),
    canonicalIntent: text("canonical_intent"),
    actionType: text("action_type"),
    hintType: text("hint_type"),

    outcome: text("outcome").$type<CustomActionOutcome>().notNull(),
    rejectionCategory: text("rejection_category").$type<CustomActionRejectionCategory>(),
    plausibilityScore: real("plausibility_score"),
    progressionScore: real("progression_score"),

    creditsCharged: integer("credits_charged").default(0).notNull(),
    nextPageId: uuid("next_page_id"), // generated destination page ID
    language: text("language"), // populated by Gate 2 AI validator — ISO 639-1 code

    createdAt,
    updatedAt,
  },
  (t) => [
    index("custom_actions_book_idx").on(t.bookId),
    index("custom_actions_user_idx").on(t.userId),
    index("custom_actions_outcome_idx").on(t.outcome),
  ]
);

/**
 * Canon validations audit table (roadmap 1.1)
 * @summary Generation-time continuity check outcomes, beside pages/storyStates
 * @example
 * {
 *   "id": "cv123",
 *   "book_id": "book456",
 *   "page_id": "page789",
 *   "outcome": "revised",
 *   "violation_type": "established_fact",
 *   "description": "Page claimed the locket was gold; fact says silver",
 *   "severity_score": 0.72,
 *   "was_revised": true,
 *   "rewrite_attempts": 0,
 *   "created_at": "2026-07-24T00:00:00.000Z"
 * }
 */
export const canonValidations = pgTable(
  "canon_validations",
  {
    id: id(),
    bookId: bookId("cascade"),
    pageId: pageId("cascade"),

    outcome: text("outcome").$type<CanonValidationOutcome>().notNull(),
    violationType: text("violation_type").$type<CanonViolationType>(),
    description: text("description").notNull().default(""),
    severityScore: real("severity_score"),
    violations: jsonb("violations").$type<CanonViolation[]>().notNull().default(sql`'[]'::jsonb`),
    wasRevised: boolean("was_revised").notNull().default(false),
    rewriteAttempts: integer("rewrite_attempts").notNull().default(0),

    createdAt,
  },
  (t) => [
    index("canon_validations_book_idx").on(t.bookId),
    index("canon_validations_page_idx").on(t.pageId),
    index("canon_validations_outcome_idx").on(t.outcome),
  ]
);

/**
 * Uploaded images table
 * @summary Store user-uploaded ImageKit files for cover art and main character assets
 * @example
 * {
 *   "id": "upload123",
 *   "user_id": "user456",
 *   "image_id": "ik_abc123",
 *   "image_url": "https://ik.imagekit.io/your_path/image.png",
 *   "type": "cover",
 *   "created_at": "2026-06-24T00:00:00.000Z",
 *   "updated_at": "2026-06-24T00:00:00.000Z"
 * }
 */
export const uploadedImages = pgTable(
  "uploaded_images",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.userId, { onDelete: "set null" }), // orphaned images kept when user is deleted (images scheduled for deletion via cron)
    imageId: text("image_id").notNull(), // ImageKit file ID for deletion
    imageUrl: text("image_url").notNull(), // ImageKit URL
    type: text("type").$type<UploadedImageType>().notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    index("uploaded_images_user_idx").on(t.userId),
    index("uploaded_images_type_idx").on(t.type),
    unique("uploaded_images_image_id_unique").on(t.imageId),
  ]
);

/**
 * User feedbacks table
 * @summary Store user feedback submissions with optional screenshot attachments
 * @example
 * {
 *   "id": "fb123",
 *   "user_id": "user456",
 *   "category": "bug_report",
 *   "message": "The app crashes when I open the book",
 *   "image_id": "ik_abc123",
 *   "status": "success",
 *   "created_at": "2026-07-10T00:00:00.000Z",
 *   "updated_at": "2026-07-10T00:00:00.000Z"
 * }
 */
export const userFeedbacks = pgTable(
  "user_feedbacks",
  {
    id: id(),
    userId: userId().references(() => users.userId, { onDelete: "cascade" }),
    category: text("category").$type<FeedbackCategory>().notNull(),
    message: text("message").notNull(),
    imageId: text("image_id"), // ImageKit file ID (optional feedback screenshot)
    imageUrl: text("image_url"), // ImageKit URL (optional feedback screenshot)
    status: text("status").$type<FeedbackStatus>().notNull().default('idle'),
    /** Admin inbox resolution — independent of user submission `status`. */
    adminStatus: text("admin_status").$type<FeedbackAdminStatus>().notNull().default('unread'),
    createdAt,
    updatedAt,
  },
  (t) => [
    index("user_feedbacks_user_idx").on(t.userId),
    index("user_feedbacks_category_idx").on(t.category),
    index("user_feedbacks_created_idx").on(t.createdAt.desc()),
    index("user_feedbacks_admin_status_idx").on(t.adminStatus),
  ]
);

// ============================================================================
// PGVECTOR SEMANTIC MEMORY (Phase 1)
// ============================================================================
// Jina AI (jina-embeddings-v5-text-small) embeddings for semantic retrieval,
// layered alongside — not replacing — the structured StoryState memory above.
// See PGVECTOR_SEMANTIC_MEMORY_ROADMAP.md for the full design rationale and
// fact-check history behind every decision below.
//
// All four tables share one shape: `pageId` is a real FK (cascade delete —
// prune a page, its embeddings go with it) used purely for referential
// integrity; `page` (the plain page NUMBER) is kept alongside it because
// every retrieval query needs cheap numeric range filtering (`page < N` —
// "give me things from before the current page"), and joining through
// `pageId` just to get that number on every query would be needless
// overhead on the hot path. `bookId`/`branchId` are denormalized for the
// same reason: every query filters by both directly, no join required.
//
// `branchId` is defined fresh per table below rather than reusing the
// module-level `branchId` const from the `pages` table (line 33) — sharing
// one Drizzle column-builder instance across multiple pgTable() calls isn't
// guaranteed side-effect-free, so each table gets its own instance.
//
// Embedding inserts happen fire-and-forget, from the page-generation caller
// (generateNextPage/generateNextPages) reading off that page's own
// PersistedStoryPage + StateDelta, AFTER persistPageWithState succeeds —
// never from inside applyStateDelta or the processXxx helpers it calls,
// since those run identically during live generation AND during
// delta-chain replay (confirmed against utils/story.ts/branch-traversal.ts
// — see roadmap §12 / Appendix D.3).

/**
 * Page embeddings table
 * @summary Semantic embeddings for story page text (text + key events + mood),
 * retrieved to supplement contextHistory's lossy 300-word running summary
 * with pages that are semantically — not just chronologically — relevant to
 * the current scene. One row per page; pageId is unique.
 * @example
 * {
 *   "id": "emb123",
 *   "page_id": "page456",
 *   "book_id": "book789",
 *   "branch_id": "main",
 *   "page": 18,
 *   "source_text": "Page 18:\nScene: You found an old brass key...\nMood: eerie\nKey events: found key, heard voice",
 *   "created_at": "2026-07-11T00:00:00.000Z"
 * }
 */
export const pageEmbeddings = pgTable(
  "page_embeddings",
  {
    id: id(),
    pageId: pageId("cascade"),
    bookId: bookId("cascade"),
    branchId: text("branch_id").notNull().default("main"),
    page: integer("page").notNull(),
    // jina-embeddings-v5-text-small, 1024 dims, unit-normalized server-side
    // ("normalized": true — see utils/embedding.ts). Must match
    // EMBEDDING_DIMENSIONS in config/embedding.ts.
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    sourceText: text("source_text"),
    createdAt,
  },
  (t) => [
    index("page_embeddings_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("page_embeddings_book_branch_idx").on(t.bookId, t.branchId),
    unique("page_embeddings_page_unique").on(t.pageId),
  ]
);

/**
 * Character embeddings table
 * @summary Semantic embeddings for character interactions (CharacterMemory.
 * pastInteractions), embedded once per (pageId, characterId) at the moment
 * they're added — before updateCharacter()'s `.slice(-MAX_PAST_INTERACTIONS)`
 * (cap 5) can trim them away. sourceText joins same-page interactions,
 * mirroring how formatCharactersForPrompt() already groups them for display.
 * Retrieved only to surface interactions older than what's currently visible
 * in the live sliding window — never duplicates what's already shown in full.
 * @example
 * {
 *   "id": "emb123",
 *   "page_id": "page456",
 *   "book_id": "book789",
 *   "branch_id": "main",
 *   "page": 12,
 *   "character_id": "char_emma",
 *   "source_text": "Emma admitted she'd been in the chapel before, years ago.",
 *   "created_at": "2026-07-11T00:00:00.000Z"
 * }
 */
export const characterEmbeddings = pgTable(
  "character_embeddings",
  {
    id: id(),
    pageId: pageId("cascade"),
    bookId: bookId("cascade"),
    branchId: text("branch_id").notNull().default("main"),
    page: integer("page").notNull(),
    characterId: text("character_id").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    sourceText: text("source_text"),
    createdAt,
  },
  (t) => [
    index("character_embeddings_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("character_embeddings_book_char_idx").on(t.bookId, t.characterId),
    unique("character_embeddings_unique").on(t.pageId, t.characterId),
  ]
);

/**
 * Place embeddings table
 * @summary Semantic embeddings for place key events (PlaceMemory.keyEvents) —
 * same pattern as character_embeddings. Embedded once per (pageId, placeId)
 * at add-time, before updatePlace()'s `.slice(-MAX_PLACE_EVENTS)` (cap 8) can
 * trim them away. Does NOT feed calculatePlaceFamiliarity() — that stays
 * deterministic and synchronous exactly as designed; this table is purely
 * additive, for recalling events that have scrolled out of the live
 * keyEvents window.
 * @example
 * {
 *   "id": "emb123",
 *   "page_id": "page456",
 *   "book_id": "book789",
 *   "branch_id": "main",
 *   "page": 8,
 *   "place_id": "place_chapel",
 *   "source_text": "Father Gabriel warned you never to enter the underground chapel.",
 *   "created_at": "2026-07-11T00:00:00.000Z"
 * }
 */
export const placeEmbeddings = pgTable(
  "place_embeddings",
  {
    id: id(),
    pageId: pageId("cascade"),
    bookId: bookId("cascade"),
    branchId: text("branch_id").notNull().default("main"),
    page: integer("page").notNull(),
    placeId: text("place_id").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    sourceText: text("source_text"),
    createdAt,
  },
  (t) => [
    index("place_embeddings_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("place_embeddings_book_place_idx").on(t.bookId, t.placeId),
    unique("place_embeddings_unique").on(t.pageId, t.placeId),
  ]
);

/**
 * Future note embeddings table
 * @summary Semantic embeddings for future notes, keyed by the note's own stable
 * `key` (NOT array position — array indices shift on removal via futureNoteRemove
 * and would silently misattribute embeddings to the wrong note).
 * Embedded once on note creation; re-embedded only if futureNoteAdd reports
 * a text change — never re-embedded just because it appears in a later page's
 * state snapshot.
 * 
 * @example
 * {
 *   "id": "emb123",
 *   "page_id": "page456",
 *   "book_id": "book789",
 *   "branch_id": "main",
 *   "note_key": "chapel_secret",
 *   "source_text": "The chapel basement hides something Emma has never spoken of.",
 *   "created_at": "2026-07-11T00:00:00.000Z"
 * }
 */
export const futureNoteEmbeddings = pgTable(
  "future_note_embeddings",
  {
    id: id(),
    pageId: pageId("cascade"),
    bookId: bookId("cascade"),
    branchId: text("branch_id").notNull().default("main"),
    noteKey: text("note_key").notNull(), // FutureNote.key — stable identifier
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    sourceText: text("source_text"),
    createdAt,
  },
  (t) => [
    index("future_note_embeddings_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    unique("future_note_embeddings_unique").on(t.bookId, t.branchId, t.noteKey),
  ]
);

/**
 * Clue embeddings table
 * @summary Semantic embeddings for thread clues (StoryThread.clues), embedded
 * once per (pageId, threadId) at the moment they're added — via either
 * newThreads[].clues (bundled at thread creation) or
 * addClues[] (added to an existing thread later). Unlike
 * pastInteractions/keyEvents, StoryThread.clues is never trimmed at storage
 * time (processThreadUpdates just .push()es) — the trim happens at DISPLAY
 * time instead (formatActiveThreads shows only the last MAX_THREADS_CLUES).
 * Functionally the same problem as character/place embeddings though: clues
 * older than what's currently displayed are invisible to the AI unless
 * recalled here.
 * 
 * @example
 * {
 *   "id": "emb123",
 *   "page_id": "page456",
 *   "book_id": "book789",
 *   "branch_id": "main",
 *   "page": 22,
 *   "thread_id": "thread_missing_diary",
 *   "source_text": "The diary's last entry mentions a name that isn't in any school record.",
 *   "created_at": "2026-07-14T00:00:00.000Z"
 * }
 */
export const clueEmbeddings = pgTable(
  "clue_embeddings",
  {
    id: id(),
    pageId: pageId("cascade"),
    bookId: bookId("cascade"),
    branchId: text("branch_id").notNull().default("main"),
    page: integer("page").notNull(),
    threadId: text("thread_id").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    sourceText: text("source_text"),
    createdAt,
  },
  (t) => [
    index("clue_embeddings_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("clue_embeddings_book_thread_idx").on(t.bookId, t.threadId),
    unique("clue_embeddings_unique").on(t.pageId, t.threadId),
  ]
);

/**
 * Social Mentions Table
 * @summary Stores automatically collected community commentary, reviews, and platform mentions.
 * @description Serves as an inbound queue for community social proof. Items are ingested as 'pending'
 * and calculated with localized heuristic scores to prioritize administrative approval.
 *
 * Optional product linkage (`relatedBookId`) is best-effort filled by cron when a post
 * contains a Twistloom `/books/...` URL, and completed/overridden by admins. Public wall
 * CTAs only surface when the linked book is still public+active.
 */
export const socialMentions = pgTable(
  "social_mentions",
  {
    id: id(),
    platform: text("platform").notNull(), // 'reddit', 'hackernews', 'brave_search', etc.
    author: text("author").notNull(),
    authorAvatar: text("author_avatar"),
    title: text("title"),
    content: text("content").notNull(),
    url: text("url").notNull(),
    score: integer("score").default(0).notNull(), // Platform engagement metrics (upvotes/likes)
    sentimentScore: real("sentiment_score").default(0).notNull(), // Local evaluation: -1.0 to 1.0
    relevanceScore: real("relevance_score").default(0).notNull(), // Computed routing prioritization score
    status: text("status").$type<'pending' | 'approved' | 'rejected'>().default('pending').notNull(),
    featured: boolean("featured").default(false).notNull(), // Explicitly elevated to the public homepage wall by an admin
    /** Optional public book linked for homepage "Read the story" CTAs */
    relatedBookId: uuid("related_book_id").references(() => books.id, { onDelete: "set null" }),
    /** Optional page (e.g. share ending); Read CTA still defaults to book landing unless admin promotes */
    relatedPageId: uuid("related_page_id").references(() => pages.id, { onDelete: "set null" }),
    /** Who set relatedBookId: cron auto-extract vs admin override (admin is sticky) */
    relatedBookSource: text("related_book_source").$type<'auto' | 'admin'>(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    // Unique structural constraint ensuring an absolute lack of duplicate URLs across individual runs
    unique("social_mentions_url_unique").on(t.url),
    // Performance indexes for the eventual admin queue display
    index("social_mentions_status_idx").on(t.status),
    index("social_mentions_platform_idx").on(t.platform),
    // Composite index optimizing curation queues by processing the high-quality items first
    index("social_mentions_filtering_idx").on(t.status, t.relevanceScore.desc()),
    // Index for the public homepage wall (only featured mentions are shown)
    index("social_mentions_featured_idx").on(t.featured, t.relevanceScore.desc()),
    // Admin queue: filter linked / unlinked mentions
    index("social_mentions_related_book_idx").on(t.relatedBookId),
  ]
);

/**
 * User-submitted book testimonials table
 * @summary Stores testimonials that readers optionally submit after finishing a book.
 *
 * This is a dedicated stream separate from `socialMentions` (which holds externally
 * scraped posts). Keeping it separate preserves a clean separation of concerns:
 * `socialMentions` models third-party platform posts (URL, public handle, vote
 * score), whereas testimonials are first-party user-generated content tied to an
 * internal `userId` and an optional star rating.
 *
 * Both tables share the same curation lifecycle (`pending` → `approved` →
 * `featured`), so the public homepage wall can union them after admin review.
 *
 * @example
 * {
 *   "id": "0194f2d1-...",
 *   "user_id": "user-uuid",
 *   "book_id": "book-uuid",
 *   "rating": 5,
 *   "content": "Twistloom generated an ending I genuinely didn't expect.",
 *   "status": "pending",
 *   "featured": false,
 *   "created_at": "2026-07-19T06:00:00.000Z",
 *   "updated_at": "2026-07-19T06:00:00.000Z"
 * }
 */
export const bookTestimonials = pgTable(
  "book_testimonials",
  {
    id: id(),
    userId: userId().references(() => users.userId, { onDelete: "cascade" }),
    bookId: bookId("cascade"),
    rating: integer("rating"),
    content: text("content").notNull(),
    status: text("status").$type<'pending' | 'approved' | 'rejected'>().default('pending').notNull(),
    featured: boolean("featured").default(false).notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    index("book_testimonials_status_idx").on(t.status),
    index("book_testimonials_featured_idx").on(t.featured, t.createdAt.desc()),
    index("book_testimonials_book_idx").on(t.bookId, t.status),
    index("book_testimonials_user_idx").on(t.userId, t.createdAt.desc()),
  ]
);

export const adminUsers = pgTable(
  "admin_users",
  {
    userId: text("user_id").primaryKey(),
    email: text("email"),
    invitedBy: text("invited_by"),
    /**
     * Capability keys (e.g. blog, social_mentions). Empty = no section powers.
     * Super admin (SYSTEM_USER_ID) ignores this and has all capabilities.
     */
    permissions: text("permissions").array().notNull().default([]),
    createdAt,
  }
);

/**
 * User reports — moderation inbox for reported user profiles.
 *
 * Mirrors the `user_feedbacks` / `book_testimonials` curation model: a public
 * reporter submits a report which lands in an admin queue with a resolution
 * status. Rate-limited at the route layer.
 *
 * @example
 * {
 *   "id": "0194f2d1-...",
 *   "reporter_id": "user-uuid",
 *   "reported_user_id": "user-uuid",
 *   "report_type": "harassment",
 *   "message": "Repeatedly spamming my comment threads.",
 *   "status": "open",
 *   "created_at": "2026-08-01T10:00:00.000Z"
 * }
 */
export const userReports = pgTable(
  "user_reports",
  {
    id: id(),
    reporterId: userId().references(() => users.userId, { onDelete: "cascade" }),
    reportedUserId: uuid("reported_user_id").notNull().references(() => users.userId, { onDelete: "cascade" }),
    reportType: text("report_type").$type<'spam' | 'harassment' | 'impersonation' | 'inappropriate' | 'other'>().notNull(),
    message: text("message"),
    status: text("status").$type<'open' | 'under_review' | 'resolved' | 'dismissed'>().notNull().default('open'),
    createdAt,
    updatedAt,
  },
  (t) => [
    index("user_reports_status_idx").on(t.status),
    index("user_reports_target_idx").on(t.reportedUserId),
    index("user_reports_reporter_idx").on(t.reporterId),
    index("user_reports_created_idx").on(t.createdAt.desc()),
  ]
);

/**
 * Page reactions table
 * @summary Anonymous per-page emoji reactions (one active reaction per user per page).
 *
 * The `UNIQUE (page_id, user_id)` constraint enforces the "one active reaction per
 * user per page" invariant at the database level. A "swap" is a single transaction
 * that deletes the prior row for the same user+page and inserts the new emoji, so a
 * user can never be counted on two emojis for the same page simultaneously.
 * Counts are computed at read time via `COUNT` over the `(page_id, emoji)` index —
 * no denormalized counter table in v1.
 *
 * `emoji` stores the stable string id (e.g. `'shocked'`, `'loved'`), NOT the display
 * glyph. The glyph is a pure frontend concern keyed by that id, so the set can be
 * re-skinned without a migration.
 *
 * @example
 * {
 *   "id": "0194f2d1-...",
 *   "book_id": "book456",
 *   "page_id": "page789",
 *   "user_id": "user789",
 *   "emoji": "shocked",
 *   "created_at": "2026-01-01T00:00:00.000Z",
 *   "updated_at": "2026-01-01T00:00:00.000Z"
 * }
 */
export const pageReactions = pgTable(
  "page_reactions",
  {
    id: id(),
    bookId: bookId("cascade"), // Delete if book is deleted
    pageId: pageId("cascade"), // Delete if page is deleted
    userId: userId().references(() => users.userId, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(), // Whitelisted stable reaction id (NOT the display glyph)
    createdAt,
    updatedAt,
  },
  (t) => [
    // One active reaction per user per page — enforces swap semantics at the DB layer
    unique("page_reactions_user_page_unique").on(t.userId, t.pageId),
    // Fast count reads per page + emoji (the hot read path)
    index("page_reactions_page_emoji_idx").on(t.pageId, t.emoji),
    // Per-book aggregates (e.g. future "most shocking pages" analytics)
    index("page_reactions_book_idx").on(t.bookId),
    // User's own reactions (used to find the user's active row for swap/remove)
    index("page_reactions_user_idx").on(t.userId),
  ]
);

/**
 * User blocks — content gating between two users.
 *
 * When user A blocks user B: A cannot see B's public profile content, B's
 * follows/comments/likes toward A are suppressed, and the block is enforced at
 * the route/service layer (see block gating). Composite PK prevents duplicates.
 *
 * @example
 * {
 *   "user_id": "blocker-uuid",
 *   "blocked_user_id": "blocked-uuid",
 *   "created_at": "2026-08-01T10:00:00.000Z"
 * }
 */
export const userBlocks = pgTable(
  "user_blocks",
  {
    userId: userId().references(() => users.userId, { onDelete: "cascade" }),
    blockedUserId: uuid("blocked_user_id").notNull().references(() => users.userId, { onDelete: "cascade" }),
    createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.blockedUserId] }),
    index("user_blocks_target_idx").on(t.blockedUserId),
  ]
);

/**
 * Portal community blog posts (CMS).
 * Source of truth for portal.twistloom.com/blog — managed via /api/admin/blog-posts.
 * Body is sanitized HTML from TipTap (not Markdown). Public: GET /api/blog/posts.
 */
export const portalBlogPosts = pgTable(
  "portal_blog_posts",
  {
    id: id(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    excerpt: text("excerpt"),
    /** Sanitized HTML from admin TipTap editor (SSOT for body content). */
    bodyHtml: text("body_html").notNull(),
    coverUrl: text("cover_url"),
    authorName: text("author_name"),
    authorId: uuid("author_id").references(() => users.userId, { onDelete: "set null" }),
    status: text("status").$type<"draft" | "published" | "archived">().default("draft").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    unique("portal_blog_posts_slug_unique").on(t.slug),
    index("portal_blog_posts_status_idx").on(t.status),
    index("portal_blog_posts_published_idx").on(t.status, t.publishedAt.desc()),
  ]
);