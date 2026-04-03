import type { users, pages, characters, places, storyStates, books, userSessions, userLikes, userFavorites, userComments, userPageProgress } from "../db/schema.js";

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

/** Complete character data as stored in database */
export type DBCharacter = typeof characters.$inferSelect;
export type DBNewCharacter = typeof characters.$inferInsert;

/** Complete place data as stored in database */
export type DBPlace = typeof places.$inferSelect;
export type DBNewPlace = typeof places.$inferInsert;

/** Complete story state data as stored in database */
export type DBStoryState = typeof storyStates.$inferSelect;
export type DBNewStoryState = typeof storyStates.$inferInsert;

/** Complete book data as stored in database */
export type DBBook = typeof books.$inferSelect;
export type DBNewBook = typeof books.$inferInsert;

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