import { Hono } from "hono";
import userRouter from "./user.js";
import booksRouter from "./books.js";
import adminRouter from "./admin.js";
import authRouter from "./auth.js";
import paymentsRouter from "./payments.js";
import socialMentionsRouter from "./social-mentions.js";
import { APP_NAME, VERSION } from "../config/constants.js";
import type { AppEnv } from "../hono/env.js";

const router = new Hono<AppEnv>();

// Health check endpoint
router.get("/", (c) => {
  return c.json({
    message: `${APP_NAME} API is running!`,
    version: VERSION,
    endpoints: {
      "/user": "Get and manage user profile information",
      "/books": "Create and manage psychological thriller books",
      "/admin": "Administrative tools and debugging endpoints",
      "/auth": "Authentication endpoints",
      "/payments": "Stripe checkout sessions and credit purchases",
      "/social-mentions": "Public social-proof wall (featured mentions)",
    },
  });
});

// Mount route modules
router.route("/user", userRouter);
router.route("/books", booksRouter);
router.route("/admin", adminRouter);
router.route("/auth", authRouter);
router.route("/payments", paymentsRouter);
router.route("/social-mentions", socialMentionsRouter);

export default router;
