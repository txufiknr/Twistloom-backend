import type { users, pages, storyStates, books, userSessions, userLikes, userFavorites, userComments, userPageProgress, userActivityLogs, bookGenerations, pageTranslations, bookTranslations, storyPrompts, userCounters, userFeedbacks, penSessions, penDrafts, penEdits, loreEntries, penNotes, platformTestimonials, userBetaDuties } from "../db/schema.js";

/** Complete user data as stored in database */
export type DBUser = typeof users.$inferSelect;
export type DBNewUser = typeof users.$inferInsert;
export type DBUserForAuth = Pick<DBUser, 'userId' | 'email' | 'username' | 'name' | 'imageUrl' | 'passwordHash' | 'isNewUser'>;

/** User data with engagement counts */
export type DBUserWithCounts = DBUser & {
  totalLiked: number;
  totalSaved: number;
  totalReads: number;
};

/** Complete page data as stored in database */
export type DBPage = typeof pages.$inferSelect;
export type DBNewPage = typeof pages.$inferInsert;

/** Complete story state data as stored in database */
export type DBStoryState = typeof storyStates.$inferSelect;
export type DBNewStoryState = typeof storyStates.$inferInsert;

/** Complete story prompt data as stored in database */
export type DBStoryPrompt = typeof storyPrompts.$inferSelect;
export type DBNewStoryPrompt = typeof storyPrompts.$inferInsert;

/** Complete book data as stored in database */
export type DBBook = typeof books.$inferSelect;
export type DBNewBook = typeof books.$inferInsert;
export type DBUpdateBook = Partial<Omit<DBNewBook, 'id' | 'userId' | 'createdAt'>>;

/** Complete book data as stored in database */
export type DBBookGeneration = typeof bookGenerations.$inferSelect;
export type DBNewBookGeneration = typeof bookGenerations.$inferInsert;

/** Complete user session data as stored in database */
export type DBUserSession = typeof userSessions.$inferSelect;
export type DBNewUserSession = typeof userSessions.$inferInsert;

/** Complete user page progress data as stored in database */
export type DBUserPageProgress = typeof userPageProgress.$inferSelect;
export type DBNewUserPageProgress = typeof userPageProgress.$inferInsert;

/** Complete user like data as stored in database */
export type DBUserLike = typeof userLikes.$inferSelect;
export type DBNewUserLike = typeof userLikes.$inferInsert;

/** Complete user favorite data as stored in database */
export type DBUserFavorite = typeof userFavorites.$inferSelect;
export type DBNewUserFavorite = typeof userFavorites.$inferInsert;

/** Complete user comment data as stored in database */
export type DBUserComment = typeof userComments.$inferSelect;
export type DBNewUserComment = typeof userComments.$inferInsert;

/** Complete user counter data as stored in database */
export type DBUserCounter = typeof userCounters.$inferSelect;
export type DBNewUserCounter = typeof userCounters.$inferInsert;

/** Complete user activity log data as stored in database */
export type DBUserActivityLog = typeof userActivityLogs.$inferSelect;
export type DBNewUserActivityLog = typeof userActivityLogs.$inferInsert;

/** Complete page translation data as stored in database */
export type DBPageTranslations = typeof pageTranslations.$inferSelect;
export type DBNewPageTranslations = typeof pageTranslations.$inferInsert;

/** Complete book translation data as stored in database */
export type DBBookTranslations = typeof bookTranslations.$inferSelect;
export type DBNewBookTranslations = typeof bookTranslations.$inferInsert;

/** Complete user feedback data as stored in database */
export type DBUserFeedback = typeof userFeedbacks.$inferSelect;
export type DBNewUserFeedback = typeof userFeedbacks.$inferInsert;

/** Complete platform-wide testimonial data as stored in database */
export type DBPlatformTestimonial = typeof platformTestimonials.$inferSelect;
export type DBNewPlatformTestimonial = typeof platformTestimonials.$inferInsert;

/** Complete Pen session data as stored in database */
export type DBPenSession = typeof penSessions.$inferSelect;
export type DBNewPenSession = typeof penSessions.$inferInsert;

/** Complete Pen draft slot as stored in database (multi-draft workspace) */
export type DBPenDraft = typeof penDrafts.$inferSelect;
export type DBNewPenDraft = typeof penDrafts.$inferInsert;

/** Complete Pen edit data as stored in database */
export type DBPenEdit = typeof penEdits.$inferSelect;
export type DBNewPenEdit = typeof penEdits.$inferInsert;

/** Complete story-bible (lore) entry as stored in database */
export type DBLoreEntry = typeof loreEntries.$inferSelect;
export type DBNewLoreEntry = typeof loreEntries.$inferInsert;

/** Complete Pen author scratchpad note as stored in database */
export type DBPenNote = typeof penNotes.$inferSelect;
export type DBNewPenNote = typeof penNotes.$inferInsert;

/** Complete user beta duty data as stored in database */
export type DBUserBetaDuty = typeof userBetaDuties.$inferSelect;
export type DBNewUserBetaDuty = typeof userBetaDuties.$inferInsert;
