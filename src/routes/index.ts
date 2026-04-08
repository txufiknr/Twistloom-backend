import express from "express";
import userRouter from "./user.js";
import booksRouter from "./books.js";
import adminRouter from "./admin.js";
import { APP_NAME, VERSION } from "../config/constants.js";

const router = express.Router();

// Health check endpoint
router.get("/", (_req, res) => {
  res.json({
    message: `${APP_NAME} API is running!`,
    version: VERSION,
    endpoints: {
      "/user": "Get and manage user profile information",
      "/books": "Create and manage psychological thriller books",
      "/admin": "Administrative tools and debugging endpoints"
    }
  });
});

// Mount route modules
router.use("/user", userRouter);
router.use("/books", booksRouter);
router.use("/admin", adminRouter);

export default router;
