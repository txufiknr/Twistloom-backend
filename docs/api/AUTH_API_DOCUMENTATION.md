# Authentication API Documentation

## Overview

The Authentication API provides endpoints for user registration, credential verification, password management, and email verification. This API works in conjunction with NextAuth v5 to provide a complete authentication solution supporting both Google OAuth and Email/Password authentication methods.

**Base URL:** `/api/auth`

**Authentication:** Most endpoints are public (no authentication required) for signup/login flows. Protected endpoints use NextAuth JWT cookies.

**Architecture:** 
- NextAuth v5 handles session creation and cookie management
- Backend validates credentials and manages user data
- Email/Password and Google OAuth authentication methods supported

---

## Table of Contents

1. [Credential Verification](#credential-verification)
   - [Verify Credentials](#post-apiauthverify-credentials)
2. [User Registration](#user-registration)
   - [Sign Up](#post-apiauthsignup)
3. [Password Management](#password-management)
   - [Forgot Password](#post-apiauthforgot-password)
   - [Reset Password](#post-apiauthreset-password)
4. [Email Verification](#email-verification)
   - [Verify Email](#post-apiauthverify-email)
   - [Resend Verification](#post-apiauthresend-verification)
5. [Session Management](#session-management)
   - [Logout](#post-apiauthlogout)

---

## Credential Verification

### POST /api/auth/verify-credentials

Verifies email/username and password credentials for NextAuth Credentials provider. This endpoint is called by NextAuth during the authentication flow.

**Authentication:** Not required (public endpoint)

**Rate Limiting:** IP-based rate limiting to prevent brute force attacks

**Request Body:**
```json
{
  "emailOrUsername": "string", // Email or username
  "password": "string"        // Plaintext password
}
```

**Response (200 OK):**
```json
{
  "userId": "user-uuid",
  "email": "user@example.com",
  "name": "John Doe",
  "username": "johndoe",
  "image": "https://ik.imagekit.io/abc123/profile.jpg"
}
```

**Error Responses:**
- `400 Bad Request`: Email/username and password are required
- `401 Unauthorized`: Invalid credentials or account uses OAuth
- `429 Too Many Requests`: Account locked or rate limit exceeded
  ```json
  {
    "error": "Account locked. Try again in 5 minutes.",
    "lockedUntil": "2023-01-01T12:05:00.000Z"
  }
  ```
- `500 Internal Server Error`: Server error

**Security Features:**
- IP-based rate limiting to prevent brute force attacks
- Account lockout mechanism with exponential backoff (5→15→60 minutes)
- Bcrypt password verification (12 salt rounds)
- Returns minimal user data (no sensitive information)
- Checks for account lockout before password verification

**Account Lockout Thresholds:**
- 5 failed attempts: 5-minute lockout
- 10 failed attempts: 15-minute lockout
- 15 failed attempts: 1-hour lockout

**Example:**
```bash
curl -X POST http://localhost:3000/api/auth/verify-credentials \
  -H "Content-Type: application/json" \
  -d '{
    "emailOrUsername": "user@example.com",
    "password": "securePassword123"
  }'
```

---

## User Registration

### POST /api/auth/signup

Registers a new user account with email/password authentication. Creates both user profile and authentication records, sends email verification.

**Authentication:** Not required (public endpoint)

**Rate Limiting:** IP-based rate limiting to prevent abuse

**Request Body:**
```json
{
  "email": "string",           // User email (required)
  "username": "string",        // Username (required)
  "gender": "string",          // Gender: male/female/other (required)
  "password": "string",        // Plaintext password (required)
  "receiveEmails": boolean,    // Email subscription preference (optional)
  "agreedToTerms": boolean     // Terms agreement (required)
}
```

**Password Requirements:**
- Minimum 8 characters, maximum 128 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one number
- At least one special character
- Cannot be an exact match of common passwords (password, 123456, qwerty, etc.)

**Response (201 Created):**
```json
{
  "userId": "user-uuid",
  "message": "Account created. Please check your email to verify your account.",
  "emailSent": true
}
```

**Error Responses:**
- `400 Bad Request`: Invalid input, weak password, or terms not agreed
  ```json
  {
    "error": "Password does not meet security requirements",
    "details": ["Password must be at least 8 characters long", "Password must contain at least one uppercase letter"]
  }
  ```
- `409 Conflict`: Email or username already exists
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server error

**Security Features:**
- IP-based rate limiting
- Password strength validation
- Bcrypt password hashing (12 salt rounds)
- Email and username uniqueness enforced
- Separate `user_auth` table for authentication data (GDPR compliance)

**Database Operations:**
1. Creates user record in `users` table
2. Creates corresponding record in `user_auth` table
3. Generates email verification token (24 hour expiry)
4. Sends verification email via Resend

**Environment Variables Required:**
- `FRONTEND_URL`: Frontend URL for email links
- `RESEND_API_KEY`: Resend API key for email sending
- `RESEND_FROM_EMAIL`: Sender email address

**Example:**
```bash
curl -X POST http://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "username": "johndoe",
    "gender": "male",
    "password": "SecurePass123!",
    "receiveEmails": true,
    "agreedToTerms": true
  }'
```

---

## Password Management

### POST /api/auth/forgot-password

Initiates password reset flow by generating a secure token and sending a password reset email.

**Authentication:** Not required (public endpoint)

**Rate Limiting:** IP-based rate limiting to prevent email spam

**Request Body:**
```json
{
  "email": "string"  // User email address
}
```

**Response (200 OK):**
```json
{
  "message": "Password reset email sent if account exists"
}
```

**Error Responses:**
- `400 Bad Request`: Email is required
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server error

**Security Features:**
- IP-based rate limiting
- Email enumeration prevention (always returns success)
- Secure token generation (random UUID)
- Token expires after 1 hour
- One-time use token

**Email Template:**
The email contains a reset link in the format:
```
{FRONTEND_URL}/reset-password?token={reset_token}
```

**Database Operations:**
1. Finds user by email in `users` table
2. Generates password reset token in `user_auth` table
3. Sends reset email via Resend

**Environment Variables Required:**
- `FRONTEND_URL`: Frontend URL for email links
- `RESEND_API_KEY`: Resend API key
- `RESEND_FROM_EMAIL`: Sender email address

**Example:**
```bash
curl -X POST http://localhost:3000/api/auth/forgot-password \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com"
  }'
```

---

### POST /api/auth/reset-password

Resets user password using a valid reset token. Validates token, password strength, and updates password.

**Authentication:** Not required (public endpoint)

**Rate Limiting:** IP-based rate limiting to prevent abuse

**Request Body:**
```json
{
  "token": "string",    // Password reset token from email
  "password": "string"  // New password
}
```

**Password Requirements:** Same as signup endpoint

**Response (200 OK):**
```json
{
  "message": "Password reset successfully"
}
```

**Error Responses:**
- `400 Bad Request`: Token and password required, invalid/expired token, or weak password
  ```json
  {
    "error": "Password does not meet security requirements",
    "details": ["Password must be at least 8 characters long"]
  }
  ```
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server error

**Security Features:**
- IP-based rate limiting
- Token validation (checks expiry and existence)
- Password strength validation
- Token is single-use (revoked after use)
- Resets failed login attempts on success
- Clears lockout status on success

**Database Operations:**
1. Verifies token in `user_auth` table
2. Validates token expiry
3. Hashes new password with bcrypt
4. Updates `users.password_hash`
5. Clears reset token and lockout in `user_auth` table

**Example:**
```bash
curl -X POST http://localhost:3000/api/auth/reset-password \
  -H "Content-Type: application/json" \
  -d '{
    "token": "reset-token-from-email",
    "password": "NewSecurePass123!"
  }'
```

---

## Email Verification

### POST /api/auth/verify-email

Verifies user email using a verification token sent during signup.

**Authentication:** Not required (public endpoint)

**Request Body:**
```json
{
  "token": "string"  // Email verification token
}
```

**Response (200 OK):**
```json
{
  "message": "Email verified successfully"
}
```

**Error Responses:**
- `400 Bad Request`: Token is required or invalid/expired
- `500 Internal Server Error`: Server error

**Security Features:**
- Token expires after 24 hours
- Token is single-use (revoked after verification)
- Token validation prevents replay attacks

**Database Operations:**
1. Verifies token in `user_auth` table
2. Validates token expiry
3. Sets `email_verified` timestamp
4. Clears `email_verification_token` and `email_verification_expires`

**Example:**
```bash
curl -X POST http://localhost:3000/api/auth/verify-email \
  -H "Content-Type: application/json" \
  -d '{
    "token": "verification-token-from-email"
  }'
```

---

### POST /api/auth/resend-verification

Resends email verification token for users who didn't receive or lost their verification email.

**Authentication:** Not required (public endpoint)

**Rate Limiting:** IP-based rate limiting to prevent abuse

**Request Body:**
```json
{
  "email": "string"  // User email address
}
```

**Response (200 OK):**
```json
{
  "message": "Verification email sent"
}
```

**Error Responses:**
- `400 Bad Request`: Email is required or email already verified
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server error

**Security Features:**
- IP-based rate limiting
- Email enumeration prevention (always returns success)
- Checks if email is already verified before sending
- Generates new token (invalidates old token)

**Database Operations:**
1. Finds user by email in `users` table
2. Checks if email is already verified in `user_auth` table
3. Generates new verification token in `user_auth` table
4. Sends verification email via Resend

**Environment Variables Required:**
- `FRONTEND_URL`: Frontend URL for email links
- `RESEND_API_KEY`: Resend API key
- `RESEND_FROM_EMAIL`: Sender email address

**Example:**
```bash
curl -X POST http://localhost:3000/api/auth/resend-verification \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com"
  }'
```

---

## Session Management

### POST /api/auth/logout

Logs out the current user by clearing the NextAuth session. Currently a placeholder for future extensibility.

**Authentication:** Not required (public endpoint, but typically called by authenticated users)

**Request Body:** None

**Response (200 OK):**
```json
{
  "message": "Logged out successfully"
}
```

**Error Responses:**
- `500 Internal Server Error`: Server error

**Note:** NextAuth handles the actual session clearing on the frontend via `signOut()`. This backend endpoint is provided for future extensibility such as:
- Invalidating refresh tokens (if implemented)
- Logging logout events for analytics
- Clearing server-side session data
- Revoking all user sessions

**Frontend Usage (Primary Method):**
```javascript
import { signOut } from 'next-auth/react';
await signOut({ callbackUrl: '/' });
```

**Backend Usage (If Needed for Cleanup):**
```bash
curl -X POST http://localhost:3000/api/auth/logout
```

---

## Security Architecture

### Database Schema

**users table:** Stores user profile information
- `userId` (UUID, primary key)
- `email`, `username` (unique)
- `passwordHash` (bcrypt, nullable for OAuth-only users)
- Profile fields: `name`, `gender`, `bio`, `image`, etc.

**user_auth table:** Stores authentication state (separated for GDPR compliance)
- `userId` (UUID, primary key, references users.userId)
- `failedLoginAttempts` (integer, default 0)
- `lockUntil` (timestamp, nullable)
- `passwordResetToken` (text, unique, nullable)
- `passwordResetExpires` (timestamp, nullable)
- `emailVerified` (timestamp, nullable)
- `emailVerificationToken` (text, unique, nullable)
- `emailVerificationExpires` (timestamp, nullable)

### Security Features

**Password Security:**
- Bcrypt with 12 salt rounds
- Password strength validation (8+ chars, mixed case, numbers, special chars)
- Common password pattern detection

**Account Protection:**
- Exponential backoff lockout (5→15→60 minutes)
- IP-based rate limiting for public endpoints
- Email enumeration prevention (always returns success)

**Token Security:**
- Random UUID tokens
- Password reset tokens: 1 hour expiry
- Email verification tokens: 24 hour expiry
- Single-use tokens (revoked after use)

**Email Security:**
- Resend email service integration
- HTML email templates
- Secure token-based verification

### Rate Limiting

All public endpoints implement IP-based rate limiting using an in-memory LRU cache to prevent:
- Brute force attacks (login attempts)
- Email spam (forgot password, resend verification)
- Account creation abuse (signup)

---

## Environment Variables

### Required for Email Functionality

```bash
# Email Service (Resend)
RESEND_API_KEY=re_xxxxxxxxxxxxxx
RESEND_FROM_EMAIL=noreply@twistloom.com

# Frontend URL (for email links)
FRONTEND_URL=https://twistloom.vercel.app
```

### Optional Feature Flags

```bash
# Enable/disable specific security features
FEATURE_PASSWORD_VALIDATION=true
FEATURE_ACCOUNT_LOCKOUT=true
FEATURE_PASSWORD_RESET=true
FEATURE_EMAIL_VERIFICATION=true
```

---

## Error Handling

All endpoints follow a consistent error response format:

```json
{
  "error": "Error message describing the issue"
}
```

For validation errors with multiple issues:
```json
{
  "error": "Error message",
  "details": ["Specific error 1", "Specific error 2"]
}
```

For account lockout errors:
```json
{
  "error": "Account locked. Try again in 5 minutes.",
  "lockedUntil": "2023-01-01T12:05:00.000Z"
}
```

---

## Integration with NextAuth

### Credentials Provider Configuration

The `/api/auth/verify-credentials` endpoint is designed to work with NextAuth Credentials provider:

```typescript
// NextAuth configuration
credentials: {
  async authorize(credentials) {
    const res = await fetch(`${process.env.BACKEND_URL}/api/auth/verify-credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        emailOrUsername: credentials.email,
        password: credentials.password,
      }),
    });
    
    if (!res.ok) return null;
    
    const user = await res.json();
    return user;
  }
}
```

### Session Management

NextAuth handles:
- Session cookie creation and validation
- JWT token generation and verification
- Session refresh and expiration
- Google OAuth integration

Backend handles:
- Credential verification
- User data management
- Password and email operations

---

## Testing Examples

### Complete Signup Flow

```bash
# 1. Sign up
curl -X POST http://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "username": "testuser",
    "gender": "male",
    "password": "TestPass123!",
    "agreedToTerms": true
  }'

# 2. Verify email (using token from email)
curl -X POST http://localhost:3000/api/auth/verify-email \
  -H "Content-Type: application/json" \
  -d '{
    "token": "verification-token-from-email"
  }'

# 3. Login via NextAuth (frontend)
# NextAuth calls /api/auth/verify-credentials
```

### Password Reset Flow

```bash
# 1. Request password reset
curl -X POST http://localhost:3000/api/auth/forgot-password \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com"
  }'

# 2. Reset password using token from email
curl -X POST http://localhost:3000/api/auth/reset-password \
  -H "Content-Type: application/json" \
  -d '{
    "token": "reset-token-from-email",
    "password": "NewTestPass123!"
  }'

# 3. Login with new password
# NextAuth calls /api/auth/verify-credentials
```

---

## GDPR Compliance

### Data Separation

The authentication system implements GDPR-friendly data separation:
- **users table:** Personal profile data (name, bio, gender, etc.)
- **user_auth table:** Authentication state (tokens, lockout, verification status)

This separation enables:
- Easier data export (can export auth data separately)
- Simplified data deletion (can delete auth records while preserving profile)
- Clearer access control (different permissions for profile vs auth data)
- Audit trail for authentication events

### Data Retention

- Password reset tokens: 1 hour
- Email verification tokens: 24 hours
- Account lockout records: Until unlocked or manually reset
- Failed login attempts: Reset on successful login

---

## Future Enhancements

Planned features for future phases (see AUTH_ENHANCEMENT_ROADMAP.md):

- **Phase 2:** Session management, audit logging, CSRF protection, input sanitization
- **Phase 3:** Two-factor authentication (2FA), OAuth account linking, device fingerprinting
- **Phase 4:** Passwordless authentication (magic links), OAuth state verification

---

## Support

For issues or questions about the Authentication API:
- Check the [AUTH_ENHANCEMENT_ROADMAP.md](../AUTH_ENHANCEMENT_ROADMAP.md) for planned features
- Review the [DUAL_AUTH_ARCHITECTURE.md](../DUAL_AUTH_ARCHITECTURE.md) for architecture details
- Consult the [BACKEND_AUTH_MIGRATION_GUIDE.md](../BACKEND_AUTH_MIGRATION_GUIDE.md) for integration guidance
