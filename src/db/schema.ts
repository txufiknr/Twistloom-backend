import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, real, jsonb, uuid, index, primaryKey, integer, unique, type UpdateDeleteAction, boolean } from "drizzle-orm/pg-core";
import type { Gender } from "../types/user.js";
import type { LikeTargetType } from "../types/user.js";
import type { StoryMC } from "../types/character.js";
import type { BookStatus } from "../types/book.js";
import type { SessionStatus } from "../types/session.js";
import type { AIChatProvider } from "../types/ai-chat.js";
import type { 
  PsychologicalProfile, 
  PsychologicalFlags,
  HiddenState,
  MemoryIntegrity,
  Difficulty,
  Action,
  ActionedStoryPage,
  StateDelta,
  StoryState,
  Ending,
  StoryStateSnapshotReason,
} from "../types/story.js";
import type { CharacterMemory, CharacterUpdates } from "../types/character.js";
import type { PlaceMemory, PlaceUpdates } from "../types/places.js";
import { generateId } from "../utils/uuid.js";
import { DEFAULT_BOOK_MAX_PAGES } from "../config/story.js";

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
    page: integer("page").notNull(),
    text: text("text").notNull(), // 60 words max, first-person POV
    mood: text("mood"), // Current emotional atmosphere
    place: text("place"), // Current place where the story is taking place
    timeOfDay: text("time_of_day"),
    charactersPresent: jsonb("characters").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // Characters present in the page
    keyEvents: jsonb("key_events").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // Key events that occurred in the page
    importantObjects: jsonb("important_objects").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // Important objects mentioned in the page
    actions: jsonb("actions").$type<Action[]>().notNull().default(sql`'[]'::jsonb`), // 2-3 branching actions
    addTraumaTag: text("add_trauma_tag"), // New trauma tag
    characterUpdates: jsonb("character_updates").$type<CharacterUpdates | null>(),
    placeUpdates: jsonb("place_updates").$type<PlaceUpdates | null>(), // PlaceUpdates structure
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
  ]
);

// /**
//  * Create characters table
//  * @summary Store character memory with relationships and narrative flags
//  * @example
//  * {
//  *   "id": "char123",
//  *   "book_id": "book456",
//  *   "name": "Lina",
//  *   "role": "best friend",
//  *   "bio": "Cheerful but secretive",
//  *   "status": "trusting",
//  *   "relationship_to_mc": "Close childhood friend",
//  *   "relationships": [...],
//  *   "past_interactions": [...],
//  *   "last_interaction_at_page": 3,
//  *   "narrative_flags": {...},
//  *   "places": [...],
//  *   "created_at": "2023-01-01T00:00:00.000Z"
//  * }
//  */
// export const characters = pgTable(
//   "characters",
//   {
//     id: uuid("id").primaryKey(),
//     bookId: bookId("cascade"), // Delete if book is deleted
//     name: text("name").notNull(),
//     gender,
//     role: text("role").notNull(),
//     bio: text("bio").notNull(),

//     // status: text("status").notNull(), // CharacterStatus enum
//     // relationshipToMC: text("relationship_to_mc").notNull(),
//     // relationships: jsonb("relationships").$type<any[]>().notNull().default(sql`'[]'::jsonb`), // CharacterRelationship[] structure
//     // pastInteractions: jsonb("past_interactions").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // Sliding window (max 5)
//     // lastInteractionAtPage: integer("last_interaction_at_page").notNull(),
//     // narrativeFlags: jsonb("narrative_flags").$type<any>().notNull(), // NarrativeFlags structure
//     // places: jsonb("places").$type<any[]>().notNull().default(sql`'[]'::jsonb`), // CharacterPlaceRelation[] structure

//     createdAt,
//     updatedAt,
//   },
//   (t) => [
//     // Index for book queries
//     index("characters_book_idx").on(t.bookId),
//     // Index for character name lookup
//     index("characters_name_idx").on(t.name),
//     // // Index for status filtering
//     // index("characters_status_idx").on(t.status),
//     // // Index for recent interactions
//     // index("characters_interaction_idx").on(t.lastInteractionAtPage.desc()),
//     // Index for gender-based filtering
//     index("characters_gender_idx").on(t.gender),
//     // Unique constraint on (bookId, name) to ensure character names are unique per book
//     unique("characters_book_name_unique").on(t.bookId, t.name),
//   ]
// );

// /**
//  * Create places table
//  * @summary Store place memory with visit history and emotional associations
//  * @example
//  * {
//  *   "id": "place123",
//  *   "book_id": "book456",
//  *   "name": "Old River",
//  *   "type": "river",
//  *   "context": "Narrow river behind school",
//  *   "location_hint": "Behind school, flows toward town",
//  *   "visit_count": 3,
//  *   "last_visited_at_page": 8,
//  *   "familiarity": 0.4,
//  *   "mood_history": ["eerie", "threatening"],
//  *   "event_tags": ["betrayal", "discovery"],
//  *   "known_characters": ["Lina", "MC"],
//  *   "sensory_details": {...},
//  *   "current_mood": "threatening",
//  *   "created_at": "2023-01-01T00:00:00.000Z"
//  * }
//  */
// export const places = pgTable(
//   "places",
//   {
//     id: id(),
//     bookId: bookId("cascade"), // Delete if book is deleted
//     name: text("name").notNull(),
//     type: text("type").notNull(), // PlaceType enum
//     context: text("context").notNull(), // 1-sentence description
//     locationHint: text("location_hint"), // Optional spatial relationship

//     // visitCount: integer("visit_count").notNull().default(1),
//     // lastVisitedAtPage: integer("last_visited_at_page").notNull(),
//     // familiarity: real("familiarity").notNull().default(0.1), // 0-1 scale
//     // moodHistory: jsonb("mood_history").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // PlaceMood[] sliding window
//     // eventTags: jsonb("event_tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // ["betrayal", "discovery", etc.]
//     // knownCharacters: jsonb("known_characters").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // Character names encountered
//     // sensoryDetails: jsonb("sensory_details").$type<any>(), // SensoryDetails structure
//     // currentMood: text("current_mood").notNull(), // PlaceMood enum

//     createdAt,
//     updatedAt,
//   },
//   (t) => [
//     // Index for book queries
//     index("places_book_idx").on(t.bookId),
//     // Index for place name lookup
//     index("places_name_idx").on(t.name),
//     // Index for place type filtering
//     index("places_type_idx").on(t.type),
//     // Unique constraint on (bookId, name) to ensure place names are unique per book
//     unique("places_book_name_unique").on(t.bookId, t.name),
//     // // Index for familiarity sorting
//     // index("places_familiarity_idx").on(t.familiarity.desc()),
//     // // Index for recent visits
//     // index("places_recent_visit_idx").on(t.lastVisitedAtPage.desc()),
//   ]
// );

/**
 * Create story state table
 * @summary Store complete story progression and psychological state
 * @example
 * {
 *   "id": "state123",
 *   "book_id": "book456",
 *   "page": 5,
 *   "max_page": 20,
 *   "actions_history": ["investigate noise", "run away", "call for help"],
 *   "flags": {...},
 *   "trauma_tags": [...],
 *   "psychological_profile": {...},
 *   "hidden_state": {...},
 *   "memory_integrity": "fragmented",
 *   "difficulty": "medium",
 *   "cached_ending_archetype": "false_reality",
 *   "page_history": [...],
 *   "context_history": "...",
 *   "created_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const storyStates = pgTable(
  "story_states",
  {
    userId: userId(), // Initiator
    pageId: pageId("cascade"), // Delete if page is deleted
    bookId: bookId("cascade"), // Delete if book is deleted
    page: integer("page").notNull(),
    maxPage: integer("max_page").notNull(),
    flags: jsonb("flags").$type<PsychologicalFlags>().notNull(), // Psychological flags structure
    traumaTags: jsonb("trauma_tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // Sliding window (MAX_TRAUMA_TAGS)
    psychologicalProfile: jsonb("psychological_profile").$type<PsychologicalProfile>().notNull(), // PsychologicalProfile structure
    hiddenState: jsonb("hidden_state").$type<HiddenState>().notNull(), // Hidden narrative state structure
    memoryIntegrity: text("memory_integrity").$type<MemoryIntegrity>().notNull().default("stable"), // "stable" | "fragmented" | "corrupted"
    difficulty: text("difficulty").$type<Difficulty>().notNull().default("low"), // "low" | "medium" | "high" | "nightmare"
    viableEnding: text("ending").$type<Ending>(),
    characters: jsonb("characters").$type<Record<string, CharacterMemory>>().notNull().default(sql`'{}'::jsonb`), // Character records
    places: jsonb("places").$type<Record<string, PlaceMemory>>().notNull().default(sql`'{}'::jsonb`), // Place records
    pageHistory: jsonb("page_history").$type<ActionedStoryPage[]>().notNull().default(sql`'[]'::jsonb`), // Page history with sliding window
    actionsHistory: jsonb("actions_history").$type<Action[]>().notNull().default(sql`'[]'::jsonb`), // History of user actions
    contextHistory: text("context_history").notNull().default(""), // AI-summarized story context from page 1 to current
    createdAt,
    updatedAt,
  },
  (t) => [
    // Composite primary key for unique user+book+page combinations
    primaryKey({ columns: [t.userId, t.bookId, t.pageId] }),
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
 *   "created_at": "2023-01-01T00:00:00.000Z",
 *   "updated_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const users = pgTable(
  "users",
  {
    userId: userId().primaryKey(),
    name: text("name"),
    gender,
    image: text("image"), // Profile image ImageKit URL
    imageId: text("image_id"), // ImageKit file ID for deletion
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
    title: text("title").notNull(),
    totalPages: integer("total_pages").notNull().default(DEFAULT_BOOK_MAX_PAGES),
    language: text("language"),
    hook: text("hook"),
    summary: text("summary"),
    image: text("image"), // Cover image ImageKit URL
    imageId: text("image_id"), // ImageKit file ID for deletion
    trendingScore: real("trending_score").default(0),
    keywords: jsonb("keywords").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // e.g. ['cardiff mosque', 'peel street mosque', 'world war ii', 'muslim community']
    status: text("status").$type<BookStatus | null>().default('active'),
    mc: jsonb("mc").$type<StoryMC>().notNull(), // Main character profile with name, age, gender
    createdAt,
    updatedAt,
  },
  (t) => [
    index("books_trending_score_idx").on(t.trendingScore),
    // Optimize time-window queries
    index("books_recent_idx").on(t.updatedAt),
    // Optimize trending queries with compound ordering
    index("books_trending_idx").on(
      t.status.desc(),
      t.trendingScore.desc(),
      t.updatedAt.desc()
    ),
    // Index for user book queries
    index("books_user_idx").on(t.userId),
    // Index for status filtering
    index("books_status_idx").on(t.status),
    // // Optimize cursor-based pagination (with status filter)
    // index("books_cursor_idx").on(
    //   t.updatedAt.desc(),
    //   t.id.desc()
    // ),
    // // Optimize cursor-based pagination with status
    // index("books_cursor_status_idx").on(
    //   t.status,
    //   t.updatedAt.desc(),
    //   t.id.desc()
    // ),
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
    pageId: uuid("page_id").notNull(),
    action: jsonb("action").$type<Action>().notNull(),
    nextPageId: uuid("next_page_id"), // For tracking pre-generated pages
    createdAt,
    updatedAt,
  },
  (t) => [
    // Unique constraint on (userId, bookId, pageId) to ensure unique progress per branch
    unique("user_page_progress_user_book_page_unique").on(t.userId, t.bookId, t.pageId),
    // Index for user's progress in a book
    index("user_page_progress_user_book_idx").on(t.userId, t.bookId),
    // Index for finding specific page progress
    index("user_page_progress_page_idx").on(t.pageId),
    // Index for action tracking
    // index("user_page_progress_action_gin_idx").using("gin", t.action),
  ]
);

/**
 * Create story state snapshots table
 * @summary Store complete story state checkpoints for efficient reconstruction
 * @example
 * {
 *   "id": "snapshot123",
 *   "user_id": "user456",
 *   "book_id": "book789",
 *   "page_id": "page123",
 *   "state": {
 *     "pageId": "page123",
 *     "page": 15,
 *     "maxPage": 150,
 *     "flags": { "trust": "medium", "fear": "high" },
 *     "traumaTags": ["betrayal", "loss"],
 *     "psychologicalProfile": { "archetype": "survivor" },
 *     "hiddenState": { "memoryIntegrity": "fragmented" },
 *     "memoryIntegrity": "stable",
 *     "difficulty": "medium",
 *     "viableEnding": { "text": "...", "type": "false_reality" },
 *     "characters": {},
 *     "places": {},
 *     "pageHistory": [],
 *     "actionsHistory": [],
 *     "contextHistory": "Story context summary..."
 *   },
 *   "created_at": "2023-01-01T00:00:00.000Z",
 *   "version": 1,
 *   "is_major_checkpoint": true,
 *   "reason": "major_event"
 * }
 */
export const storyStateSnapshots = pgTable(
  "story_state_snapshots",
  {
    userId: userId().references(() => users.userId, { onDelete: "set null" }),
    pageId: pageId("cascade"), // Delete if page is deleted
    bookId: bookId("cascade"), // Delete if book is deleted
    state: jsonb("state").$type<StoryState>().notNull(),
    createdAt,
    version: integer("version").default(1).notNull(),
    isMajorCheckpoint: boolean("is_major_checkpoint").default(false).notNull(),
    reason: text("reason").$type<StoryStateSnapshotReason>().notNull(),
    updatedAt,
  },
  (t) => [
    // Composite primary key for unique user+book+page combinations
    primaryKey({ columns: [t.userId, t.bookId, t.pageId] }),
    // Index for user's snapshots in a book
    index("story_state_snapshots_user_book_idx").on(t.userId, t.bookId),
    // Index for finding specific page snapshots
    index("story_state_snapshots_page_idx").on(t.pageId),
    // Index for recent snapshots (for cleanup)
    index("story_state_snapshots_created_idx").on(t.createdAt.desc()),
    // Index for major checkpoints prioritization
    index("story_state_snapshots_major_idx").on(t.isMajorCheckpoint, t.createdAt.desc()),
    // Index for snapshot reason filtering
    index("story_state_snapshots_reason_idx").on(t.reason),
  ]
);

/**
 * Create story state deltas table
 * @summary Store state changes between pages for efficient delta reconstruction
 * @example
 * {
 *   "user_id": "user456",
 *   "book_id": "book789",
 *   "page_id": "page456",
 *   "delta": {
 *     "pageId": "page456",
 *     "fromPage": 14,
 *     "toPage": 15,
 *     "changes": {
 *       "flags": {
 *         "trust": { "from": "high", "to": "medium" },
 *         "fear": { "from": "low", "to": "high" }
 *       },
 *       "traumaTags": {
 *         "added": ["betrayal"],
 *         "removed": []
 *       },
 *       "psychologicalProfile": {
 *         "stabilityLevel": { "from": "stable", "to": "fragile" }
 *       }
 *     },
 *     "timestamp": "2023-01-01T00:00:00.000Z"
 *   },
 *   "created_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const storyStateDeltas = pgTable(
  "story_state_deltas",
  {
    userId: userId().references(() => users.userId, { onDelete: "set null" }),
    pageId: pageId("cascade"), // Delete if page is deleted
    bookId: bookId("cascade"), // Delete if book is deleted
    delta: jsonb("delta").$type<StateDelta>().notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    // Composite primary key for unique user+book+page combinations
    primaryKey({ columns: [t.userId, t.bookId, t.pageId] }),
    // Index for user's deltas in a book
    index("story_state_deltas_user_book_idx").on(t.userId, t.bookId),
    // Index for finding specific page deltas
    index("story_state_deltas_page_idx").on(t.pageId),
    // Index for recent deltas (for cleanup)
    index("story_state_deltas_created_idx").on(t.createdAt.desc()),
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
 * User devices tracking table
 * @summary Track first-seen metadata for user devices (platform, app version)
 * @example
 * {
 *   "user_id": "user123",
 *   "platform": "android",
 *   "app_version": "1.2.3",
 *   "first_seen_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const userDevices = pgTable(
  "user_devices",
  {
    userId: userId(),
    platform: text("platform"), // e.g. "android", "ios"
    appVersion: text("app_version"), // e.g. "1.2.3"
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Composite primary key: one record per user+platform+version combination
    primaryKey({ columns: [t.userId, t.platform, t.appVersion] }),
    
    // Index for analytics queries (find all devices for a user)
    index("user_devices_user_idx").on(t.userId),
    
    // Index for platform analytics
    index("user_devices_platform_idx").on(t.platform),
    
    // Index for version analytics
    index("user_devices_version_idx").on(t.appVersion),
    
    // Index for first-seen date queries
    index("user_devices_first_seen_idx").on(t.firstSeenAt),
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
 * Create user favorites table
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
    previousPageId: uuid("previous_page_id"),
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