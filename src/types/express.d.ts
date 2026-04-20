import type { _Request } from "express";

/**
 * NextAuth user information
 */
export interface AuthUser {
  id: string;
  email: string;
  name?: string;
}

/**
 * Guest user authentication result
 */
export interface GuestAuthResult {
  isAuthenticated: boolean;
  userId: string | null;
  isGuest: boolean;
  user?: AuthUser;
}

declare module "express" {
  interface Request {
    /** User identifier from authentication middleware */
    userId?: string;
    /** NextAuth user data from cookie-based authentication */
    user?: AuthUser;
    /** Guest user authentication data */
    guestAuth?: GuestAuthResult;
    file?: Express.Multer.File;
  }
}

export {};
