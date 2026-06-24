/**
 * Authentication Routes
 *
 * Provides credential verification and Google token endpoints for the NextAuth
 * providers. The backend verifies credentials / tokens and returns user data;
 * NextAuth creates and manages the session cookie.
 *
 * Flow overview:
 *   Email login  → POST /verify-credentials → returns user + isNewUser
 *   Google OAuth → POST /google-oauth       → verifies id_token, upserts user, returns user + isNewUser
 *   One Tap      → POST /google-one-tap     → same as /google-oauth (different entry point)
 *
 * isNewUser is included in every sign-in response so the frontend can embed it
 * in the JWT token at sign-in time, making the session() callback a pure
 * token-reader with zero network calls.
 */

import type { Router as RouterType } from "express";
import { Router } from "express";
import { OAuth2Client } from 'google-auth-library';
import { dbRead, dbWrite } from '../db/client.js';
import { users, userAuth } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { validatePasswordStrength } from '../utils/password-validation.js';
import { checkAccountLockout, recordFailedLogin, resetFailedLoginAttempts } from '../utils/account-lockout.js';
import { createPasswordResetToken, resetPassword, verifyPasswordResetToken } from '../utils/password-reset.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../utils/email.js';
import { createEmailVerificationToken, verifyEmailToken, isEmailVerified } from '../utils/email-verification.js';
import { handleApiError, handleRateLimitError, handleUnauthorizedError, handleValidationError } from '../utils/error.js';
import { checkRateLimitByIP } from '../middleware/rate-limit.js';
import { generateId } from '../utils/uuid.js';
import { createOrUpdateOAuthUser, setReferrerForNewUser } from '../services/user-controller.js';
import { isTemp as isTemporaryEmail } from 'tempmail-checker';
import { requireAuth } from '../middleware/nextauth.js';
import { getUserSessions, logoutFromSpecificDevice, logoutFromAllOtherDevices } from '../services/session-manager.js';
import { sanitizeUserData, getUserForAuth, getUserIdByEmail } from '../services/user.js';
import type { Request, Response } from "express";
import type { DBUserForAuth } from '../types/schema.js';

const router: RouterType = Router();

// Google OAuth client for ID token verification (used by both One Tap and OAuth flows)
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * Verifies a Google ID token, upserts the user, and sends the user data
 * response. Used by both POST /google-one-tap and POST /google-oauth.
 */
async function handleGoogleAuth(idToken: string, req: Request, res: Response): Promise<void> {
  // Rate limiting based on IP address
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimitByIP(ip)) return handleRateLimitError(res);

  // Verify Google ID token (works for both One Tap credentials and standard OAuth id_token)
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  if (!payload?.email) return handleUnauthorizedError(res, 'Invalid token payload');

  const { email, name, picture: image } = payload;

  // Create user if new, or update profile fields if existing
  const userId = await createOrUpdateOAuthUser({email, name, image});

  // Fetch full user record including isNewUser.
  // isNewUser reflects the canonical database state — true for brand-new users,
  // false once onboarding has been completed (set by the onboarding endpoint).
  const [user] = await dbRead
    .select({
      userId: users.userId,
      email: users.email,
      name: users.name,
      username: users.username,
      imageUrl: users.imageUrl,
      isNewUser: users.isNewUser,
    })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);

  if (!user) {
    return handleApiError(res, 'Failed to retrieve user data');
  }

  res.json(user);
}

// ---------------------------------------------------------------------------
// POST /api/auth/verify-credentials
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/verify-credentials
 *
 * Verifies email/username and password for the NextAuth Credentials provider.
 *
 * Request Body:
 * {
 *   emailOrUsername: string;
 *   password: string;
 * }
 *
 * Response (200):
 * {
 *   userId: string;
 *   email: string;
 *   name: string;
 *   username: string;
 *   image?: string;
 *   isNewUser: boolean;  // Embedded in JWT token by NextAuth jwt() callback
 * }
 *
 * Response (401): Invalid credentials
 * Response (429): Rate limited or account locked
 *
 * Security:
 * - Rate limited to prevent brute force
 * - bcrypt password verification
 * - Account lockout after repeated failures
 * - Returns minimal user data (no passwordHash)
 *
 * @example
 * // NextAuth Credentials provider usage
 * async authorize(credentials) {
 *   const res = await fetch(`${API_BASE_URL}/auth/verify-credentials`, {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({
 *       emailOrUsername: credentials.emailOrUsername,
 *       password: credentials.password,
 *     }),
 *   });
 *   if (!res.ok) return null;
 *   const user = await res.json();
 *   return { id: user.userId, ...user };
 * }
 */
router.post('/verify-credentials', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimitByIP(ip)) return handleRateLimitError(res);

    const { emailOrUsername, password } = req.body;

    if (!emailOrUsername || !password) {
      return handleValidationError(res, 'Email/username and password are required');
    }

    const userData = await getUserForAuth(emailOrUsername);
    if (!userData) {
      return handleUnauthorizedError(res, 'Invalid credentials');
    }

    // Check account lockout
    const lockoutStatus = await checkAccountLockout(userData.userId);
    if (lockoutStatus.isLocked) {
      if (lockoutStatus.remainingTime === undefined) {
        await resetFailedLoginAttempts(userData.userId);
        return handleRateLimitError(res, 'Account lock state inconsistent. Please try again.');
      }
      const minutesRemaining = Math.ceil(lockoutStatus.remainingTime / 60000);
      return res.status(429).json({
        error: `Account locked. Try again in ${minutesRemaining} minutes.`,
        lockedUntil: new Date(Date.now() + lockoutStatus.remainingTime).toISOString(),
      });
    }

    if (!userData.passwordHash) {
      return handleUnauthorizedError(res, 'This account uses OAuth login. Please sign in with Google.');
    }

    const isValid = await verifyPassword(password, userData.passwordHash);
    if (!isValid) {
      await recordFailedLogin(userData.userId);
      return handleUnauthorizedError(res, 'Invalid credentials');
    }

    await resetFailedLoginAttempts(userData.userId);

    res.json({
      userId: userData.userId,
      email: userData.email,
      name: userData.name,
      username: userData.username,
      imageUrl: userData.imageUrl,
      isNewUser: userData.isNewUser,
    } satisfies Omit<DBUserForAuth, 'passwordHash'> & { isNewUser: boolean });
  } catch (error) {
    console.error('[POST /api/auth/verify-credentials] ❌ Credential verification error:', error);
    handleApiError(res, 'Failed to verify credentials', error, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/signup
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/signup
 *
 * Registers a new user account with email/password authentication.
 *
 * Request Body:
 * {
 *   email: string;
 *   username: string;
 *   gender: string;
 *   password: string;
 *   receiveEmails: boolean;
 *   agreedToTerms: boolean;
 *   referrer?: string;
 * }
 *
 * Response (201):
 * {
 *   userId: string;
 *   message: string;
 *   verificationEmailSent: boolean;
 *   referrer?: string;
 *   referralApplied: boolean;
 * }
 *
 * Response (400): Invalid input
 * Response (409): Email or username already exists
 * Response (422): Weak password or invalid username
 * Response (429): Rate limited
 * Response (500): Server error
 *
 * Security:
 * - Rate limited to prevent abuse
 * - bcrypt password hashing
 * - Username and email uniqueness enforced
 * - Temporary/disposable emails blocked
 */
router.post('/signup', async (req, res) => {
  try {
    // Rate limit
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimitByIP(ip)) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    // Sign up data validation
    const { password, receiveEmails: _receiveEmails, agreedToTerms, referrer } = req.body;
    if (!password) return handleValidationError(res, 'Password is required');
    if (!agreedToTerms) return handleValidationError(res, 'You must agree to the terms');

    // Password strength validation
    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.valid) {
      return res.status(422).json({
        error: 'Password does not meet security requirements',
        details: passwordValidation.errors,
      });
    }

    // User data validation
    const userData = await sanitizeUserData(req.body, { res, createNew: true });
    if (!userData) return;

    // Check if cleaned email is a temporary email address
    if (isTemporaryEmail(userData.email)) {
      return handleValidationError(res, 'Temporary or disposable email addresses are not allowed.', undefined, 422);
    }

    const passwordHash = await hashPassword(password);
    const newUser = await dbWrite.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({ userId: generateId(), ...userData, passwordHash, }).returning();
      await tx.insert(userAuth).values({ userId: user.userId });
      return user;
    });

    const verificationToken = await createEmailVerificationToken(newUser.userId);
    const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`;
    const verificationEmailSent = await sendVerificationEmail(newUser.email, verificationUrl);

    let referralApplied = false;
    if (referrer && typeof referrer === 'string') {
      referralApplied = await setReferrerForNewUser(req, res, newUser.userId, referrer, { handleResponse: false });
    }

    res.status(201).json({
      userId: newUser.userId,
      message: verificationEmailSent
        ? 'Account created. Please check your email to verify your account.'
        : 'Account created. Verification email failed to send.',
      verificationEmailSent,
      referrer,
      referralApplied,
    });
  } catch (error) {
    console.error('[signup] ❌ Sign up error:', error);
    handleApiError(res, 'Failed to create account', error);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/forgot-password
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/forgot-password
 *
 * Sends a password reset email. Always returns 200 to prevent email enumeration.
 *
 * Request Body: { email: string }
 * Response (200): { message: string }
 * Response (429): Rate limited
 */
router.post('/forgot-password', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimitByIP(ip)) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    const { email } = req.body;

    if (!email) {
      return handleValidationError(res, 'Email is required');
    }

    const token = await createPasswordResetToken(email);

    if (token) {
      const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
      await sendPasswordResetEmail(email, resetUrl);
    }

    // Always return success — prevents email enumeration
    res.json({ message: 'Password reset email sent if account exists' });
  } catch (error) {
    console.error('[forgot] ❌ Forgot password error:', error);
    handleApiError(res, 'Failed to process request', error, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/reset-password
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/reset-password
 *
 * Resets user password using a valid reset token.
 *
 * Request Body: { token: string; password: string }
 * Response (200): { message: string }
 * Response (400): Invalid token or weak password
 * Response (429): Rate limited
 *
 * Security: token expires after 1 hour, single-use.
 */
router.post('/reset-password', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimitByIP(ip)) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    const { token, password } = req.body;

    if (!token || !password) {
      return handleValidationError(res, 'Token and password are required');
    }

    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.valid) {
      return res.status(422).json({
        error: 'Password does not meet security requirements',
        details: passwordValidation.errors,
      });
    }

    const userId = await verifyPasswordResetToken(token);
    if (!userId) {
      return handleValidationError(res, 'Invalid or expired reset token');
    }

    const success = await resetPassword(token, password);
    if (!success) {
      return handleValidationError(res, 'Failed to reset password');
    }

    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    console.error('[reset] ❌ Reset password error:', error);
    handleApiError(res, 'Failed to reset password', error, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/verify-email
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/verify-email
 *
 * Verifies user email using a verification token.
 *
 * Request Body: { token: string }
 * Response (200): { message: string }
 * Response (400): Invalid or expired token
 *
 * Security: token expires after 24 hours, single-use.
 */
router.post('/verify-email', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimitByIP(ip)) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    const { token } = req.body;

    if (!token) {
      return handleValidationError(res, 'Token is required');
    }

    const userId = await verifyEmailToken(token);

    if (!userId) {
      return handleValidationError(res, 'Invalid or expired verification token');
    }

    res.json({ message: 'Email verified successfully' });
  } catch (error) {
    console.error('[verifyEmail] ❌ Verify email error:', error);
    handleApiError(res, 'Failed to verify email', error, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/resend-verification
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/resend-verification
 *
 * Resends email verification. Always returns 200 to prevent email enumeration.
 *
 * Request Body: { email: string }
 * Response (200): { message: string }
 * Response (429): Rate limited
 */
router.post('/resend-verification', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimitByIP(ip)) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    const { email } = req.body;

    if (!email) {
      return handleValidationError(res, 'Email is required');
    }

    const userId = await getUserIdByEmail(email);

    if (!userId) {
      res.json({ message: 'Verification email sent if account exists' });
      return;
    }

    const verified = await isEmailVerified(userId);
    if (verified) {
      res.json({ message: 'Verification email sent if account exists' });
      return;
    }

    const verificationToken = await createEmailVerificationToken(userId);
    const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`;
    await sendVerificationEmail(email, verificationUrl);

    res.json({ message: 'Verification email sent' });
  } catch (error) {
    console.error('[resendVerification] ❌ Resend verification error:', error);
    handleApiError(res, 'Failed to resend verification email', error, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/logout
 *
 * Placeholder for any backend cleanup on logout.
 * Session clearing is handled entirely by NextAuth on the frontend via signOut().
 */
router.post('/logout', async (req, res) => {
  try {
    // Add backend cleanup if needed (invalidate refresh tokens, analytics, etc.)
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    handleApiError(res, 'Failed to logout', error, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/google-one-tap
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/google-one-tap
 *
 * Verifies a Google ID token from the GIS One Tap popup and upserts the user.
 * Used by the NextAuth 'googleonetap' Credentials provider in authorize().
 *
 * Request Body:
 * {
 *   idToken: string;  // Google ID token from the GIS One Tap callback
 * }
 *
 * Response (200):
 * {
 *   userId: string;
 *   email: string;
 *   name: string | null;
 *   username: string;
 *   image: string | null;
 *   isNewUser: boolean;  // Embedded in JWT token by jwt() callback
 * }
 *
 * Response (400): Missing idToken
 * Response (401): Token verification failed
 * Response (429): Rate limited
 *
 * @example
 * // NextAuth Credentials provider usage
 * Credentials({
 *   id: 'googleonetap',
 *   async authorize(credentials) {
 *     const res = await fetch(`${API_BASE_URL}/auth/google-one-tap`, {
 *       method: 'POST',
 *       headers: { 'Content-Type': 'application/json' },
 *       body: JSON.stringify({ idToken: credentials.credential }),
 *     });
 *     if (!res.ok) return null;
 *     const user = await res.json();
 *     return { id: user.userId, ...user };
 *   }
 * })
 */
router.post('/google-one-tap', async (req: Request, res: Response) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return handleValidationError(res, 'ID token is required');

    await handleGoogleAuth(idToken, req, res);
  } catch (error) {
    console.error('[POST /api/auth/google-one-tap] ❌ Google One Tap error:', error);
    handleApiError(res, 'Failed to authenticate with Google One Tap', error);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/google-oauth
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/google-oauth
 *
 * Verifies a Google ID token from the standard Google OAuth flow and upserts
 * the user. Called server-side from the NextAuth jwt() callback on first
 * Google OAuth sign-in (account.id_token is the Google ID token that Auth.js
 * receives as part of the OAuth token exchange).
 *
 * This endpoint ensures that Google OAuth users are created in the backend
 * database at sign-in time (not lazily). It is functionally identical to
 * /google-one-tap but kept separate for logging and analytics clarity.
 *
 * Request Body:
 * {
 *   idToken: string;  // account.id_token from Auth.js Google OAuth response
 * }
 *
 * Response (200):
 * {
 *   userId: string;
 *   email: string;
 *   name: string | null;
 *   username: string;
 *   image: string | null;
 *   isNewUser: boolean;  // Embedded in JWT token by jwt() callback
 * }
 *
 * Response (400): Missing idToken
 * Response (401): Token verification failed
 * Response (429): Rate limited
 *
 * Note: This is a server-to-server call (Next.js jwt() callback → backend).
 * The Google ID token acts as the authentication credential; no additional
 * auth header is required. Rate limiting is applied per the source IP.
 *
 * @example
 * // Frontend jwt() callback usage
 * if (account.provider === 'google' && account.id_token) {
 *   const res = await fetch(`${API_BASE_URL}/auth/google-oauth`, {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({ idToken: account.id_token }),
 *   });
 *   const backendUser = await res.json();
 *   token.userId = backendUser.userId;
 *   token.username = backendUser.username;
 *   token.isNewUser = backendUser.isNewUser;
 * }
 */
router.post('/google-oauth', async (req: Request, res: Response) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return handleValidationError(res, 'ID token is required');

    await handleGoogleAuth(idToken, req, res);
  } catch (error) {
    console.error('[POST /api/auth/google-oauth] ❌ Google OAuth error:', error);
    handleApiError(res, 'Failed to authenticate with Google OAuth', error);
  }
});

// ---------------------------------------------------------------------------
// GET /api/auth/sessions
// ---------------------------------------------------------------------------

/**
 * GET /api/auth/sessions
 *
 * Returns all active sessions for the authenticated user.
 *
 * Response (200):
 * {
 *   sessions: Array<{
 *     id: string;
 *     userAgent: string | null;
 *     ipAddress: string | null;
 *     deviceName: string;
 *     lastActiveAt: string;
 *     createdAt: string;
 *   }>;
 *   count: number;
 * }
 *
 * Response (401): Unauthorized
 */
router.get('/sessions', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const sessions = await getUserSessions(userId);
    res.json({ sessions, count: sessions.length });
  } catch (error) {
    console.error('[GET /api/auth/sessions] ❌ Error fetching sessions:', error);
    handleApiError(res, 'Failed to fetch sessions', error, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout-all
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/logout-all
 *
 * Logs out from all other devices, preserving the current session.
 *
 * Response (200): { message: string; deletedCount: number }
 * Response (400): No session ID found
 * Response (401): Unauthorized
 */
router.post('/logout-all', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const currentSessionId = req.user?.sessionId;

    if (!currentSessionId) {
      return res.status(400).json({ error: 'No session ID found' });
    }

    const deletedCount = await logoutFromAllOtherDevices(userId, currentSessionId);

    res.json({
      message: `Logged out from ${deletedCount} other device(s)`,
      deletedCount,
    });
  } catch (error) {
    console.error('[POST /api/auth/logout-all] ❌ Error logging out from all devices:', error);
    handleApiError(res, 'Failed to logout from all devices', error, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout-session
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/logout-session
 *
 * Logs out from a specific session by ID.
 *
 * Request Body: { sessionId: string }
 * Response (200): { message: string; deletedCount: number }
 * Response (400): sessionId is required
 * Response (401): Unauthorized
 * Response (404): Session not found
 */
router.post('/logout-session', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const deletedCount = await logoutFromSpecificDevice(userId, sessionId);

    if (deletedCount === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({ message: 'Logged out from device', deletedCount });
  } catch (error) {
    console.error('[POST /api/auth/logout-session] ❌ Error logging out from session:', error);
    handleApiError(res, 'Failed to logout from session', error, 500);
  }
});

export default router;