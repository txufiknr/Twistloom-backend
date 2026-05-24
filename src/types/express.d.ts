import type { _Request } from "express";

/**
 * NextAuth user information
 */
export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  stripeCustomerId?: string;
}

declare module "express" {
  interface Request {
    /** User identifier from authentication middleware */
    userId?: string;
    /** NextAuth user data from cookie-based authentication */
    user?: AuthUser;
    /** Parsed language code from Accept-Language header (e.g., "en" from "en-US,en;q=0.9") */
    headerLanguage?: string | null;
    file?: Express.Multer.File;
  }
}

export {};
