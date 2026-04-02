import type { users, pages, characters, places, storyStates, books, userSessions } from "../db/schema.js";

/** Complete user data as stored in database */
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/** User data with engagement counts */
export type UserWithCounts = User & {
  totalLiked: number;
  totalSaved: number;
  totalReads: number;
};

/** Complete page data as stored in database */
export type Page = typeof pages.$inferSelect;
export type NewPage = typeof pages.$inferInsert;

/** Complete character data as stored in database */
export type Character = typeof characters.$inferSelect;
export type NewCharacter = typeof characters.$inferInsert;

/** Complete place data as stored in database */
export type Place = typeof places.$inferSelect;
export type NewPlace = typeof places.$inferInsert;

/** Complete story state data as stored in database */
export type StoryState = typeof storyStates.$inferSelect;
export type NewStoryState = typeof storyStates.$inferInsert;

/** Complete book data as stored in database */
export type Book = typeof books.$inferSelect;
export type NewBook = typeof books.$inferInsert;

/** Complete user session data as stored in database */
export type UserSession = typeof userSessions.$inferSelect;
export type NewUserSession = typeof userSessions.$inferInsert;