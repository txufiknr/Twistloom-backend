/**
 * Authentication Routes
 * 
 * Provides credential verification endpoint for NextAuth Credentials provider.
 * 
 * Architecture:
 * - NextAuth v5 handles session creation (both Google OAuth and Email/Password)
 * - Backend only verifies credentials and returns user data
 * - NextAuth creates the session cookie after successful verification
 * 
 * Flow:
 * 1. Frontend calls NextAuth signIn('credentials', { email, password })
 * 2. NextAuth Credentials provider calls POST /api/auth/verify-credentials
 * 3. Backend verifies email/password and returns user data
 * 4. NextAuth creates session cookie with user ID
 * 5. Browser sends cookie on subsequent requests
 * 6. Backend verifies JWT cookie using verifyNextAuthToken()
 */

import { Router } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { dbRead, dbWrite } from '../db/client.js';
import { users, userAuth } from '../db/schema.js';
import { eq, or } from 'drizzle-orm';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { validatePasswordStrength } from '../utils/password-validation.js';
import { checkAccountLockout, recordFailedLogin, resetFailedLoginAttempts } from '../utils/account-lockout.js';
import { createPasswordResetToken, resetPassword, verifyPasswordResetToken } from '../utils/password-reset.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../utils/email.js';
import { createEmailVerificationToken, verifyEmailToken, isEmailVerified } from '../utils/email-verification.js';
import { handleApiError, handleUnauthorizedError, handleValidationError } from '../utils/error.js';
import { checkRateLimitByIP } from '../middleware/rate-limit.js';
import { generateId } from '../utils/uuid.js';
import { createOrUpdateOAuthUser, setReferrerForNewUser } from '../services/user-controller.js';
import { isTemp as isTemporaryEmail } from 'tempmail-checker';
import { requireAuth } from '../middleware/nextauth.js';
import { getUserSessions, logoutFromSpecificDevice, logoutFromAllOtherDevices } from '../services/session-manager.js';
import { getUserForAuth, getUserIdByEmail } from '../services/user.js';
import type { Request, Response } from "express";
import type { DBUserForAuth } from '../types/schema.js';

const router = Router();

// Google OAuth client for token verification
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * POST /api/auth/verify-credentials
 * 
 * Verifies email/username and password credentials for NextAuth Credentials provider.
 * 
 * Request Body:
 * {
 *   emailOrUsername: string; // Email or username
 *   password: string;        // Plaintext password
 * }
 * 
 * Response (Success - 200):
 * {
 *   userId: string;   // User ID for NextAuth session
 *   email: string;    // User email
 *   name: string;     // User display name
 *   username: string; // User username
 *   image?: string;   // Profile image URL
 * }
 * 
 * Response (Error - 401):
 * {
 *   error: string;    // Error message
 * }
 * 
 * Security:
 * - Rate limited to prevent brute force attacks
 * - Uses bcrypt for password verification
 * - Returns minimal user data (no sensitive info)
 * 
 * @example
 * // NextAuth Credentials provider usage
 * credentials: {
 *   async authorize(credentials) {
 *     const res = await fetch(`${process.env.BACKEND_URL}/api/auth/verify-credentials`, {
 *       method: 'POST',
 *       headers: { 'Content-Type': 'application/json' },
 *       body: JSON.stringify({
 *         emailOrUsername: credentials.email,
 *         password: credentials.password,
 *       }),
 *     });
 *     
 *     if (!res.ok) return null;
 *     
 *     const user = await res.json();
 *     return user;
 *   }
 * }
 */
router.post('/verify-credentials', async (req, res) => {
  try {
    // Rate limiting based on IP address (prevents brute force attacks)
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimitByIP(ip)) {
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }

    const { emailOrUsername, password } = req.body;

    // Validate input
    if (!emailOrUsername || !password) {
      return handleValidationError(res, 'Email/username and password are required');
    }

    // Find user by email or username
    const userData = await getUserForAuth(emailOrUsername);
    if (!userData) {
      return handleUnauthorizedError(res, 'Invalid credentials');
    }

    // Check if account is locked
    const lockoutStatus = await checkAccountLockout(userData.userId);
    if (lockoutStatus.isLocked) {
      if (lockoutStatus.remainingTime === undefined) {
        // Fallback: unlock account if state is inconsistent
        await resetFailedLoginAttempts(userData.userId);
        return res.status(429).json({ error: 'Account lock state inconsistent. Please try again.' });
      }
      const minutesRemaining = Math.ceil(lockoutStatus.remainingTime / 60000);
      return res.status(429).json({ 
        error: `Account locked. Try again in ${minutesRemaining} minutes.`,
        lockedUntil: new Date(Date.now() + lockoutStatus.remainingTime).toISOString()
      });
    }

    // Check if user has password (OAuth-only users won't have passwordHash)
    if (!userData.passwordHash) {
      return handleUnauthorizedError(res, 'This account uses OAuth login. Please sign in with Google.');
    }

    // Verify password
    const isValid = await verifyPassword(password, userData.passwordHash);
    if (!isValid) {
      await recordFailedLogin(userData.userId);
      return handleUnauthorizedError(res, 'Invalid credentials');
    }

    // Reset failed login attempts on successful login
    await resetFailedLoginAttempts(userData.userId);

    // Return user data for NextAuth (exclude passwordHash)
    res.json({
      userId: userData.userId,
      email: userData.email,
      name: userData.name,
      username: userData.username,
      image: userData.image,
    } satisfies Omit<DBUserForAuth, 'passwordHash'>);
  } catch (error) {
    console.error('[POST /api/auth/verify-credentials] ❌ Credential verification error:', error);
    handleApiError(res, 'Failed to verify credentials', error, 500);
  }
});

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
 * }
 * 
 * Response (Success - 201):
 * {
 *   userId: string;
 * }
 * 
 * Response (Error - 400): Invalid input
 * Response (Error - 409): Email or username already exists
 * Response (Error - 429): Too many requests (rate limiting)
 * Response (Error - 500): Server error
 * 
 * Security:
 * - Rate limited to prevent abuse
 * - Password is hashed using bcrypt
 * - Email and username must be unique
 * 
 * @example
 * // Frontend usage
 * const res = await fetch('/api/auth/signup', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({
 *     email: 'user@example.com',
 *     username: 'johndoe',
 *     gender: 'male',
 *     password: 'securePassword123',
 *     receiveEmails: true,
 *     agreedToTerms: true,
 *   }),
 * });
 */
router.post('/signup', async (req, res) => {
  try {
    // Rate limiting based on IP address
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimitByIP(ip)) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    const { email, username, gender, password, receiveEmails: _receiveEmails, agreedToTerms, referrer } = req.body;

    // Validate input
    if (!email || !username || !password || !gender) {
      return handleValidationError(res, 'Email, username, password, and gender are required');
    }

    if (!agreedToTerms) {
      return handleValidationError(res, 'You must agree to the terms');
    }

    // TODO: validate username
    // Standard Validation Rules
    // Length Constraints: Between 3 and 30 characters.
    // Character Restrictions: Only allow alphanumeric characters (a-z, 0-9) and hyphens (-).
    // No Spaces: Cannot contain spaces.
    // Uniqueness: The username must not already exist in the database.
    
    // Security Rules
    // Reserved Words: Don't allow restricted words (e.g., "admin," "support," "root") to prevent impersonation.
    // Case Insensitivity: Treat "Username" and "username" as the same to prevent account duplication.
    // Input Sanitization: Sanitize inputs to prevent Cross-Site Scripting (XSS) and SQL injection attacks.
    
    // Validate password strength
    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.valid) {
      return res.status(422).json({ 
        error: 'Password does not meet security requirements',
        details: passwordValidation.errors 
      });
    }

    // Block temporary/disposable email addresses
    if (isTemporaryEmail(email)) {
      return handleValidationError(res, 'Temporary or disposable email addresses are not allowed.', undefined, 422);
    }

    // Check if email or username already exists
    const existing = await dbRead
      .select({ userId: users.userId })
      .from(users)
      .where(or(eq(users.email, email), eq(users.username, username)))
      .limit(1);

    if (existing && existing.length > 0) {
      return res.status(409).json({ error: 'Email or username already exists' });
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Use database transaction for atomic user and user_auth record creation
    // TODO: sanitize text for db
    const newUser = await dbWrite.transaction(async (tx) => {
      // Create user record
      const [userRecord] = await tx.insert(users).values({
        userId: generateId(),
        email,
        username,
        passwordHash,
        gender,
      }).returning();

      // Create user_auth record
      await tx.insert(userAuth).values({
        userId: userRecord.userId,
      });

      return userRecord;
    });

    // Create email verification token
    const verificationToken = await createEmailVerificationToken(newUser.userId);

    // Send verification email (non-blocking - log error if fails)
    const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`;
    const verificationEmailSent = await sendVerificationEmail(email, verificationUrl);

    // If a referrer username was provided at signup, attempt to set it.
    let referralApplied = false;
    if (referrer && typeof referrer === 'string') {
      referralApplied = await setReferrerForNewUser(req, res, newUser.userId, referrer, { handleResponse: false });
    }

    res.status(201).json({
      userId: newUser.userId,
      message: verificationEmailSent ? 'Account created. Please check your email to verify your account.' : 'Account created. Verification email failed to send.',
      verificationEmailSent,
      referrer,
      referralApplied,
    });
  } catch (error) {
    console.error('[signup] ❌ Sign up error:', error);
    handleApiError(res, 'Failed to create account', error);
  }
});

/**
 * POST /api/auth/forgot-password
 * 
 * Requests a password reset email for the user.
 * 
 * Request Body:
 * {
 *   email: string;
 * }
 * 
 * Response (Success - 200):
 * {
 *   message: "Password reset email sent";
 * }
 * 
 * Response (Error - 400): Invalid email format
 * Response (Error - 404): Email not found
 * Response (Error - 429): Too many requests (rate limiting)
 * Response (Error - 500): Server error
 * 
 * Security:
 * - Rate limited to prevent email spam
 * - Always returns success for existing emails (prevents email enumeration)
 * - Sends reset link via email (not implemented yet - placeholder)
 * 
 * @note
 * This is a placeholder implementation. The actual email sending logic
 * needs to be implemented with an email service (e.g., Resend, SendGrid).
 * 
 * @example
 * // Frontend usage
 * const res = await fetch('/api/auth/forgot-password', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ email: 'user@example.com' }),
 * });
 */
router.post('/forgot-password', async (req, res) => {
  try {
    // Rate limiting based on IP address
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimitByIP(ip)) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    const { email } = req.body;

    // Validate input
    if (!email) {
      return handleValidationError(res, 'Email is required');
    }

    // Create password reset token (returns null if email doesn't exist)
    const token = await createPasswordResetToken(email);

    // Only send email if user exists
    if (token) {
      const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
      await sendPasswordResetEmail(email, resetUrl);
    }

    // Always return success (prevents email enumeration)
    res.json({ message: 'Password reset email sent if account exists' });
  } catch (error) {
    console.error('[forgot] ❌ Forgot password error:', error);
    handleApiError(res, 'Failed to process request', error, 500);
  }
});

/**
 * POST /api/auth/reset-password
 * 
 * Resets user password using a valid reset token.
 * 
 * Request Body:
 * {
 *   token: string;      // Password reset token from email
 *   password: string;   // New password
 * }
 * 
 * Response (Success - 200):
 * {
 *   message: "Password reset successfully"
 * }
 * 
 * Response (Error - 400): Invalid token or weak password
 * Response (Error - 429): Too many requests (rate limiting)
 * Response (Error - 500): Server error
 * 
 * Security:
 * - Rate limited to prevent abuse
 * - Validates password strength
 * - Token expires after 1 hour
 * - Resets failed login attempts on success
 * 
 * @example
 * // Frontend usage
 * const res = await fetch('/api/auth/reset-password', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({
 *     token: 'reset-token-from-email',
 *     password: 'NewSecurePassword123!',
 *   }),
 * });
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

    // Validate password strength
    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.valid) {
      return res.status(422).json({ 
        error: 'Password does not meet security requirements',
        details: passwordValidation.errors 
      });
    }

    // Verify token exists before password validation (prevents token enumeration)
    const userId = await verifyPasswordResetToken(token);
    if (!userId) {
      return handleValidationError(res, 'Invalid or expired reset token');
    }

    // Reset password
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

/**
 * POST /api/auth/verify-email
 * 
 * Verifies user email using a verification token.
 * 
 * Request Body:
 * {
 *   token: string;  // Email verification token
 * }
 * 
 * Response (Success - 200):
 * {
 *   message: "Email verified successfully"
 * }
 * 
 * Response (Error - 400): Invalid or expired token
 * Response (Error - 500): Server error
 * 
 * Security:
 * - Token expires after 24 hours
 * - Token can only be used once
 * 
 * @example
 * // Frontend usage
 * const res = await fetch('/api/auth/verify-email', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ token: 'verification-token-from-email' }),
 * });
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

/**
 * POST /api/auth/resend-verification
 * 
 * Resends email verification token for a user.
 * 
 * Request Body:
 * {
 *   email: string;  // User email address
 * }
 * 
 * Response (Success - 200):
 * {
 *   message: "Verification email sent"
 * }
 * 
 * Response (Error - 400): Invalid email or already verified
 * Response (Error - 500): Server error
 * 
 * Security:
 * - Rate limited to prevent abuse
 * - Always returns success (prevents email enumeration)
 * 
 * @example
 * // Frontend usage
 * const res = await fetch('/api/auth/resend-verification', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ email: 'user@example.com' }),
 * });
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

    // Find user by email
    const userId = await getUserIdByEmail(email);

    if (!userId) {
      // Always return success (prevents email enumeration)
      res.json({ message: 'Verification email sent if account exists' });
      return;
    }

    // Check if email is already verified
    const verified = await isEmailVerified(userId);
    if (verified) {
      // Return success to prevent email enumeration
      res.json({ message: 'Verification email sent if account exists' });
      return;
    }

    // Create new verification token
    const verificationToken = await createEmailVerificationToken(userId);

    // Send verification email
    const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`;
    await sendVerificationEmail(email, verificationUrl);

    res.json({ message: 'Verification email sent' });
  } catch (error) {
    console.error('[resendVerification] ❌ Resend verification error:', error);
    handleApiError(res, 'Failed to resend verification email', error, 500);
  }
});

/**
 * POST /api/auth/logout
 * 
 * Logs out the current user by clearing the NextAuth session.
 * 
 * Request Body: None
 * 
 * Response (Success - 200):
 * {
 *   message: "Logged out successfully";
 * }
 * 
 * Security:
 * - NextAuth handles actual session clearing on the frontend
 * - This endpoint is for any backend cleanup if needed
 * 
 * @note
 * With NextAuth, logout is primarily handled on the frontend via:
 * await signOut({ callbackUrl: '/' });
 * 
 * This backend endpoint is provided for future extensibility
 * (e.g., invalidating refresh tokens, logging logout events, etc.)
 * 
 * @example
 * // Frontend usage (primary method)
 * import { signOut } from 'next-auth/react';
 * await signOut({ callbackUrl: '/' });
 * 
 * // Backend endpoint (if needed for cleanup)
 * await fetch('/api/auth/logout', { method: 'POST' });
 */
router.post('/logout', async (req, res) => {
  try {
    // NextAuth handles session clearing on the frontend
    // This endpoint is for any backend cleanup if needed
    
    // TODO: Add any backend cleanup logic here
    // - Invalidate refresh tokens (if implemented)
    // - Log logout event for analytics
    // - Clear server-side session data
    
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    handleApiError(res, 'Failed to logout', error, 500);
  }
});

/**
 * POST /api/auth/google-one-tap
 *
 * Verifies Google ID token from Google One Tap Sign-In and creates/updates user.
 *
 * This endpoint is used by the NextAuth Credentials provider for Google One Tap authentication.
 * The frontend sends a Google ID token, which the backend verifies and uses to create or update
 * the user account.
 *
 * Request Body:
 * {
 *   idToken: string;  // Google ID token from GIS One Tap
 * }
 *
 * Response (Success - 200):
 * {
 *   userId: string;   // User ID for NextAuth session
 *   email: string;    // User email
 *   name: string;     // User display name
 *   username: string; // User username (null for OAuth-only users)
 *   image?: string;   // Profile image URL from Google
 * }
 *
 * Response (Error - 400): Invalid token
 * Response (Error - 401): Token verification failed
 * Response (Error - 500): Server error
 *
 * Security:
 * - Verifies Google ID token signature and audience
 * - Extracts user info from verified token payload
 * - Creates user_auth record for new users
 * - Rate limited to prevent abuse
 *
 * @example
 * // NextAuth Credentials provider usage
 * Credentials({
 *   id: 'googleonetap',
 *   name: 'Google One Tap',
 *   credentials: {
 *     credential: { label: 'Credential', type: 'text' },
 *   },
 *   async authorize(credentials) {
 *     const res = await fetch(`${process.env.BACKEND_URL}/api/auth/google-one-tap`, {
 *       method: 'POST',
 *       headers: { 'Content-Type': 'application/json' },
 *       body: JSON.stringify({ idToken: credentials.credential }),
 *     });
 *
 *     if (!res.ok) return null;
 *
 *     const user = await res.json();
 *     return user;
 *   }
 * })
 */
router.post('/google-one-tap', async (req, res) => {
  try {
    // Rate limiting based on IP address
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimitByIP(ip)) {
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }

    const { idToken } = req.body;

    // Validate input
    if (!idToken) {
      return handleValidationError(res, 'ID token is required');
    }

    // Verify Google ID token
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return handleUnauthorizedError(res, 'Invalid token payload');
    }

    const { email, name, picture: image } = payload;

    // Create or update user from OAuth data
    const userId = await createOrUpdateOAuthUser(email, name, image);

    // Fetch user data for NextAuth session
    const user = await dbRead
      .select({
        userId: users.userId,
        email: users.email,
        name: users.name,
        username: users.username,
        image: users.image,
      })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    if (user.length === 0) {
      return handleApiError(res, 'Failed to retrieve user data');
    }

    // Return user data for NextAuth session
    res.json({
      userId: user[0].userId,
      email: user[0].email,
      name: user[0].name,
      username: user[0].username,
      image: user[0].image,
    });
  } catch (error) {
    console.error('[POST /api/auth/google-one-tap] ❌ Google One Tap error:', error);
    handleApiError(res, 'Failed to authenticate with Google One Tap', error);
  }
});

/**
 * GET /api/auth/sessions
 * 
 * Get all active sessions for the authenticated user.
 * 
 * Response (Success - 200):
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
 * Response (Error - 401): Unauthorized
 * Response (Error - 500): Server error
 * 
 * Security:
 * - Requires authentication via requireAuth middleware
 * - Returns only sessions belonging to the authenticated user
 * 
 * @example
 * // Frontend usage
 * const res = await fetch('/api/auth/sessions');
 * const data = await res.json();
 * console.log(`User has ${data.count} active sessions`);
 */
router.get('/sessions', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const sessions = await getUserSessions(userId);

    res.json({
      sessions,
      count: sessions.length,
    });
  } catch (error) {
    console.error('[GET /api/auth/sessions] ❌ Error fetching sessions:', error);
    handleApiError(res, 'Failed to fetch sessions', error, 500);
  }
});

/**
 * POST /api/auth/logout-all
 * 
 * Logout from all other devices (exclude current session).
 * 
 * Request Body: None (uses current session from JWT)
 * 
 * Response (Success - 200):
 * {
 *   message: "Logged out from X other device(s)";
 *   deletedCount: number;
 * }
 * 
 * Response (Error - 400): No session ID found
 * Response (Error - 401): Unauthorized
 * Response (Error - 500): Server error
 * 
 * Security:
 * - Requires authentication via requireAuth middleware
 * - Excludes current session from deletion
 * - Only affects sessions belonging to the authenticated user
 * 
 * @example
 * // Frontend usage
 * const res = await fetch('/api/auth/logout-all', { method: 'POST' });
 * const data = await res.json();
 * console.log(data.message);
 */
router.post('/logout-all', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const currentSessionId = req.user?.sessionId; // From JWT token

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

/**
 * POST /api/auth/logout-session
 * 
 * Logout from a specific session.
 * 
 * Request Body:
 * {
 *   sessionId: string;  // The session ID to delete
 * }
 * 
 * Response (Success - 200):
 * {
 *   message: "Logged out from device";
 *   deletedCount: number;
 * }
 * 
 * Response (Error - 400): sessionId is required
 * Response (Error - 401): Unauthorized
 * Response (Error - 404): Session not found
 * Response (Error - 500): Server error
 * 
 * Security:
 * - Requires authentication via requireAuth middleware
 * - Only allows deleting sessions belonging to the authenticated user
 * 
 * @example
 * // Frontend usage
 * const res = await fetch('/api/auth/logout-session', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ sessionId: 'session123' }),
 * });
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

    res.json({
      message: 'Logged out from device',
      deletedCount,
    });
  } catch (error) {
    console.error('[POST /api/auth/logout-session] ❌ Error logging out from session:', error);
    handleApiError(res, 'Failed to logout from session', error, 500);
  }
});

export default router;
