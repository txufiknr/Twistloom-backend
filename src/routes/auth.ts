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
import { dbRead } from '../db/client.js';
import { users } from '../db/schema.js';
import { eq, or } from 'drizzle-orm';
import { verifyPassword } from '../utils/password.js';
import { handleUnauthorizedError, handleApiError } from '../utils/error.js';
import { checkRateLimitByIP } from '../middleware/rate-limit.js';

const router = Router();

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
      return res.status(400).json({ error: 'Email/username and password are required' });
    }

    // Find user by email or username
    const user = await dbRead
      .select({
        userId: users.userId,
        email: users.email,
        username: users.username,
        name: users.name,
        image: users.image,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(
        or(
          eq(users.email, emailOrUsername),
          eq(users.username, emailOrUsername)
        )
      )
      .limit(1);

    if (user.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const userData = user[0];

    // Check if user has password (OAuth-only users won't have passwordHash)
    if (!userData.passwordHash) {
      return res.status(401).json({ error: 'This account uses OAuth login. Please sign in with Google.' });
    }

    // Verify password
    const isValid = await verifyPassword(password, userData.passwordHash);

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Return user data for NextAuth (exclude passwordHash)
    res.json({
      userId: userData.userId,
      email: userData.email,
      name: userData.name,
      image: userData.image,
    });
  } catch (error) {
    console.error('Credential verification error:', error);
    handleApiError(res, 'Failed to verify credentials', error, 500);
  }
});

export default router;
