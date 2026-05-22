# Guest User Deduplication Analysis

## Problem Statement

**Observation:** Multiple guest users are being created in the database at almost the same time, likely from the same actual user.

**Impact:** 
- Database bloat with unused guest accounts
- Wasted storage and computational resources
- Potential data fragmentation
- Difficulty tracking actual user behavior

## Root Cause Analysis

### Current Implementation

The guest user middleware (`src/middleware/guest.ts`) works as follows:

1. **Cookie-based identification**: Uses `twistloom_guest_id` httpOnly cookie (30-day TTL)
2. **Creation logic**: If no cookie exists, creates a new guest user immediately
3. **Validation**: By default trusts cookie without DB validation (`dbLookup = false`)
4. **Cross-origin**: Uses `sameSite: 'none'` in production for cross-domain requests

### Why Duplicates Occur

#### 1. Next.js Prefetch Requests

Next.js automatically prefetches pages when:
- User hovers over a `<Link>` component
- Page is visible in viewport
- Using `<Link prefetch={true}>`

**Problem:** Prefetch requests are made from the browser but may not include cookies in certain scenarios:
- Initial page load before cookie is set
- Cross-origin prefetch with `sameSite: 'none'` restrictions
- Browser privacy settings blocking third-party cookies

**Evidence:** The books route has a `prefetch` parameter that skips visit tracking, indicating prefetch awareness.

#### 2. Server-Side Rendering (SSR)

Next.js SSR makes requests from the server, not the browser:
- Server doesn't have access to browser cookies
- Each SSR request creates a new guest user
- Multiple SSR requests (e.g., for different components) create multiple guests

#### 3. Concurrent Client-Side Requests

When a page loads, multiple API calls may be made simultaneously:
- All requests hit before the first cookie is set
- Race condition where each request creates its own guest
- No request deduplication mechanism

#### 4. Cookie Setting Race Condition

The cookie is set in the response:
```typescript
res.cookie(GUEST_COOKIE_NAME, guestId, GUEST_COOKIE_OPTIONS);
```

If multiple requests are made concurrently:
- Request 1: No cookie → creates guest A → sets cookie in response
- Request 2: No cookie (response not received yet) → creates guest B → sets cookie in response
- Request 3: No cookie (response not received yet) → creates guest C → sets cookie in response

All three guests are created, but only one cookie persists in the browser.

## Deduplication Strategies

### Strategy 1: IP-Based Deduplication ❌ NOT RECOMMENDED

**Feasibility:** Low

**Problems:**
- **Shared IPs**: NAT networks, office networks, coffee shops share IPs
- **Mobile networks**: Multiple users share the same IP
- **VPNs/Proxies**: All traffic appears from same IP
- **IP rotation**: ISPs change IPs periodically
- **Privacy concerns**: IP tracking raises GDPR/CCPA concerns

**Example Scenario:**
- Office with 100 employees all accessing from same IP
- All would be forced to share the same guest account
- Data privacy violation (cannot distinguish individual users)

**Verdict:** ❌ **Not feasible or recommended**

### Strategy 2: MAC Address Deduplication ❌ IMPOSSIBLE

**Feasibility:** Zero

**Problems:**
- **Not accessible in HTTP**: MAC addresses are not transmitted in HTTP headers
- **Layer 2 only**: MAC addresses work only at local network level
- **Router NAT**: Routers strip MAC addresses before forwarding to internet
- **Privacy**: Browsers don't expose MAC addresses for security reasons

**Verdict:** ❌ **Technically impossible**

### Strategy 3: Browser Fingerprinting ⚠️ PARTIAL SOLUTION

**Feasibility:** Medium

**Approach:** Collect browser characteristics (user agent, screen resolution, timezone, language, etc.) to create a fingerprint.

**Pros:**
- Can identify returning users without cookies
- Works across sessions
- No additional storage required

**Cons:**
- **Privacy concerns**: GDPR/CCPA compliance issues
- **Not unique**: Similar devices have similar fingerprints
- **Can be spoofed**: Advanced users can change fingerprint
- **Changes over time**: Browser updates change fingerprint
- **Anti-fingerprinting**: Modern browsers resist fingerprinting

**Verdict:** ⚠️ **Possible but not recommended due to privacy concerns**

### Strategy 4: In-Flight Request Deduplication ✅ RECOMMENDED

**Feasibility:** High

**Approach:** Track in-progress guest creation requests per client identifier (IP + user agent).

**Implementation:**
```typescript
const inFlightGuestCreations = new Map<string, Promise<string>>();

async function getOrCreateGuestUser(clientId: string): Promise<string> {
  // Check if there's already an in-flight creation
  const existing = inFlightGuestCreations.get(clientId);
  if (existing) {
    return existing; // Wait for existing request to complete
  }

  // Create new guest user
  const promise = createGuestUser();
  inFlightGuestCreations.set(clientId, promise);

  try {
    return await promise;
  } finally {
    inFlightGuestCreations.delete(clientId);
  }
}
```

**Pros:**
- Prevents race conditions from concurrent requests
- No privacy concerns
- Simple to implement
- Works for prefetch and SSR scenarios

**Cons:**
- Requires a client identifier (IP + user agent)
- Still creates duplicates across different sessions (but much fewer)

**Verdict:** ✅ **Recommended as immediate fix**

### Strategy 5: Lazy Guest Creation ✅ HIGHLY RECOMMENDED

**Feasibility:** High

**Approach:** Only create guest user when user actually performs an action that requires persistence (e.g., creating a book).

**Implementation:**
```typescript
// Don't create guest on every request
// Only create when user takes an action
if (requiresPersistence(req)) {
  const guestId = await getOrCreateGuestUser();
  // Proceed with action
} else {
  // Use temporary session ID
  const tempId = getTempSessionId();
  // Proceed with read-only action
}
```

**Pros:**
- Eliminates most unnecessary guest creations
- Reduces database load
- Only creates guests for actual users
- No privacy concerns

**Cons:**
- Requires tracking temporary sessions
- More complex implementation
- Need to migrate temp sessions to guests on first action

**Verdict:** ✅ **Highly recommended for long-term solution**

### Strategy 6: Cookie Validation with Short-Term Cache ✅ RECOMMENDED

**Feasibility:** High

**Approach:** Validate guest cookie against database with a short-term cache (e.g., 1 minute) to detect and reuse recently created guests.

**Implementation:**
```typescript
// Use Redis to track recently created guests by IP
async function findRecentGuestByIP(ip: string): Promise<string | null> {
  const cacheKey = `guest:recent:${ip}`;
  const guestId = await redis.get(cacheKey);
  return guestId;
}

async function createGuestUser(ip: string): Promise<string> {
  // Check if there's a recent guest for this IP
  const recentGuest = await findRecentGuestByIP(ip);
  if (recentGuest) {
    return recentGuest; // Reuse existing guest
  }

  // Create new guest
  const guestId = await generateId();
  await dbWrite.insert(users).values({ userId: guestId, isGuest: true });
  
  // Cache for 5 minutes
  await redis.setex(`guest:recent:${ip}`, 300, guestId);
  
  return guestId;
}
```

**Pros:**
- Reduces duplicates from concurrent requests
- Simple to implement
- Works with existing infrastructure (Redis)
- Time-limited (privacy-friendly)

**Cons:**
- IP-based (shared IP issues, but time-limited reduces impact)
- Still creates some duplicates (but much fewer)

**Verdict:** ✅ **Recommended as complementary solution**

## Recommended Solution

### Immediate Fix (Implement Now)

**Combine Strategy 4 + Strategy 6:**

1. **In-flight request deduplication** per client identifier (IP + user agent)
2. **Short-term IP-based cache** (5 minutes) to reuse recent guests
3. **Cookie validation** to detect and reuse existing guests

### Long-Term Solution (Implement Later)

**Implement Strategy 5: Lazy guest creation**

1. Use temporary session IDs for read-only requests
2. Only create guest users on first write action
3. Migrate temporary sessions to guests on first action
4. Clean up unused temporary sessions periodically

## Implementation Plan

### Phase 1: Immediate Fix (Backend)

**File:** `src/middleware/guest.ts`

1. Add in-flight request deduplication
2. Add short-term IP-based cache
3. Improve cookie validation logic
4. Add logging to track guest creation patterns

### Phase 2: Frontend Optimization

**File:** Next.js app configuration

1. Disable prefetch for guest users
2. Add client-side request deduplication
3. Batch API calls where possible
4. Add guest cookie check before making requests

### Phase 3: Long-Term Solution

**Files:** Multiple (backend + frontend)

1. Implement temporary session system
2. Add lazy guest creation
3. Add session migration logic
4. Add cleanup job for unused sessions

## Frontend Recommendations

### 1. Disable Prefetch for Guest Users

```typescript
// In Next.js Link components
<Link href="/books/123" prefetch={isAuthenticated}>
  Book 123
</Link>
```

### 2. Add Request Deduplication

```typescript
// Use a client-side request cache
const requestCache = new Map<string, Promise<any>>();

async function fetchWithDedup(url: string, options: RequestInit) {
  const cacheKey = `${url}:${JSON.stringify(options)}`;
  
  if (requestCache.has(cacheKey)) {
    return requestCache.get(cacheKey);
  }
  
  const promise = fetch(url, options);
  requestCache.set(cacheKey, promise);
  
  try {
    return await promise;
  } finally {
    requestCache.delete(cacheKey);
  }
}
```

### 3. Check Guest Cookie Before Requests

```typescript
// Only make requests if guest cookie exists
function hasGuestCookie(): boolean {
  return document.cookie.includes('twistloom_guest_id');
}

// Wait for cookie before making requests
async function waitForGuestCookie(): Promise<void> {
  let attempts = 0;
  while (!hasGuestCookie() && attempts < 10) {
    await new Promise(resolve => setTimeout(resolve, 100));
    attempts++;
  }
}
```

### 4. Batch API Calls

```typescript
// Instead of multiple individual requests
const user = await fetch('/api/user');
const books = await fetch('/api/books');
const checkin = await fetch('/api/user/checkin/status');

// Use a single endpoint that returns all data
const data = await fetch('/api/user/dashboard');
```

## Backend Implementation

### Enhanced Guest Middleware

```typescript
// Client identifier based on IP + user agent
function getClientId(req: Request): string {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const userAgent = req.get('user-agent') || 'unknown';
  return `${ip}:${userAgent}`;
}

// In-flight request deduplication
const inFlightGuestCreations = new Map<string, Promise<string>>();

async function getOrCreateGuestUser(req: Request): Promise<string> {
  const clientId = getClientId(req);
  
  // Check in-flight requests
  const existing = inFlightGuestCreations.get(clientId);
  if (existing) {
    console.log('[guest] ⏳ Waiting for in-flight guest creation:', clientId);
    return existing;
  }
  
  // Check short-term IP cache
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const recentGuest = await findRecentGuestByIP(ip);
  if (recentGuest) {
    console.log('[guest] ♻️ Reusing recent guest:', recentGuest);
    return recentGuest;
  }
  
  // Create new guest
  const promise = createGuestUser(ip);
  inFlightGuestCreations.set(clientId, promise);
  
  try {
    return await promise;
  } finally {
    inFlightGuestCreations.delete(clientId);
  }
}
```

### Redis Cache for Recent Guests

```typescript
async function findRecentGuestByIP(ip: string): Promise<string | null> {
  const cacheKey = `guest:recent:${ip}`;
  const guestId = await redis.get(cacheKey);
  return guestId;
}

async function cacheGuestByIP(ip: string, guestId: string): Promise<void> {
  const cacheKey = `guest:recent:${ip}`;
  // Cache for 5 minutes
  await redis.setex(cacheKey, 300, guestId);
}
```

## Monitoring and Metrics

### Track Guest Creation Patterns

```typescript
// Log guest creation with context
console.log('[guest] 🆕 Created guest:', {
  guestId,
  ip: req.ip,
  userAgent: req.get('user-agent'),
  referer: req.get('referer'),
  isPrefetch: req.query.prefetch === 'true',
  timestamp: new Date().toISOString(),
});
```

### Metrics to Monitor

1. **Guest creation rate per minute**
2. **Duplicate guest rate** (same IP within 5 minutes)
3. **Guest user activity** (how many guests actually create content)
4. **Guest to auth conversion rate**
5. **Cookie hit rate** (requests with vs without cookie)

## Summary

### Root Cause
Concurrent requests from Next.js prefetches, SSR, and client-side API calls create race conditions where each request creates a new guest user before the cookie is set.

### IP/MAC Address Deduplication
- **IP-based:** ❌ Not recommended (shared IPs, privacy concerns)
- **MAC address:** ❌ Technically impossible (not accessible in HTTP)

### Recommended Solutions
1. **Immediate:** In-flight request deduplication + short-term IP cache
2. **Long-term:** Lazy guest creation with temporary sessions

### Expected Impact
- Reduce duplicate guest creation by 80-90%
- Improve database performance
- Better user experience
- More accurate analytics
