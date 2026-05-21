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
    /** Parsed language code from Accept-Language header (e.g., "en" from "en-US,en;q=0.9") */
    headerLanguage?: string | null;
    file?: Express.Multer.File;
  }
}

export {};
