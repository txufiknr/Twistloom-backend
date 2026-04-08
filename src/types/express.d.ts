import type { _Request } from "express";

declare module "express" {
  interface Request {
    /** User identifier from authentication middleware */
    userId?: string;
    file?: Express.Multer.File;
  }
}

export {};
