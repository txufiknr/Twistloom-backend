import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, real, jsonb, uuid, index, primaryKey, integer, unique, boolean, UpdateDeleteAction } from "drizzle-orm/pg-core";
import type { Gender, KnownGender } from "../types/user.js";
import type { StoryMC } from "../types/character.js";
import type { BookStatus } from "../types/book.js";
import type { SessionStatus } from "../types/session.js";
import type { AIChatProvider } from "../types/ai-chat.js";
import type { 
  StoryPage, 
  StoryState, 
  PsychologicalProfile, 
  Archetype, 
  StabilityLevel, 
  ManipulationAffinity, 
  Ending,
  PsychologicalFlags,
  HiddenState,
  MemoryIntegrity,
  Difficulty,
  Action
} from "../types/story.js";
import type { CharacterMemory, CharacterUpdate, CharacterUpdates, RelationshipUpdate } from "../types/character.js";
import type { PlaceMemory, PlaceUpdate, PlaceUpdates } from "../types/places.js";
import { generateId } from "../utils/uuid.js";

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
    bookId: bookId("cascade"), // Delete if book is deleted
    page: integer("page").notNull(),
    text: text("text").notNull(), // 60 words max, first-person POV
    mood: text("mood").notNull(), // Current emotional atmosphere
    place: text("place").notNull(), // Current place where the story is taking place
    characters: jsonb("characters").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // Characters present in the page
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
    // Index for mood-based queries
    index("pages_mood_idx").on(t.mood),
    // Index for book ordering
    index("pages_book_order_idx").on(t.bookId, t.page.desc()),
    // Index for creation time
    index("pages_created_at_idx").on(t.createdAt),
  ]
);

/**
 * Create characters table
 * @summary Store character memory with relationships and narrative flags
 * @example
 * {
 *   "id": "char123",
 *   "book_id": "book456",
 *   "name": "Lina",
 *   "role": "best friend",
 *   "bio": "Cheerful but secretive",
 *   "status": "trusting",
 *   "relationship_to_mc": "Close childhood friend",
 *   "relationships": [...],
 *   "past_interactions": [...],
 *   "last_interaction_at_page": 3,
 *   "narrative_flags": {...},
 *   "places": [...],
 *   "created_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const characters = pgTable(
  "characters",
  {
    id: uuid("id").primaryKey(),
    bookId: bookId("cascade"), // Delete if book is deleted
    name: text("name").notNull(),
    gender,
    role: text("role").notNull(),
    bio: text("bio").notNull(),

    // status: text("status").notNull(), // CharacterStatus enum
    // relationshipToMC: text("relationship_to_mc").notNull(),
    // relationships: jsonb("relationships").$type<any[]>().notNull().default(sql`'[]'::jsonb`), // CharacterRelationship[] structure
    // pastInteractions: jsonb("past_interactions").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // Sliding window (max 5)
    // lastInteractionAtPage: integer("last_interaction_at_page").notNull(),
    // narrativeFlags: jsonb("narrative_flags").$type<any>().notNull(), // NarrativeFlags structure
    // places: jsonb("places").$type<any[]>().notNull().default(sql`'[]'::jsonb`), // CharacterPlaceRelation[] structure

    createdAt,
    updatedAt,
  },
  (t) => [
    // Index for book queries
    index("characters_book_idx").on(t.bookId),
    // Index for character name lookup
    index("characters_name_idx").on(t.name),
    // // Index for status filtering
    // index("characters_status_idx").on(t.status),
    // // Index for recent interactions
    // index("characters_interaction_idx").on(t.lastInteractionAtPage.desc()),
    // Index for gender-based filtering
    index("characters_gender_idx").on(t.gender),
    // Unique constraint on (bookId, name) to ensure character names are unique per book
    unique("characters_book_name_unique").on(t.bookId, t.name),
  ]
);

/**
 * Create places table
 * @summary Store place memory with visit history and emotional associations
 * @example
 * {
 *   "id": "place123",
 *   "book_id": "book456",
 *   "name": "Old River",
 *   "type": "river",
 *   "context": "Narrow river behind school",
 *   "location_hint": "Behind school, flows toward town",
 *   "visit_count": 3,
 *   "last_visited_at_page": 8,
 *   "familiarity": 0.4,
 *   "mood_history": ["eerie", "threatening"],
 *   "event_tags": ["betrayal", "discovery"],
 *   "known_characters": ["Lina", "MC"],
 *   "sensory_details": {...},
 *   "current_mood": "threatening",
 *   "created_at": "2023-01-01T00:00:00.000Z"
 * }
 */
export const places = pgTable(
  "places",
  {
    id: id(),
    bookId: bookId("cascade"), // Delete if book is deleted
    name: text("name").notNull(),
    type: text("type").notNull(), // PlaceType enum
    context: text("context").notNull(), // 1-sentence description
    locationHint: text("location_hint"), // Optional spatial relationship

    // visitCount: integer("visit_count").notNull().default(1),
    // lastVisitedAtPage: integer("last_visited_at_page").notNull(),
    // familiarity: real("familiarity").notNull().default(0.1), // 0-1 scale
    // moodHistory: jsonb("mood_history").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // PlaceMood[] sliding window
    // eventTags: jsonb("event_tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // ["betrayal", "discovery", etc.]
    // knownCharacters: jsonb("known_characters").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // Character names encountered
    // sensoryDetails: jsonb("sensory_details").$type<any>(), // SensoryDetails structure
    // currentMood: text("current_mood").notNull(), // PlaceMood enum

    createdAt,
    updatedAt,
  },
  (t) => [
    // Index for book queries
    index("places_book_idx").on(t.bookId),
    // Index for place name lookup
    index("places_name_idx").on(t.name),
    // Index for place type filtering
    index("places_type_idx").on(t.type),
    // Unique constraint on (bookId, name) to ensure place names are unique per book
    unique("places_book_name_unique").on(t.bookId, t.name),
    // // Index for familiarity sorting
    // index("places_familiarity_idx").on(t.familiarity.desc()),
    // // Index for recent visits
    // index("places_recent_visit_idx").on(t.lastVisitedAtPage.desc()),
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
    id: id(),
    userId: userId(), // Initiator
    pageId: pageId("cascade"), // Delete if page is deleted
    page: integer("page").notNull(),
    maxPage: integer("max_page").notNull(),
    flags: jsonb("flags").$type<PsychologicalFlags>().notNull(), // Psychological flags structure
    traumaTags: jsonb("trauma_tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // Sliding window (MAX_TRAUMA_TAGS)
    psychologicalProfile: jsonb("psychological_profile").$type<PsychologicalProfile>().notNull(), // PsychologicalProfile structure
    hiddenState: jsonb("hidden_state").$type<HiddenState>().notNull(), // Hidden narrative state structure
    memoryIntegrity: text("memory_integrity").$type<MemoryIntegrity>().notNull().default("stable"), // "stable" | "fragmented" | "corrupted"
    difficulty: text("difficulty").$type<Difficulty>().notNull().default("low"), // "low" | "medium" | "high" | "nightmare"
    cachedEndingArchetype: text("cached_ending_archetype").$type<Ending>(), // Ending enum, nullable until assigned
    characters: jsonb("characters").$type<Record<string, CharacterMemory>>().notNull().default(sql`'{}'::jsonb`), // Character records
    places: jsonb("places").$type<Record<string, PlaceMemory>>().notNull().default(sql`'{}'::jsonb`), // Place records
    pageHistory: jsonb("page_history").$type<StoryPage[]>().notNull().default(sql`'[]'::jsonb`), // StoryPage[] sliding window
    actionsHistory: jsonb("actions_history").$type<Action[]>().notNull().default(sql`'[]'::jsonb`), // History of user actions
    contextHistory: text("context_history").notNull().default(""), // AI-summarized story context from page 1 to current
    createdAt,
    updatedAt,
  },
  (t) => [
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
    displayTitle: text("display_title").notNull(),
    hook: text("hook"),
    summary: text("summary"),
    trendingScore: real("trending_score").default(0),
    keywords: jsonb("keywords").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // e.g. ['cardiff mosque', 'peel street mosque', 'world war ii', 'muslim community']
    status: text("status").$type<BookStatus | null>().default('active'),
    mc: jsonb("mc").$type<StoryMC>().notNull(), // Main character profile with name, age, gender
    createdAt,
    updatedAt,
  },
  (t) => [
    index("books_trending_idx").on(t.trendingScore),
    // Optimize time-window queries
    index("books_recent_idx").on(t.updatedAt),
    // Optimize trending feed queries with compound ordering
    index("books_trending_feed_idx").on(
      t.status.desc(),
      t.trendingScore.desc(),
      t.updatedAt.desc()
    ),
    // Index for user book queries
    index("books_user_idx").on(t.userId),
    // Index for status filtering
    index("books_status_idx").on(t.status),
    // Optimize cursor-based pagination (with status filter)
    index("books_feed_cursor_idx").on(
      t.updatedAt.desc(),
      t.id.desc()
    ),
    // Optimize cursor-based pagination with status
    index("books_feed_cursor_status_idx").on(
      t.status,
      t.updatedAt.desc(),
      t.id.desc()
    ),
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
    userId: userId(),
    bookId: bookId("cascade"), // Delete if book is deleted
    pageId: pageId("set null"),
    status: text("status").$type<SessionStatus>().notNull().default("active"),
    createdAt,
    updatedAt,
  },
  (t) => [
    // Composite primary key on userId and bookId
    primaryKey({ columns: [t.userId, t.bookId] }),
    // Index for status filtering
    index("user_sessions_status_idx").on(t.status),
    // Index for user's active sessions
    index("user_sessions_user_active_idx").on(t.userId).where(sql`status = 'active'`),
  ]
);