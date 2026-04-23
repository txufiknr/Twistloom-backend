# Authentication Enhancement Roadmap

## Overview

This roadmap outlines security enhancements and future-proofing improvements for the Twistloom authentication system. The current NextAuth v5 implementation is production-ready for basic authentication but requires additional security hardening to meet enterprise-grade security standards.

**Current Status**: ✅ Secure for basic auth (Google OAuth + Email/Password)
**Target Status**: ✅ Enterprise-grade authentication with comprehensive security features

---

## Executive Summary

### Critical Security Gaps
- No password strength validation
- No account lockout mechanism
- Password reset not implemented
- No email verification for new accounts
- No session invalidation capability

### Implementation Timeline
- **Phase 1 (Week 1-2)**: Critical security features (password validation, account lockout, password reset, email verification)
- **Phase 2 (Week 3-4)**: Security hardening (session management, audit logging, CSRF protection, input sanitization)
- **Phase 3 (Week 5-6)**: Advanced features (2FA, social account linking, device fingerprinting)
- **Phase 4 (Week 7-8)**: Future-proofing (passwordless auth, OAuth state verification)

---

## Phase 1: Critical Security Features (Week 1-2) ✅ **COMPLETED**

**Completion Date:** April 23, 2026

**Implementation Notes:**
- **Architecture Decision:** Created separate `user_auth` table for security, maintainability, and GDPR compliance
  - Separates authentication state from user profile data
  - Easier to manage access controls and audit trails
  - Simplifies GDPR compliance (data export/deletion)
  - Cleaner separation of concerns
- **Database Schema:** All auth-related columns moved to `user_auth` table with cascade delete on user deletion
- **Migration Status:** Schema changes complete, pending user to run `pnpm db:generate` and `pnpm db:migrate`

**Additional Improvements & Fixes:**
- ✅ Added `emailVerificationExpires` field to `user_auth` schema for proper token expiration
- ✅ Fixed account lockout threshold logic (changed `indexOf` to `findIndex` with `>=` comparison)
- ✅ Added `updatedAt` to `onConflictDoUpdate` in email-verification and password-reset utilities
- ✅ Removed database transactions for Vercel serverless compatibility (sequential operations with manual rollback)
- ✅ Added email sending failure handling in signup endpoint (non-blocking with error logging)
- ✅ Fixed race condition in `verifyEmailToken` (atomic update with where clause checking token still set)
- ✅ Fixed password reset race condition (atomic operations with token validation)
- ✅ Fixed common password check (changed from `includes` to exact match)
- ✅ Removed `name` field from signup endpoint (set to null)
- ✅ Ensured failed login attempts cleared after password reset (industry best practice)

### 1.1 Password Strength Validation

**Priority**: 🔴 Critical | **Effort**: 2-3 hours | **Risk**: Low | **Status**: ✅ **COMPLETED**

#### Problem
Users can create weak passwords vulnerable to brute force attacks. No backend validation ensures password complexity.

#### Solution
Create `src/utils/password-validation.ts` with comprehensive password strength validation:
- Minimum 8 characters, maximum 128
- At least one uppercase letter
- At least one lowercase letter
- At least one number
- At least one special character
- Reject common passwords (password, 123456, qwerty, etc.)

#### Implementation
```typescript
// src/utils/password-validation.ts
export interface PasswordValidationResult {
  valid: boolean;
  errors: string[];
}

export function validatePasswordStrength(password: string): PasswordValidationResult {
  const errors: string[] = [];
  if (password.length < 8) errors.push('Password must be at least 8 characters long');
  if (password.length > 128) errors.push('Password must not exceed 128 characters');
  if (!/[A-Z]/.test(password)) errors.push('Password must contain at least one uppercase letter');
  if (!/[a-z]/.test(password)) errors.push('Password must contain at least one lowercase letter');
  if (!/[0-9]/.test(password)) errors.push('Password must contain at least one number');
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('Password must contain at least one special character');
  
  const commonPasswords = ['password', '123456', 'qwerty', 'admin', 'welcome'];
  if (commonPasswords.some(common => password.toLowerCase().includes(common))) {
    errors.push('Password contains common patterns');
  }
  
  return { valid: errors.length === 0, errors };
}
```

Update `POST /api/auth/signup` to validate password before hashing.

#### Testing
```bash
# Test weak password rejection
curl -X POST http://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","username":"test","password":"weak","gender":"male","agreedToTerms":true}'
# Expected: 400 with validation errors

# Test strong password acceptance
curl -X POST http://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","username":"test","password":"Str0ngP@ssw0rd!","gender":"male","agreedToTerms":true}'
# Expected: 201 success
```

#### Rollback Plan
Remove validation calls from signup endpoint. No database changes required.

---

### 1.2 Account Lockout Mechanism

**Priority**: 🔴 Critical | **Effort**: 4-6 hours | **Risk**: Medium (database migration) | **Status**: ✅ **COMPLETED**

#### Problem
Rate limiting is IP-based only, which can be bypassed using proxy rotation. No account-level protection against brute force attacks.

#### Solution
Implement account-based lockout with exponential backoff:
- 5 failed attempts: 5-minute lockout
- 10 failed attempts: 15-minute lockout
- 15 failed attempts: 1-hour lockout

#### Database Schema Changes
```sql
ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN lock_until TIMESTAMP WITH TIME ZONE;
CREATE INDEX users_lock_until_idx ON users(lock_until) WHERE lock_until IS NOT NULL;
```

```typescript
// src/db/schema.ts
export const users = pgTable("users", {
  // ... existing fields
  failedLoginAttempts: integer("failed_login_attempts").default(0),
  lockUntil: timestamp("lock_until", { withTimezone: true }),
});
```

#### Implementation
Create `src/utils/account-lockout.ts` with functions:
- `checkAccountLockout(userId)`: Check if account is locked
- `recordFailedLogin(userId)`: Increment failed attempts and lock if threshold reached
- `resetFailedLoginAttempts(userId)`: Reset on successful login

Update `POST /api/auth/verify-credentials` to check lockout status before password verification.

#### Testing
```bash
# Test account lockout after 5 failed attempts
for i in {1..6}; do
  curl -X POST http://localhost:3000/api/auth/verify-credentials \
    -H "Content-Type: application/json" \
    -d '{"emailOrUsername":"test@example.com","password":"wrongpass"}'
  echo "---"
done
# Expected: First 5 return 401, 6th returns 429 with lock message
```

#### Rollback Plan
Remove lockout checks from verify-credentials endpoint. Drop database columns. No impact on existing users.

---

### 1.3 Password Reset Implementation

**Priority**: 🔴 Critical | **Effort**: 6-8 hours | **Risk**: Medium (database migration + email service) | **Status**: ✅ **COMPLETED**

#### Problem
Users cannot recover forgotten passwords. Password reset endpoint is a placeholder with no actual functionality.

#### Solution
Implement complete password reset flow with secure tokens and email delivery using Resend.

#### Database Schema Changes
```sql
ALTER TABLE users ADD COLUMN password_reset_token TEXT UNIQUE;
ALTER TABLE users ADD COLUMN password_reset_expires TIMESTAMP WITH TIME ZONE;
CREATE INDEX users_password_reset_token_idx ON users(password_reset_token) WHERE password_reset_token IS NOT NULL;
```

```typescript
// src/db/schema.ts
export const users = pgTable("users", {
  // ... existing fields
  passwordResetToken: text("password_reset_token").unique("users_password_reset_token_unique"),
  passwordResetExpires: timestamp("password_reset_expires", { withTimezone: true }),
});
```

#### Implementation
1. Create `src/utils/password-reset.ts` with:
   - `createPasswordResetToken(email)`: Generate token (1 hour expiry)
   - `verifyPasswordResetToken(token)`: Verify token validity
   - `resetPassword(token, newPassword)`: Update password and revoke sessions

2. Create `src/utils/email.ts` with Resend integration:
   ```typescript
   import { Resend } from 'resend';
   const resend = new Resend(process.env.RESEND_API_KEY);
   
   export async function sendPasswordResetEmail(email: string, resetUrl: string) {
     await resend.emails.send({
       from: process.env.RESEND_FROM_EMAIL || 'noreply@twistloom.com',
       to: email,
       subject: 'Reset Your Twistloom Password',
       html: `<h1>Reset Your Password</h1><p><a href="${resetUrl}">Reset Password</a></p>`,
     });
   }
   ```

3. Update `POST /api/auth/forgot-password` to send actual emails

4. Create `POST /api/auth/reset-password` endpoint

#### Environment Variables
```bash
RESEND_API_KEY=your-resend-api-key
RESEND_FROM_EMAIL=noreply@twistloom.com
FRONTEND_URL=https://twistloom.vercel.app
```

#### Testing
```bash
# Test forgot password
curl -X POST http://localhost:3000/api/auth/forgot-password \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}'
# Expected: 200 success, email sent

# Test password reset
curl -X POST http://localhost:3000/api/auth/reset-password \
  -H "Content-Type: application/json" \
  -d '{"token":"valid-token","password":"NewStr0ngP@ssw0rd!"}'
# Expected: 200 success
```

#### Rollback Plan
Remove reset-password endpoint, revert forgot-password to placeholder, drop database columns. No impact on existing users.

---

### 1.4 Email Verification

**Priority**: 🔴 Critical | **Effort**: 4-6 hours | **Risk**: Medium (database migration + email service) | **Status**: ✅ **COMPLETED**

#### Problem
Users can register with fake or invalid email addresses. No verification ensures email ownership.

#### Solution
Implement email verification flow with verification tokens (24 hour expiry).

#### Database Schema Changes
```sql
ALTER TABLE users ADD COLUMN email_verified TIMESTAMP WITH TIME ZONE;
ALTER TABLE users ADD COLUMN email_verification_token TEXT UNIQUE;
CREATE INDEX users_email_verification_token_idx ON users(email_verification_token) WHERE email_verification_token IS NOT NULL;
```

```typescript
// src/db/schema.ts
export const users = pgTable("users", {
  // ... existing fields
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  emailVerificationToken: text("email_verification_token").unique("users_email_verification_token_unique"),
});
```

#### Implementation
1. Create `src/utils/email-verification.ts` with:
   - `createEmailVerificationToken(userId)`: Generate token
   - `verifyEmailToken(token)`: Verify and mark email as verified
   - `isEmailVerified(userId)`: Check verification status

2. Update `POST /api/auth/signup` to send verification email

3. Create `POST /api/auth/verify-email` endpoint

4. Create `POST /api/auth/resend-verification` endpoint

5. Optional: Require email verification for login (add check to verify-credentials)

#### Testing
```bash
# Test signup sends verification email
curl -X POST http://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","username":"test","password":"Str0ngP@ssw0rd!","gender":"male","agreedToTerms":true}'
# Expected: 201 with message about email verification

# Test verify-email
curl -X POST http://localhost:3000/api/auth/verify-email \
  -H "Content-Type: application/json" \
  -d '{"token":"valid-token"}'
# Expected: 200 success
```

#### Rollback Plan
Remove verify-email and resend-verification endpoints, revert signup endpoint, drop database columns. No impact on existing users.

---

## Phase 2: Security Hardening (Week 3-4)

### 2.1 Session Management & Invalidation

**Priority**: 🟡 Medium | **Effort**: 8-10 hours | **Risk**: Medium (database migration)

#### Problem
Cannot revoke sessions after password change or security incident. No visibility into active sessions.

#### Solution
Implement session tracking with database-backed session management.

#### Database Schema Changes
```sql
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  ip_address TEXT,
  user_agent TEXT,
  device_type TEXT,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  last_active_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);
CREATE INDEX auth_sessions_token_idx ON auth_sessions(token);
CREATE INDEX auth_sessions_expires_idx ON auth_sessions(expires_at);
```

#### Implementation
1. Create `src/utils/sessions.ts` with:
   - `createSession(userId, token, ip, userAgent)`: Create new session
   - `getSession(token)`: Retrieve and validate session
   - `revokeSession(sessionId)`: Revoke specific session
   - `revokeAllUserSessions(userId, exceptSessionId)`: Revoke all sessions
   - `getUserSessions(userId)`: List active sessions
   - `cleanupExpiredSessions()`: Delete expired sessions

2. Integrate with `requireAuth` middleware to verify session exists

3. Create endpoints:
   - `GET /api/auth/sessions`: List active sessions
   - `DELETE /api/auth/sessions/:id`: Revoke specific session
   - `DELETE /api/auth/sessions`: Revoke all sessions except current

4. Update password reset to revoke all sessions on password change

5. Create cleanup cron job for expired sessions

#### Testing
```bash
# Test get sessions
curl -X GET http://localhost:3000/api/auth/sessions \
  -H "Cookie: next-auth.session-token=valid-token"
# Expected: 200 with list of sessions

# Test revoke all sessions
curl -X DELETE http://localhost:3000/api/auth/sessions \
  -H "Cookie: next-auth.session-token=valid-token"
# Expected: 200 with count of revoked sessions
```

#### Rollback Plan
Remove session management endpoints, remove session checks from middleware, drop auth_sessions table. No impact on existing users.

---

### 2.2 Audit Logging

**Priority**: 🟡 Medium | **Effort**: 4-6 hours | **Risk**: Low (database migration)

#### Problem
No visibility into authentication events. Cannot track suspicious activity or meet compliance requirements.

#### Solution
Implement comprehensive audit logging for all authentication events.

#### Database Schema Changes
```sql
CREATE TABLE auth_events (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(user_id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  success BOOLEAN NOT NULL,
  details JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

CREATE INDEX auth_events_user_idx ON auth_events(user_id);
CREATE INDEX auth_events_type_idx ON auth_events(event_type);
CREATE INDEX auth_events_created_idx ON auth_events(created_at DESC);
CREATE INDEX auth_events_success_idx ON auth_events(success);
```

#### Implementation
1. Create `src/utils/audit-log.ts` with:
   - `logAuthEvent(data)`: Log authentication event
   - `getUserAuthEvents(userId, limit)`: Retrieve user's auth events

2. Add audit logging to all auth endpoints (login, signup, password reset, etc.)

3. Create `GET /api/auth/audit-log` endpoint

4. Create cleanup cron job for old logs (90-day retention)

#### Testing
```bash
# Perform login, signup, password reset
# Then check audit log:
curl -X GET http://localhost:3000/api/auth/audit-log \
  -H "Cookie: next-auth.session-token=valid-token"
# Expected: 200 with list of auth events
```

#### Rollback Plan
Remove audit logging calls, remove audit log endpoint, drop auth_events table. No impact on existing users.

---

### 2.3 CSRF Protection

**Priority**: 🟡 Medium | **Effort**: 2-3 hours | **Risk**: Low

#### Problem
No CSRF protection on state-changing endpoints. Vulnerable to cross-site request forgery attacks.

#### Solution
Implement CSRF protection using csurf middleware.

#### Implementation
1. Install csurf: `pnpm add csurf`
2. Create `src/middleware/csrf.ts`
3. Apply to state-changing endpoints (POST /api/auth/verify-credentials, /signup, /forgot-password, etc.)
4. Create `GET /api/auth/csrf-token` endpoint
5. Update frontend to include CSRF token in requests

#### Testing
```bash
# Test CSRF token retrieval
curl -X GET http://localhost:3000/api/auth/csrf-token
# Expected: 200 with csrfToken

# Test POST without CSRF token (should fail)
curl -X POST http://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","username":"test","password":"Str0ngP@ssw0rd!","gender":"male","agreedToTerms":true}'
# Expected: 403 Forbidden
```

#### Rollback Plan
Remove csrfMiddleware from routes, remove csrf-token endpoint. No database changes required.

---

### 2.4 Input Sanitization

**Priority**: 🟡 Medium | **Effort**: 2-3 hours | **Risk**: Low

#### Problem
No input sanitization. Vulnerable to XSS attacks via user input.

#### Solution
Implement input sanitization using sanitize-html.

#### Implementation
1. Install sanitize-html: `pnpm add sanitize-html @types/sanitize-html`
2. Create `src/utils/sanitize.ts` with:
   - `sanitizeInput(input)`: Strip HTML tags
   - `sanitizeEmail(email)`: Trim and lowercase
   - `sanitizeUsername(username)`: Allow only alphanumeric and underscores
3. Apply to all auth endpoints

#### Testing
```bash
# Test XSS attempt in username
curl -X POST http://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","username":"<script>alert(1)</script>","password":"Str0ngP@ssw0rd!","gender":"male","agreedToTerms":true}'
# Expected: 201 success with sanitized username
```

#### Rollback Plan
Remove sanitization calls from endpoints. No database changes required.

---

## Phase 3: Advanced Features (Week 5-6)

### 3.1 Two-Factor Authentication (2FA)

**Priority**: 🟢 Low | **Effort**: 12-16 hours | **Risk**: High (complex integration)

#### Problem
No second factor of authentication. Vulnerable to credential theft.

#### Solution
Implement TOTP-based 2FA using authenticator apps (Google Authenticator, Authy, etc.).

#### Database Schema Changes
```sql
ALTER TABLE users ADD COLUMN two_factor_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN two_factor_secret TEXT;
ALTER TABLE users ADD COLUMN two_factor_backup_codes JSONB;
```

#### Implementation
1. Install packages: `pnpm add otplib qrcode @types/qrcode`
2. Create `src/utils/two-factor.ts` with:
   - `generate2FASecret(email)`: Generate secret and QR code
   - `verify2FAToken(token, secret)`: Verify TOTP token
   - `generateBackupCodes()`: Generate 10 backup codes

3. Create endpoints:
   - `POST /api/auth/2fa/setup`: Generate secret and QR code
   - `POST /api/auth/2fa/verify`: Verify token and enable 2FA
   - `POST /api/auth/2fa/disable`: Disable 2FA
   - `POST /api/auth/2fa/login`: Verify 2FA during login

4. Update verify-credentials to return `requires2FA: true` for 2FA-enabled accounts

#### Testing
```bash
# Test 2FA setup
curl -X POST http://localhost:3000/api/auth/2fa/setup \
  -H "Cookie: next-auth.session-token=valid-token"
# Expected: 200 with secret and QR code

# Test 2FA verification
curl -X POST http://localhost:3000/api/auth/2fa/verify \
  -H "Cookie: next-auth.session-token=valid-token" \
  -H "Content-Type: application/json" \
  -d '{"token":"123456"}'
# Expected: 200 with backup codes
```

#### Rollback Plan
Remove 2FA endpoints, remove 2FA checks from verify-credentials, drop database columns. No impact on existing users.

---

### 3.2 Social Account Linking

**Priority**: 🟢 Low | **Effort**: 8-10 hours | **Risk**: Medium (database migration)

#### Problem
Users cannot link multiple OAuth providers to a single account. Must create separate accounts for each provider.

#### Solution
Implement OAuth provider linking to allow users to connect multiple auth methods.

#### Database Schema Changes
```sql
CREATE TABLE oauth_providers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

CREATE UNIQUE INDEX oauth_providers_unique ON oauth_providers(provider, provider_user_id);
CREATE INDEX oauth_providers_user_idx ON oauth_providers(user_id);
```

#### Implementation
1. Create `src/utils/oauth-linking.ts` with:
   - `linkOAuthProvider(userId, provider, providerUserId)`: Link provider
   - `unlinkOAuthProvider(userId, provider)`: Unlink provider
   - `getUserOAuthProviders(userId)`: List linked providers
   - `findUserByOAuthProvider(provider, providerUserId)`: Find user by OAuth

2. Create endpoints:
   - `GET /api/auth/oauth/providers`: List linked providers
   - `POST /api/auth/oauth/link`: Link provider
   - `DELETE /api/auth/oauth/unlink`: Unlink provider

3. Update NextAuth OAuth callback to check for linked accounts

#### Testing
```bash
# Test get OAuth providers
curl -X GET http://localhost:3000/api/auth/oauth/providers \
  -H "Cookie: next-auth.session-token=valid-token"
# Expected: 200 with list of linked providers

# Test link OAuth provider
curl -X POST http://localhost:3000/api/auth/oauth/link \
  -H "Cookie: next-auth.session-token=valid-token" \
  -H "Content-Type: application/json" \
  -d '{"provider":"google","providerUserId":"google-user-id"}'
# Expected: 200 success
```

#### Rollback Plan
Remove OAuth linking endpoints, drop oauth_providers table. No impact on existing users.

---

### 3.3 Device Fingerprinting

**Priority**: 🟢 Low | **Effort**: 6-8 hours | **Risk**: Low

#### Problem
No device tracking. Cannot detect suspicious login from new devices.

#### Solution
Implement device fingerprinting using SHA-256 hash of user agent + IP address.

#### Implementation
1. Create `src/utils/device-fingerprint.ts` with:
   - `generateDeviceFingerprint(userAgent, ip)`: Generate hash
   - `isNewDevice(fingerprint, previousFingerprints)`: Check if new device

2. Add device fingerprint to audit log details

3. Create `GET /api/auth/devices` endpoint to list all devices

#### Testing
```bash
# Test get devices
curl -X GET http://localhost:3000/api/auth/devices \
  -H "Cookie: next-auth.session-token=valid-token"
# Expected: 200 with list of devices
```

#### Rollback Plan
Remove device fingerprinting from audit log, remove devices endpoint. No database changes required.

---

## Phase 4: Future-Proofing (Week 7-8)

### 4.1 Passwordless Authentication

**Priority**: 🟢 Low | **Effort**: 8-10 hours | **Risk**: Medium (email service dependency)

#### Problem
No passwordless login option. Users must remember passwords.

#### Solution
Implement magic link authentication for passwordless login.

#### Database Schema Changes
```sql
ALTER TABLE users ADD COLUMN magic_link_token TEXT UNIQUE;
ALTER TABLE users ADD COLUMN magic_link_expires TIMESTAMP WITH TIME ZONE;
```

#### Implementation
1. Create `src/utils/magic-link.ts` with:
   - `createMagicLink(email)`: Generate token (15 minute expiry)
   - `verifyMagicLink(token)`: Verify token and return user data

2. Create `POST /api/auth/magic-link/request` endpoint

3. Create `GET /api/auth/magic-link/verify?token=xxx` endpoint

4. Update frontend to support magic link login flow

#### Testing
```bash
# Test magic link request
curl -X POST http://localhost:3000/api/auth/magic-link/request \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}'
# Expected: 200 success, email sent

# Test magic link verification
curl -X GET "http://localhost:3000/api/auth/magic-link/verify?token=valid-token"
# Expected: 200 with user data
```

#### Rollback Plan
Remove magic link endpoints, drop database columns. No impact on existing users.

---

### 4.2 OAuth State Parameter Verification

**Priority**: 🟢 Low | **Effort**: 2-3 hours | **Risk**: Low

#### Problem
No explicit OAuth state parameter verification in custom OAuth flows (NextAuth handles this for built-in providers).

#### Solution
Document and verify OAuth state parameter usage for any custom OAuth providers.

#### Implementation
1. Document OAuth state parameter requirements in `DUAL_AUTH_ARCHITECTURE.md`
2. Add state parameter validation for any custom OAuth providers
3. Ensure all OAuth flows use state parameter to prevent CSRF

#### Rollback Plan
Remove state parameter validation. No database changes required.

---

## Implementation Checklist

### Phase 1: Critical Security Features ✅ **COMPLETED**
- [x] 1.1 Password strength validation
  - [x] Create password-validation.ts utility
  - [x] Update signup endpoint
  - [x] Fix common password check (exact match instead of includes)
  - [ ] Update password change endpoint (if exists)
  - [ ] Test weak password rejection
  - [ ] Test strong password acceptance

- [x] 1.2 Account lockout mechanism
  - [x] Add database fields (failed_login_attempts, lock_until) to user_auth table
  - [x] Create account-lockout.ts utility
  - [x] Update verify-credentials endpoint
  - [x] Fix account lockout threshold logic (findIndex with >= comparison)
  - [ ] Test account lockout
  - [ ] Test lock expiration

- [x] 1.3 Password reset implementation
  - [x] Add database fields (password_reset_token, password_reset_expires) to user_auth table
  - [x] Create password-reset.ts utility
  - [x] Create email.ts utility with Resend
  - [x] Update forgot-password endpoint
  - [x] Create reset-password endpoint
  - [x] Add updatedAt to onConflictDoUpdate
  - [x] Fix password reset race condition (atomic operations)
  - [x] Ensure failed login attempts cleared after password reset
  - [ ] Test forgot password
  - [ ] Test password reset

- [x] 1.4 Email verification
  - [x] Add database fields (email_verified, email_verification_token, email_verification_expires) to user_auth table
  - [x] Create email-verification.ts utility
  - [x] Update signup endpoint
  - [x] Create verify-email endpoint
  - [x] Create resend-verification endpoint
  - [x] Add email verification token expiration check
  - [x] Fix race condition in verifyEmailToken (atomic update)
  - [x] Add email sending failure handling in signup endpoint
  - [x] Remove database transactions for Vercel serverless compatibility
  - [x] Remove name field from signup endpoint
  - [ ] Optional: Require verification for login
  - [ ] Test email verification

### Phase 2: Security Hardening
- [ ] 2.1 Session management
  - [ ] Create auth_sessions table
  - [ ] Create sessions.ts utility
  - [ ] Integrate with requireAuth middleware
  - [ ] Create session management endpoints
  - [ ] Update password reset to revoke sessions
  - [ ] Create cleanup cron job
  - [ ] Test session management

- [ ] 2.2 Audit logging
  - [ ] Create auth_events table
  - [ ] Create audit-log.ts utility
  - [ ] Add logging to all auth endpoints
  - [ ] Create audit-log endpoint
  - [ ] Create cleanup cron job
  - [ ] Test audit logging

- [ ] 2.3 CSRF protection
  - [ ] Install csurf package
  - [ ] Create csrf.ts middleware
  - [ ] Apply to state-changing endpoints
  - [ ] Create csrf-token endpoint
  - [ ] Update frontend to include CSRF token
  - [ ] Test CSRF protection

- [ ] 2.4 Input sanitization
  - [ ] Install sanitize-html package
  - [ ] Create sanitize.ts utility
  - [ ] Apply to all auth endpoints
  - [ ] Test input sanitization

### Phase 3: Advanced Features
- [ ] 3.1 Two-factor authentication
  - [ ] Add database fields (two_factor_enabled, two_factor_secret, two_factor_backup_codes)
  - [ ] Install otplib and qrcode packages
  - [ ] Create two-factor.ts utility
  - [ ] Create 2FA endpoints
  - [ ] Update verify-credentials for 2FA
  - [ ] Test 2FA setup and verification

- [ ] 3.2 Social account linking
  - [ ] Create oauth_providers table
  - [ ] Create oauth-linking.ts utility
  - [ ] Create OAuth linking endpoints
  - [ ] Update NextAuth OAuth callback
  - [ ] Test OAuth linking

- [ ] 3.3 Device fingerprinting
  - [ ] Create device-fingerprint.ts utility
  - [ ] Add to audit log
  - [ ] Create devices endpoint
  - [ ] Test device fingerprinting

### Phase 4: Future-Proofing
- [ ] 4.1 Passwordless authentication
  - [ ] Add database fields (magic_link_token, magic_link_expires)
  - [ ] Create magic-link.ts utility
  - [ ] Create magic link endpoints
  - [ ] Update frontend for magic link flow
  - [ ] Test passwordless authentication

- [ ] 4.2 OAuth state verification
  - [ ] Document OAuth state requirements
  - [ ] Add state validation for custom providers
  - [ ] Test OAuth state verification

---

## Migration Strategy

### Database Migrations
All database changes should be done via Drizzle migrations:
```bash
pnpm db:generate  # Generate migration from schema changes
pnpm db:migrate   # Apply migration to database
```

### Rollback Strategy
Each feature includes a rollback plan. For database changes:
```bash
# Create rollback migration manually or use Drizzle's rollback
pnpm db:generate  # Generate rollback migration
pnpm db:migrate   # Apply rollback
```

### Feature Flags
Consider adding feature flags for new features to enable gradual rollout:
```typescript
const FEATURE_FLAGS = {
  PASSWORD_VALIDATION: process.env.FEATURE_PASSWORD_VALIDATION === 'true',
  ACCOUNT_LOCKOUT: process.env.FEATURE_ACCOUNT_LOCKOUT === 'true',
  // ... etc
};
```

---

## Testing Strategy

### Unit Testing
- Test all utility functions (password validation, account lockout, etc.)
- Test edge cases (null inputs, invalid tokens, expired tokens)

### Integration Testing
- Test complete flows (signup → verify email → login → password reset)
- Test error scenarios (invalid credentials, expired tokens, rate limits)

### Security Testing
- Test brute force protection (account lockout)
- Test email enumeration prevention
- Test CSRF protection
- Test XSS prevention (input sanitization)

### Load Testing
- Test rate limiting under load
- Test session management under load
- Test audit logging performance

---

## Monitoring & Alerts

### Key Metrics to Monitor
- Failed login attempts per user
- Account lockouts
- Password reset requests
- Email verification rate
- Session creation/revocation
- Suspicious activity detection (new devices, unusual locations)

### Alert Thresholds
- > 10 failed login attempts per hour per user
- > 100 password reset requests per hour
- > 50% of new accounts unverified after 24 hours
- > 5 accounts locked per hour

### Logging
- All auth events logged to auth_events table
- Error logs for failed operations
- Security events (lockouts, suspicious activity) flagged

---

## Security Best Practices

### Password Security
- ✅ Bcrypt with 12 salt rounds (already implemented)
- ✅ Password strength validation (Phase 1.1)
- ✅ Secure password reset (Phase 1.3)
- ⚠️ Consider password rotation policy (future)

### Session Security
- ✅ httpOnly, secure, SameSite cookies (NextAuth handles)
- ✅ Session invalidation (Phase 2.1)
- ✅ Session expiration (30 days default)
- ⚠️ Consider session refresh mechanism (future)

### OAuth Security
- ✅ State parameter verification (NextAuth handles for built-in providers)
- ✅ PKCE for mobile apps (if applicable)
- ⚠️ Document custom provider requirements (Phase 4.2)

### Rate Limiting
- ✅ IP-based rate limiting for unauthenticated endpoints (already implemented)
- ✅ User-based rate limiting for authenticated endpoints (already implemented)
- ⚠️ Consider Redis-based IP rate limiting (future - mentioned in migration guide)

### Input Validation
- ✅ Basic validation (already implemented)
- ✅ Input sanitization (Phase 2.4)
- ✅ Password strength validation (Phase 1.1)
- ⚠️ Consider stricter email validation (future)

### Audit & Compliance
- ✅ Audit logging (Phase 2.2)
- ✅ 90-day log retention (cleanup cron job)
- ⚠️ Consider GDPR compliance features (data export, deletion) (future)

---

## Dependencies

### Required Packages
```json
{
  "csurf": "^1.11.0",
  "sanitize-html": "^2.11.0",
  "otplib": "^12.0.1",
  "qrcode": "^1.5.3",
  "resend": "^3.2.0"
}
```

### Dev Dependencies
```json
{
  "@types/csurf": "^1.11.5",
  "@types/sanitize-html": "^2.9.0",
  "@types/qrcode": "^1.5.5"
}
```

### Environment Variables
```bash
# Email Service (Resend)
RESEND_API_KEY=your-resend-api-key
RESEND_FROM_EMAIL=noreply@twistloom.com

# Frontend URL (for email links)
FRONTEND_URL=https://twistloom.vercel.app

# Feature Flags (optional)
FEATURE_PASSWORD_VALIDATION=true
FEATURE_ACCOUNT_LOCKOUT=true
FEATURE_PASSWORD_RESET=true
FEATURE_EMAIL_VERIFICATION=true
FEATURE_SESSION_MANAGEMENT=true
FEATURE_AUDIT_LOGGING=true
FEATURE_CSRF_PROTECTION=true
FEATURE_INPUT_SANITIZATION=true
FEATURE_2FA=false
FEATURE_OAUTH_LINKING=false
FEATURE_DEVICE_FINGERPRINTING=false
FEATURE_PASSWORDLESS=false
```

---

## Documentation Updates

### Update Required Documents
1. **DUAL_AUTH_ARCHITECTURE.md**: Add new features (2FA, passwordless, OAuth linking)
2. **BACKEND_AUTH_MIGRATION_GUIDE.md**: Add session management details
3. **README.md**: Add security features section
4. **API documentation**: Add new endpoints

### New Documentation to Create
1. **AUTH_SECURITY_BEST_PRACTICES.md**: Security guidelines for developers
2. **AUTH_EVENT_TYPES.md**: Reference for audit log event types
3. **AUTH_TROUBLESHOOTING.md**: Common issues and solutions

---

## Success Criteria

### Phase 1 Success Criteria
- ✅ All passwords meet strength requirements
- ✅ Accounts lock after 5 failed login attempts
- ✅ Users can reset passwords via email
- ✅ New accounts require email verification

### Phase 2 Success Criteria
- ✅ Sessions can be revoked individually or all at once
- ✅ All auth events are logged
- ✅ CSRF protection enabled on state-changing endpoints
- ✅ All user inputs are sanitized

### Phase 3 Success Criteria
- ✅ Users can enable 2FA with authenticator app
- ✅ Users can link multiple OAuth providers
- ✅ Users can view all devices that logged into their account

### Phase 4 Success Criteria
- ✅ Users can login without password via magic link
- ✅ OAuth state parameter is verified for custom providers

---

## Risks & Mitigations

### High Risk Items
1. **2FA Implementation**: Complex integration, user experience impact
   - Mitigation: Make 2FA optional, provide clear documentation, test thoroughly

2. **Email Service Dependency**: Resend outage could break password reset/email verification
   - Mitigation: Implement retry logic, provide fallback (admin reset), monitor service health

### Medium Risk Items
1. **Database Migrations**: Schema changes could break existing functionality
   - Mitigation: Test migrations in staging, have rollback plan ready

2. **Session Management**: Integration with NextAuth could be complex
   - Mitigation: Test thoroughly with NextAuth, document integration points

### Low Risk Items
1. **Input Sanitization**: Could break existing user data
   - Mitigation: Apply only to new inputs, sanitize on display for existing data

2. **CSRF Protection**: Could break frontend if not implemented correctly
   - Mitigation: Test with frontend, provide clear documentation for token inclusion

---

## Timeline Summary

| Phase | Duration | Features | Effort |
|-------|----------|----------|--------|
| Phase 1 | Week 1-2 | Password validation, Account lockout, Password reset, Email verification | 14-23 hours |
| Phase 2 | Week 3-4 | Session management, Audit logging, CSRF protection, Input sanitization | 16-22 hours |
| Phase 3 | Week 5-6 | 2FA, OAuth linking, Device fingerprinting | 26-34 hours |
| Phase 4 | Week 7-8 | Passwordless auth, OAuth state verification | 10-13 hours |
| **Total** | **8 weeks** | **14 features** | **66-92 hours** |

---

## Next Steps

1. **Review and Approve**: Review this roadmap with team and approve implementation plan
2. **Prioritize**: Decide if all phases should be implemented or focus on Phase 1-2 first
3. **Schedule**: Create detailed schedule with specific dates for each feature
4. **Assign**: Assign developers to each feature based on expertise
5. **Begin**: Start with Phase 1.1 (Password strength validation) as it's low-risk and high-value

---

## References

- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [NextAuth.js Documentation](https://next-auth.js.org/)
- [Bcrypt Documentation](https://github.com/kelektiv/node.bcrypt.js)
- [Resend Documentation](https://resend.com/docs)
- [OTplib Documentation](https://github.com/yeojz/otplib)
