/**
 * Authentication Routes
 *
 * Provides credential verification, user registration, Google OAuth, password
 * management, email verification, and session management endpoints for the
 * NextAuth providers. The backend verifies credentials / tokens and returns
 * user data; NextAuth creates and manages the session cookie.
 *
 * Flow overview:
 *   Email login     → POST /verify-credentials  → returns user + isNewUser
 *   Google OAuth    → POST /google-oauth        → verifies id_token, upserts user, returns user + isNewUser
 *   One Tap         → POST /google-one-tap      → same as /google-oauth (different entry point)
 *   Signup          → POST /signup              → creates account, sends verification email
 *   Forgot password → POST /forgot-password     → sends password reset email
 *   Reset password  → POST /reset-password      → resets password with token
 *   Verify email    → POST /verify-email        → verifies email with token
 *   Resend verify   → POST /resend-verification → resends verification email
 *   Sessions        → GET /sessions             → list active sessions
 *   Logout (device) → POST /logout-session      → logout specific session
 *   Logout (other)  → POST /logout-all          → logout all other sessions
 *   Logout (all)    → POST /logout-all-devices  → logout from every device
 *   Logout (simple) → POST /logout              → placeholder cleanup
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
import { eq, and, ne } from 'drizzle-orm';
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
import { validateUsername } from '../utils/username.js';
import { isTemp as isTemporaryEmail } from 'tempmail-checker';
import { requireAuth } from '../middleware/nextauth.js';
import { getUserSessions, logoutFromSpecificDevice, logoutFromAllOtherDevices, logoutFromAllDevices, deleteSessionById } from '../services/session-manager.js';
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
 * Checks account lockout status, verifies bcrypt password hash, and returns
 * user data for JWT token embedding.
 *
 * @route POST /api/auth/verify-credentials
 * @description Verify email/username and password credentials
 *
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 *
 * @body {Object} Credentials
 * @body {string} emailOrUsername - User email or username
 * @body {string} password - Plaintext password
 *
 * @returns {Object} User data for JWT
 * @returns {string} userId - User's unique identifier
 * @returns {string} email - User email
 * @returns {string|null} name - User display name
 * @returns {string} username - User username
 * @returns {string|null} imageUrl - User profile image URL
 * @returns {boolean} isNewUser - Whether onboarding is pending
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
 *
 * // Response
 * {
 *   "userId": "user-uuid",
 *   "email": "user@example.com",
 *   "name": "John Doe",
 *   "username": "johndoe",
 *   "imageUrl": "https://ik.imagekit.io/abc123/profile.jpg",
 *   "isNewUser": false
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
 * Validates input (password strength, email format, username rules),
 * checks for disposable emails, creates user + auth records in a
 * transaction, sends verification email, and applies referral if provided.
 *
 * @route POST /api/auth/signup
 * @description Register a new email/password account
 *
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 *
 * @body {Object} Signup data
 * @body {string} email - User email
 * @body {string} username - Desired username
 * @body {string} password - Plaintext password (8+ chars, mixed case, number, special)
 * @body {boolean} agreedToTerms - Must be true
 * @body {boolean} [receiveEmails] - Email subscription preference
 * @body {string} [gender] - User gender
 * @body {string} [referrer] - Referrer username or user ID
 *
 * @returns {Object} Account creation response
 * @returns {string} userId - New user's unique identifier
 * @returns {string} message - Status message (success or email failure)
 * @returns {boolean} verificationEmailSent - Whether verification email was sent
 * @returns {string|undefined} referrer - Referrer identifier if provided
 * @returns {boolean} referralApplied - Whether referral was successfully applied
 *
 * @example
 * // Request
 * {
 *   "email": "user@example.com",
 *   "username": "johndoe",
 *   "gender": "male",
 *   "password": "SecurePass123!",
 *   "agreedToTerms": true
 * }
 *
 * // Response (201)
 * {
 *   "userId": "user-uuid",
 *   "message": "Account created. Please check your email to verify your account.",
 *   "verificationEmailSent": true,
 *   "referralApplied": false
 * }
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
    res.status(200).json({
      message: 'If account was created, please check your email to verify.',
      verificationEmailSent: false,
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/forgot-password
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/forgot-password
 *
 * Sends a password reset email to the user's registered email address.
 * Always returns success to prevent email enumeration attacks.
 *
 * @route POST /api/auth/forgot-password
 * @description Request password reset email
 *
 * @body {Object} Forgot password data
 * @body {string} email - User's registered email
 *
 * @returns {Object} Response
 * @returns {string} message - Always returns success regardless of email existence
 * @returns {boolean} emailSent - Whether email was actually sent
 *
 * @example
 * // Request
 * { "email": "user@example.com" }
 *
 * // Response (200)
 * {
 *   "message": "If an account exists, you will receive a password reset email.",
 *   "emailSent": true
 * }
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

    let emailSent = false;
    const token = await createPasswordResetToken(email);

    if (token) {
      const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
      emailSent = await sendPasswordResetEmail(email, resetUrl);
    }

    // Always return success — prevents email enumeration
    res.json({
      message: 'Password reset email sent if account exists',
      emailSent,
    });
  } catch (error) {
    console.error('[forgot] ❌ Forgot password error:', error);
    // Still return success to prevent email enumeration
    res.json({
      message: 'Password reset email sent if account exists',
      emailSent: false,
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/reset-password
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/reset-password
 *
 * Resets user password using a valid reset token. Validates password strength
 * and invalidates the token after single use.
 *
 * @route POST /api/auth/reset-password
 * @description Reset password with recovery token
 *
 * @body {string} token - Password reset verification token (expires after 1 hour)
 * @body {string} password - New password (8+ chars, mixed case, number, special)
 *
 * @returns {Object} Status
 * @returns {string} message - Status of the password reset operation
 *
 * @example
 * // Request
 * { "token": "reset-token-uuid", "password": "NewSecurePass456!" }
 *
 * // Response (200)
 * { "message": "Password has been reset successfully." }
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
 * Verifies user email using a verification token. Token expires after
 * 24 hours and is invalidated after single use.
 *
 * @route POST /api/auth/verify-email
 * @description Verify email address with token
 *
 * @body {string} token - Email verification token
 *
 * @returns {Object} Status
 * @returns {string} message - Status of the verification
 *
 * @example
 * // Request
 * { "token": "verification-token-uuid" }
 *
 * // Response (200)
 * { "message": "Email verified successfully" }
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
 * Resends email verification. Always returns success to prevent email enumeration.
 * Rate-limited per IP to prevent abuse.
 *
 * @route POST /api/auth/resend-verification
 * @description Resend email verification link
 *
 * @body {string} email - User's registered email
 *
 * @returns {Object} Status
 * @returns {string} message - Always returns success
 *
 * @example
 * // Request
 * { "email": "user@example.com" }
 *
 * // Response (200)
 * { "message": "If an account exists, a verification email has been sent." }
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

    let emailSent = false;
    const userId = await getUserIdByEmail(email);

    if (userId) {
      const verified = await isEmailVerified(userId);
      if (!verified) {
        const verificationToken = await createEmailVerificationToken(userId);
        const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`;
        emailSent = await sendVerificationEmail(email, verificationUrl);
      }
    }

    res.json({
      message: 'Verification email sent if account exists',
      emailSent,
    });
  } catch (error) {
    console.error('[resendVerification] ❌ Resend verification error:', error);
    res.json({
      message: 'Verification email sent if account exists',
      emailSent: false,
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/logout
 *
 * Placeholder for any backend cleanup on logout. Session clearing is handled
 * entirely by NextAuth on the frontend via signOut().
 *
 * @route POST /api/auth/logout
 * @description Backend logout placeholder (cleanup handled by NextAuth)
 *
 * @returns {Object} Status
 * @returns {string} message - Success message
 *
 * @example
 * // Response (200)
 * { "message": "Logged out successfully" }
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
 * @route POST /api/auth/google-one-tap
 * @description Authenticate with Google One Tap (GIS popup)
 *
 * @body {string} idToken - Google ID token from the GIS One Tap callback
 *
 * @returns {Object} User data for JWT
 * @returns {string} userId - User's unique identifier
 * @returns {string} email - User email
 * @returns {string|null} name - User display name
 * @returns {string} username - User username
 * @returns {string|null} imageUrl - User profile image URL
 * @returns {boolean} isNewUser - Whether onboarding is pending
 *
 * @example
 * // Request
 * { "idToken": "google-id-token" }
 *
 * // Response (200)
 * {
 *   "userId": "user-uuid",
 *   "email": "user@example.com",
 *   "name": "John Doe",
 *   "username": "johndoe",
 *   "imageUrl": "https://ik.imagekit.io/abc123/profile.jpg",
 *   "isNewUser": false
 * }
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
 * @route POST /api/auth/google-oauth
 * @description Authenticate with Google OAuth (standard flow)
 *
 * @body {string} idToken - account.id_token from Auth.js Google OAuth response
 *
 * @returns {Object} User data for JWT
 * @returns {string} userId - User's unique identifier
 * @returns {string} email - User email
 * @returns {string|null} name - User display name
 * @returns {string} username - User username
 * @returns {string|null} imageUrl - User profile image URL
 * @returns {boolean} isNewUser - Whether onboarding is pending
 *
 * @example
 * // Request
 * { "idToken": "google-id-token" }
 *
 * // Response (200)
 * {
 *   "userId": "user-uuid",
 *   "email": "user@example.com",
 *   "name": "John Doe",
 *   "username": "johndoe",
 *   "imageUrl": "https://ik.imagekit.io/abc123/profile.jpg",
 *   "isNewUser": false
 * }
 *
 * // NextAuth jwt() callback usage
 * async jwt({ token, account }) {
 *   if (account?.id_token) {
 *     const res = await fetch(...);
 *     const user = await res.json();
 *     token.isNewUser = user.isNewUser;
 *   }
 *   return token;
 * }
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
 * @route GET /api/auth/sessions
 * @description Get all active login sessions for the signed-in user
 *
 * @returns {Object} Sessions response
 * @returns {Array} sessions - List of active device sessions
 * @returns {number} count - Number of active sessions
 *
 * Response (401): Unauthorized
 *
 * @example
 * // Request
 * GET /api/auth/sessions
 *
 * // Response
 * {
 *   "sessions": [
 *     {
 *       "id": "session123",
 *       "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36...",
 *       "ipAddress": "192.168.1.1",
 *       "deviceName": "Chrome on Windows (Desktop)",
 *       "lastActiveAt": "2024-01-15T10:30:00.000Z",
 *       "createdAt": "2024-01-01T00:00:00.000Z"
 *     }
 *   ],
 *   "count": 3
 * }
 */
router.get('/sessions', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const currentSessionId = req.user?.sessionId;
    const sessions = await getUserSessions(userId, currentSessionId);
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
 * @route POST /api/auth/logout-all
 * @description Sign out from every device except the current one
 *
 * @returns {Object} Logout-all response
 * @returns {string} message - Confirmation message with count
 * @returns {number} deletedCount - Number of other sessions deleted
 *
 * Response (400): No session ID found
 * Response (401): Unauthorized
 *
 * @example
 * // Request
 * POST /api/auth/logout-all
 *
 * // Response
 * {
 *   "message": "Logged out from 2 other device(s)",
 *   "deletedCount": 2
 * }
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
// POST /api/auth/logout-all-devices
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/logout-all-devices
 *
 * Logs out from ALL devices including the current one.
 * Deletes every session for the user and increments tokenVersion to
 * invalidate all existing JWTs, forcing re-login everywhere.
 *
 * @route POST /api/auth/logout-all-devices
 * @description Sign out from every device including this one
 *
 * @returns {Object} Logout-all-devices response
 * @returns {string} message - Confirmation message with count
 * @returns {number} deletedCount - Total number of sessions deleted
 *
 * Response (401): Unauthorized
 *
 * @example
 * // Request
 * POST /api/auth/logout-all-devices
 *
 * // Response
 * {
 *   "message": "Logged out from 3 device(s) — all sessions revoked",
 *   "deletedCount": 3
 * }
 */
router.post('/logout-all-devices', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const deletedCount = await logoutFromAllDevices(userId);

    res.json({
      message: `Logged out from ${deletedCount} device(s) — all sessions revoked`,
      deletedCount,
    });
  } catch (error) {
    console.error('[POST /api/auth/logout-all-devices] ❌ Error logging out from all devices:', error);
    handleApiError(res, 'Failed to logout from all devices', error, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout-session
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/logout-session
 *
 * Logs out from a specific session by ID. Requires authentication.
 *
 * @route POST /api/auth/logout-session
 * @description Logout from a specific device/session
 *
 * @body {string} sessionId - ID of the session to revoke
 *
 * @returns {Object} Logout response
 * @returns {string} message - Confirmation message
 * @returns {number} deletedCount - Number of sessions deleted (0 or 1)
 *
 * @example
 * // Request
 * POST /api/auth/logout-session
 * { "sessionId": "session-uuid" }
 *
 * // Response (200)
 * { "message": "Logged out from device", "deletedCount": 1 }
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

// ---------------------------------------------------------------------------
// DELETE /api/auth/sessions/:id
// ---------------------------------------------------------------------------

/**
 * DELETE /api/auth/sessions/:id
 *
 * Revokes a specific session by ID. Prevents deleting the current session.
 *
 * @route DELETE /api/auth/sessions/:id
 * @description Logout from a specific device/session by session ID
 *
 * @param {string} id - Session ID to revoke (path parameter)
 *
 * @returns 204 No Content on success
 *
 * Response (403): Cannot delete current session
 * Response (404): Session not found
 * Response (401): Unauthorized
 *
 * @example
 * // Request
 * DELETE /api/auth/sessions/session-uuid
 *
 * // Response (204) - No Content
 */
router.delete('/sessions/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const sessionId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const currentSessionId = req.user?.sessionId;

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    if (sessionId === currentSessionId) {
      return res.status(403).json({ error: 'Cannot delete current session' });
    }

    const deleted = await deleteSessionById(userId, sessionId, currentSessionId!);

    if (!deleted) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.status(204).send();
  } catch (error) {
    console.error('[DELETE /api/auth/sessions/:id] ❌ Error deleting session:', error);
    handleApiError(res, 'Failed to delete session', error, 500);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/auth/email
// ---------------------------------------------------------------------------

/**
 * PUT /api/auth/email
 *
 * Changes the authenticated user's email address. Requires current password verification.
 * Resets email verification status for the new address.
 *
 * @route PUT /api/auth/email
 * @description Change user email address
 * @auth Required (requireAuth)
 *
 * @body {string} newEmail - New email address
 * @body {string} currentPassword - Current password for verification
 *
 * @returns {Object} Status
 * @returns {string} message - Success message
 *
 * @throws 400 - Missing fields or invalid email format
 * @throws 401 - Current password is incorrect
 * @throws 409 - New email already in use
 * @throws 429 - Rate limit exceeded
 */
router.put('/email', requireAuth, async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimitByIP(ip)) return handleRateLimitError(res);

    const userId = req.userId!;
    const { newEmail, currentPassword } = req.body;

    if (!newEmail || !currentPassword) {
      return handleValidationError(res, 'New email and current password are required');
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail)) {
      return handleValidationError(res, 'Invalid email format');
    }

    const [user] = await dbRead
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    if (!user) return handleUnauthorizedError(res, 'User not found');

    if (!user.passwordHash) {
      return handleUnauthorizedError(res, 'This account uses OAuth login. Cannot change email.');
    }

    const isValid = await verifyPassword(currentPassword, user.passwordHash);
    if (!isValid) {
      return handleUnauthorizedError(res, 'Current password is incorrect');
    }

    const sanitizedEmail = newEmail.toLowerCase().trim();

    const [emailConflict] = await dbRead
      .select({ userId: users.userId })
      .from(users)
      .where(eq(users.email, sanitizedEmail))
      .limit(1);

    if (emailConflict) {
      return res.status(409).json({ error: 'Email already in use' });
    }

    const now = new Date();
    await dbWrite
      .update(users)
      .set({ email: sanitizedEmail, updatedAt: now })
      .where(eq(users.userId, userId));

    await dbWrite
      .update(userAuth)
      .set({ emailVerified: null, updatedAt: now })
      .where(eq(userAuth.userId, userId));

    res.json({ message: 'Email updated successfully' });
  } catch (error) {
    console.error('[PUT /api/auth/email] ❌', error);
    handleApiError(res, 'Failed to update email', error);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/auth/password
// ---------------------------------------------------------------------------

/**
 * PUT /api/auth/password
 *
 * Changes the authenticated user's password. Requires current password verification.
 * Resets failed login attempts and lockout status on success.
 *
 * @route PUT /api/auth/password
 * @description Change user password
 * @auth Required (requireAuth)
 *
 * @body {string} currentPassword - Current password for verification
 * @body {string} newPassword - New password (8+ chars, mixed case, number, special)
 *
 * @returns {Object} Status
 * @returns {string} message - Success message
 *
 * @throws 400 - Missing fields
 * @throws 401 - Current password is incorrect
 * @throws 422 - New password does not meet security requirements
 * @throws 429 - Rate limit exceeded
 */
router.put('/password', requireAuth, async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimitByIP(ip)) return handleRateLimitError(res);

    const userId = req.userId!;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return handleValidationError(res, 'Current password and new password are required');
    }

    const passwordValidation = validatePasswordStrength(newPassword);
    if (!passwordValidation.valid) {
      return res.status(422).json({
        error: 'Password does not meet security requirements',
        details: passwordValidation.errors,
      });
    }

    const [user] = await dbRead
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    if (!user) return handleUnauthorizedError(res, 'User not found');

    if (!user.passwordHash) {
      return handleUnauthorizedError(res, 'This account uses OAuth login. Cannot change password.');
    }

    const isValid = await verifyPassword(currentPassword, user.passwordHash);
    if (!isValid) {
      return handleUnauthorizedError(res, 'Current password is incorrect');
    }

    const newPasswordHash = await hashPassword(newPassword);
    const now = new Date();

    await dbWrite
      .update(users)
      .set({ passwordHash: newPasswordHash, updatedAt: now })
      .where(eq(users.userId, userId));

    await dbWrite
      .update(userAuth)
      .set({ failedLoginAttempts: 0, lockUntil: null, updatedAt: now })
      .where(eq(userAuth.userId, userId));

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('[PUT /api/auth/password] ❌', error);
    handleApiError(res, 'Failed to update password', error);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/auth/username
// ---------------------------------------------------------------------------

/**
 * PUT /api/auth/username
 *
 * Changes the authenticated user's username. Validates format and checks uniqueness.
 *
 * @route PUT /api/auth/username
 * @description Change user username
 * @auth Required (requireAuth)
 *
 * @body {string} newUsername - New username (3-30 chars, lowercase letters, numbers, hyphens)
 *
 * @returns {Object} Status
 * @returns {string} message - Success message
 *
 * @throws 400 - Missing or invalid username format
 * @throws 409 - Username already taken
 * @throws 429 - Rate limit exceeded
 */
router.put('/username', requireAuth, async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimitByIP(ip)) return handleRateLimitError(res);

    const userId = req.userId!;
    const { newUsername } = req.body;

    if (!newUsername) {
      return handleValidationError(res, 'New username is required');
    }

    const sanitized = (typeof newUsername === 'string' ? newUsername.trim().toLowerCase() : '');

    const validation = validateUsername(sanitized);
    if (!validation.valid) {
      return res.status(422).json({
        error: 'Invalid username',
        details: validation.errors,
      });
    }

    const [usernameConflict] = await dbRead
      .select({ userId: users.userId })
      .from(users)
      .where(and(eq(users.username, sanitized), ne(users.userId, userId)))
      .limit(1);

    if (usernameConflict) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const now = new Date();
    await dbWrite
      .update(users)
      .set({ username: sanitized, updatedAt: now })
      .where(eq(users.userId, userId));

    res.json({ message: 'Username updated successfully' });
  } catch (error) {
    console.error('[PUT /api/auth/username] ❌', error);
    handleApiError(res, 'Failed to update username', error);
  }
});

export default router;