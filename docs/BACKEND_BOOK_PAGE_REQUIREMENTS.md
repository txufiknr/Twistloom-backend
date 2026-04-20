# Backend Requirements: Book Page API for Branching Stories

## Overview

This document outlines the backend API requirements for the Twistloom reader page with branching story support. The frontend has been migrated to support branch-aware URLs.

## URL Structure

### Frontend URLs
```
/books/[slug]/[branchId]/[page]
```

### API Endpoints
```
GET    /api/books/:identifier/:branchId/:page
POST   /api/books/:identifier/generate
```

**Where:**
- `identifier`: Book identifier (can be UUID v7 or slug string)
- `branchId` (GET only): Branch identifier for branching stories (e.g., "main", "abc123")
- `page` (GET only): Page number within the branch (1-indexed)

**Note on POST URL:**
- POST endpoint does not include `branchId` in URL
- Backend resolves branchId from the page's parent or session
- This simplifies the API since branchId is stored in the pages table

## Book Identifier Resolution

### Requirement: Accept Both Slug and UUID

The backend must handle both slug and UUID interchangeably at the same endpoint level.

### Null Slug Handling

**Backend Behavior:**
- Return `slug: null` when slug is not implemented or not provided by author
- Do not auto-fill slug with bookId (keep data honest)
- Frontend will handle fallback to bookId when slug is null

**Frontend Behavior:**
- Use `book.slug || book.id` to fallback to bookId when slug is null
- This ensures URLs are always valid even before slug implementation
- Example: `/books/${book.slug || book.id}/main/1`

**Rationale:**
- Backend data remains honest (null means not implemented)
- Frontend has flexibility to handle the fallback
- No breaking changes when slugs are implemented later

### Resolution Logic

```typescript
async function resolveBook(identifier: string) {
  // 1. Try to lookup by slug first
  const bookBySlug = await db.query.books.findFirst({
    where: eq(books.slug, identifier)
  });

  if (bookBySlug) {
    return bookBySlug;
  }

  // 2. Fallback to UUID lookup
  if (isValidUuid(identifier)) {
    const bookById = await db.query.books.findFirst({
      where: eq(books.id, identifier)
    });

    if (bookById) {
      return bookById;
    }
  }

  // 3. Return 404 if neither found
  throw new NotFoundError('Book not found');
}
```

### Notes

- **Slug priority:** Try slug first for SEO and user-friendly URLs
- **UUID fallback:** If slug lookup fails, try UUID v7 format
- **Validation:** Use `isValidUuid()` to detect UUID v7 format (36 chars)
- **Future-proof:** This allows implementing slugs later without frontend changes

## API Endpoints

### 1. Get Book Page

**Endpoint:** `GET /api/books/:identifier/:branchId/:page`

**Description:** Retrieve a specific page within a branch of a book.

**Request Parameters:**
- `identifier` (string): Book slug or UUID v7
- `branchId` (string): Branch identifier (e.g., "main", "abc123")
- `page` (string): Page number within the branch

**Response Format:**
```json
{
  "page": {
    "id": "page123",
    "page": 1,
    "bookId": "book456",
    "branchId": "main",
    "parentId": null,
    "text": "The hallway stretched endlessly before me...",
    "mood": "eerie",
    "place": "haunted mansion",
    "actions": [
      {
        "text": "Investigate the noise",
        "type": "explore",
        "hint": "investigate",
        "pageId": "page456"
      },
      {
        "text": "Take a different path",
        "type": "escape",
        "hint": "flee"
        // pageId undefined - needs generation
      }
    ]
  },
  "book": {
    "id": "book456",
    "title": "Twistloom",
    "slug": "twistloom"
  }
}
```

**Response Fields:**
- `page`: The requested page with full database fields
  - `id`: Page UUID
  - `page`: Page number within branch
  - `bookId`: Book UUID
  - `branchId`: Branch identifier
  - `parentId`: Parent page UUID
  - `text`: Page content
  - `mood`, `place`: Page metadata
  - `actions`: Array of branching actions (full Action objects)
- `book`: Book metadata for context
  - `id`: Book UUID
  - `title`: Book title
  - `slug`: Book slug (may be null)

**Branching Choice Fields (from backend Action type):**
- `text`: Choice text displayed to user
- `type`: Action category (ActionType enum)
- `hint`: Consequence hint for AI guidance
- `pageId`: (optional) UUID of destination page if it exists

**Frontend BranchingChoice Type:**

The frontend uses a derived type that extends the backend Action with URL-friendly fields:

```typescript
type BranchingChoice = {
  id: string;           // Derived from action index or backend-provided
  text: string;         // From backend Action.text
  pageId?: string;     // From backend Action.pageId
  nextPageNumber?: number;   // Derived from destination page.page
  nextBranchId?: string;      // Derived from destination page.branchId
  shouldGenerate?: boolean;   // Derived: true if pageId is undefined
};
```

**Frontend Logic:**
- Backend returns full Action objects with `pageId` if page exists
- Frontend fetches destination page metadata (page, branchId) if needed
- Or backend includes nextPageNumber and nextBranchId in Action (optional optimization)
- If `pageId` is undefined → page needs generation → use Button with API call
- If `pageId` exists → page already generated → use Link component (instant navigation)

**URL Construction:**
- Frontend uses `book.slug || book.id` for book identifier
- Frontend uses page's `branchId` and `page` for navigation
- Example: `/books/${book.slug || book.id}/${page.branchId}/${page.page}`

**Error Responses:**
- `404 Not Found`: Book, branch, or page not found
- `400 Bad Request`: Invalid parameters

**Database Query:**
```sql
-- Resolve book by identifier
SELECT * FROM books
WHERE slug = :identifier OR id = :identifier
LIMIT 1;

-- Get page within branch
SELECT * FROM pages
WHERE book_id = :bookId
  AND branch_id = :branchId
  AND page = :page
LIMIT 1;

-- Get branching choices
SELECT * FROM pages
WHERE parent_id = :currentPageId
  AND branch_id = :branchId
ORDER BY page;
```

**Special Case - Root Branch ("main"):**
- If `branchId` is "main", treat as root branch (pages with no parent or branchId = "main")
- Backend should have a default branch identifier for the root path

---

### 2. Generate Next Page

**Endpoint:** `POST /api/books/:identifier/generate`

**Description:** Generate a new page dynamically based on user's branching choice.

**Request Parameters:**
- `identifier` (string): Book slug or UUID v7

**Request Body:**
```json
{
  "actionText": "Investigate the noise",
  "currentPageId": "page123",  // Current page ID (optional, for validation)
  "branchId": "main"           // Current branch ID (optional, for validation)
}
```

**Request Body Fields:**
- `actionText`: Chosen branching action text
- `currentPageId` (optional): Current page ID for validation against user's session
- `branchId` (optional): Current branch ID for validation

**Validation:**
- Backend validates `currentPageId` and `branchId` against user's active session
- If provided, ensures user is on the correct page before generating
- If not provided, backend uses user's active session to determine current page

**Response Format:**
```json
{
  "page": {
    "id": "page456",
    "page": 2,
    "bookId": "book123",
    "branchId": "abc123",
    "parentId": "page123",
    "text": "I decided to take the different path...",
    "mood": "eerie",
    "place": "haunted mansion",
    "actions": [
      {
        "text": "Continue forward",
        "type": "explore",
        "hint": "investigate",
        "pageId": "page789"
      }
    ]
  },
  "bookProgress": {
    "currentPage": "page456"
  }
}
```

**Response Fields:**
- `page`: The generated page with full database fields
  - `id`: Page UUID
  - `page`: Page number within branch (renamed from `page` in schema)
  - `bookId`: Book UUID
  - `branchId`: Branch identifier
  - `parentId`: Parent page UUID
  - `text`: Page content
  - `mood`, `place`: Page metadata
  - `actions`: Array of branching actions (full Action objects from database)
- `bookProgress`: Updated user progress
  - `currentPage`: Current page UUID

**Note on Actions:**
- Backend stores full Action objects in pages table (text, type, hint, pageId)
- Frontend receives full Action objects from backend
- Frontend can construct URLs using pageId, page, branchId from page data

**Error Responses:**
- `404 Not Found`: Book or current page not found
- `400 Bad Request`: Invalid choice or parameters
- `500 Internal Server Error`: AI generation failure

**Generation Logic:**
```typescript
async function generateNextPage(
  userId: string,
  bookId: string,
  actionText: string,
  currentPageId?: string,
  branchId?: string
) {
  // 1. Get user's active session
  const session = await getUserSession(userId);
  if (!session) throw new Error('No active session');

  // 2. Validate provided currentPageId and branchId against session (if provided)
  if (currentPageId && session.pageId !== currentPageId) {
    throw new Error('Invalid current page ID');
  }
  if (branchId && session.branchId !== branchId) {
    throw new Error('Invalid branch ID');
  }

  // 3. Get current page from session (or provided currentPageId)
  const currentPage = await getPage(session.pageId);

  // 4. Get the chosen action from current page's actions
  const action = currentPage.actions.find(a => a.text === actionText);
  if (!action) throw new Error('Invalid choice text');

  // 5. Check if action already has a destination page (pre-generated)
  if (action.pageId) {
    const existingPage = await getPage(action.pageId);
    return {
      page: existingPage,
      bookProgress: { currentPage: existingPage.id }
    };
  }

  // 6. Generate new page using chooseAction function
  const newPage = await chooseAction({
    userId,
    action,
    isUserAction: true
  });

  if (!newPage) throw new Error('Failed to generate page');

  return {
    page: newPage,
    bookProgress: { currentPage: newPage.id }
  };
}
```

---

## Database Schema Considerations

### Books Table
```sql
CREATE TABLE books (
  id UUID PRIMARY KEY,
  slug VARCHAR(255) UNIQUE,  -- Add this column for slug support
  title VARCHAR(255) NOT NULL,
  -- ... other fields
);
```

**Migration Required:**
- Add `slug` column to `books` table
- Create unique index on `slug`
- Initially populate with UUID or generated slugs

### Pages Table
```sql
CREATE TABLE pages (
  id UUID PRIMARY KEY,
  book_id UUID REFERENCES books(id),
  parent_id UUID REFERENCES pages(id),
  branch_id VARCHAR(255) NOT NULL,  -- Branch identifier
  page INTEGER NOT NULL,  -- Page number within branch (renamed from 'page')
  text TEXT NOT NULL,  -- 60 words max, first-person POV
  -- ... other fields
  
  UNIQUE(book_id, branch_id, page),
  INDEX(book_id, branch_id, page),
  INDEX(parent_id, branch_id)
);
```

**Schema Migration:**
- Rename `page` column to `page` for clarity
- Backend will handle this migration
- Frontend expects `page` in API responses

**Branch ID Strategy:**
- Root branch: Use "main" as default branch ID
- New branches: Generate short aliases (e.g., "abc123", "xyz789") or UUID v7
- Store branch metadata in separate table if needed (for pretty naming)

### Branch Metadata Table (Optional)
```sql
CREATE TABLE branches (
  id VARCHAR(255) PRIMARY KEY,  -- Branch ID (e.g., "main", "abc123")
  book_id UUID REFERENCES books(id),
  name VARCHAR(255),  -- Pretty name for UI (e.g., "The Dark Path")
  parent_branch_id VARCHAR(255),  -- For branch hierarchy
  created_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(book_id, id)
);
```

---

## Performance Considerations

### Caching Strategy

**ISR (Incremental Static Regeneration):**
- Cache pages for 60 seconds (matches frontend revalidate)
- Use CDN for global distribution
- Invalidate cache on page generation

**Query Optimization:**
```sql
-- Composite index for page lookup
CREATE INDEX idx_pages_book_branch_page 
ON pages(book_id, branch_id, page);

-- Index for parent-child relationship
CREATE INDEX idx_pages_parent_branch 
ON pages(parent_id, branch_id);
```

### Response Time Targets

- **Page fetch:** < 200ms (cached), < 500ms (uncached)
- **Page generation:** < 3s (AI-dependent)
- **Slug resolution:** < 50ms

---

## Authentication & Authorization

### Public Access
- Reading pages should be publicly accessible
- No authentication required for GET requests

### Generation Access
- Page generation requires authentication
- NextAuth httpOnly cookies (migrated from X-Client-Id header)
- Validate user session before generation

### Guest Users
- Support guest users for reading
- Migrate guest data on login (if tracking progress)

### Authentication Migration
- Backend currently uses `requireClientId` middleware (X-Client-Id header)
- Will migrate to NextAuth httpOnly cookies
- Frontend already sends `credentials: 'include'` for cookies
- Backend endpoint should validate NextAuth session

---

## Error Handling

### Error Codes

| Code | Description |
|------|-------------|
| `BOOK_NOT_FOUND` | Book not found by slug or UUID |
| `BRANCH_NOT_FOUND` | Branch does not exist for this book |
| `PAGE_NOT_FOUND` | Page number does not exist in branch |
| `INVALID_IDENTIFIER` | Identifier is neither valid slug nor UUID |
| `GENERATION_FAILED` | AI generation failed |
| `RATE_LIMITED` | Too many generation requests |

### Error Response Format
```json
{
  "error": {
    "code": "BOOK_NOT_FOUND",
    "message": "Book not found",
    "details": "No book found with identifier 'twistloom'"
  }
}
```

---

## Testing Requirements

### Unit Tests

1. **Book Resolution**
   - Test slug lookup
   - Test UUID lookup
   - Test invalid identifier handling

2. **Page Fetch**
   - Test existing page retrieval
   - Test non-existent page handling
   - Test branch isolation

3. **Page Generation**
   - Test new branch creation
   - Test existing branch continuation
   - Test AI failure handling

### Integration Tests

1. **End-to-end flow**
   - Start reading from page 1
   - Make branching choice
   - Navigate to generated page
   - Verify branch isolation

2. **Performance tests**
   - Measure page fetch times
   - Test concurrent requests
   - Verify cache effectiveness

---

## Migration Checklist

### Database Changes
- [ ] Add `slug` column to `books` table
- [ ] Create unique index on `slug`
- [ ] Add `branch_id` column to `pages` table (if not exists)
- [ ] Rename `page` column to `page` in `pages` table
- [ ] Create composite index on `(book_id, branch_id, page)`
- [ ] Create branch metadata table (optional)

### API Implementation
- [ ] Implement book identifier resolution logic
- [ ] Implement GET `/api/books/:identifier/:branchId/:page`
- [ ] Implement POST `/api/books/:identifier/generate`
- [ ] Add error handling for all edge cases
- [ ] Implement caching strategy

### Testing
- [ ] Write unit tests for identifier resolution
- [ ] Write integration tests for API endpoints
- [ ] Performance test with realistic data
- [ ] Test with both slug and UUID identifiers

### Documentation
- [ ] Update API documentation
- [ ] Document branch ID strategy
- [ ] Add examples for frontend team

---

## Examples

### Example 1: Read Root Branch Page

**Request:**
```
GET /api/books/twistloom/main/1
```

**Response:**
```json
{
  "page": {
    "id": "page123",
    "page": 1,
    "bookId": "book456",
    "branchId": "main",
    "parentId": null,
    "text": "The hallway stretched endlessly before me...",
    "mood": "eerie",
    "place": "haunted mansion",
    "actions": [
      {
        "text": "Continue forward",
        "type": "explore",
        "hint": "investigate",
        "pageId": "page456"
      }
    ]
  },
  "book": {
    "id": "book456",
    "title": "Twistloom",
    "slug": "twistloom"
  }
}
```

### Example 2: Generate New Branch

**Request:**
```
POST /api/books/twistloom/generate
{
  "actionText": "Investigate the noise",
  "currentPageId": "page123",
  "branchId": "main"
}
```

**Response:**
```json
{
  "page": {
    "id": "page456",
    "page": 2,
    "bookId": "book456",
    "branchId": "abc123",
    "parentId": "page123",
    "text": "I decided to investigate the noise...",
    "mood": "tense",
    "place": "haunted mansion",
    "actions": [
      {
        "text": "Continue forward",
        "type": "explore",
        "hint": "investigate",
        "pageId": "page789"
      }
    ]
  },
  "bookProgress": {
    "currentPage": "page456"
  }
}
```

### Example 3: UUID Identifier

**Request:**
```
GET /api/books/0190f1234567/abc123/1
```

**Response:** Same as slug example (backend handles resolution)

---

## Notes for Frontend Team

- Frontend uses simplified URL: `/books/[slug]/[branchId]/[page]`
- Both slug and UUID work interchangeably
- Default branch is "main" for initial read
- Branch ID is returned in API response for navigation
- Generation endpoint returns new branch ID if branching occurs
- All API responses match the format documented above
