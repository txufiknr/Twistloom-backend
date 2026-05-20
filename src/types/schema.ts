import type { users, pages, storyStates, books, userSessions, userLikes, userFavorites, userComments, userPageProgress, userActivityLogs, bookGenerations, pageTranslations, bookTranslations } from "../db/schema.js";

/** Complete user data as stored in database */
export type DBUser = typeof users.$inferSelect;
export type DBNewUser = typeof users.$inferInsert;

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

/** Complete user activity log data as stored in database */
export type DBUserActivityLog = typeof userActivityLogs.$inferSelect;
export type DBNewUserActivityLog = typeof userActivityLogs.$inferInsert;

/** Complete page translation data as stored in database */
export type DBPageTranslations = typeof pageTranslations.$inferSelect;
export type DBNewPageTranslations = typeof pageTranslations.$inferInsert;

/** Complete book translation data as stored in database */
export type DBBookTranslations = typeof bookTranslations.$inferSelect;
export type DBNewBookTranslations = typeof bookTranslations.$inferInsert;
