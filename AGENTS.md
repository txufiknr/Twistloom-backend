# AI Agent Development Guidelines

## 📋 Overview

This document outlines the coding standards, conventions, and best practices for AI agents working on the Muslim Digest backend project. Following these guidelines ensures consistency, maintainability, and high-quality code across the codebase.

---

## 🛠️ Technology Stack

### Core Technologies
- **Runtime**: Node.js 20+
- **API Framework**: Express.js
- **Database**: Neon (PostgreSQL)
- **ORM**: Drizzle ORM
- **Language**: TypeScript
- **Package Manager**: pnpm

### Development Tools
- **Build**: TypeScript compiler
- **Linting**: ESLint
- **Database Management**: Drizzle Kit
- **Migrations**: Drizzle migrations
- **Hosting**: Vercel/Netlify/Fly.io (serverless)

---

## 📝 Coding Standards

### Naming Conventions

| Element | Style | Examples |
|---------|-------|----------|
| **Files** | `kebab-case` | `feed-service.ts`, `user-preferences.ts`, `rss-ingester.ts` |
| **Constants** | `UPPER_SNAKE_CASE` | `FEED_DAILY_LIMIT`, `DEFAULT_PAGE_SIZE`, `CACHE_TTL` |
| **Variables** | `camelCase` | `userId`, `feedItems`, `cursorPosition` |
| **Functions** | `camelCase` | `fetchPersonalizedFeed`, `calculateBreakingScore` |
| **Classes** | `PascalCase` | `FeedService`, `ArticleCluster`, `UserPreferences` |
| **Interfaces** | `PascalCase` | `FeedCursor`, `FormattedFeedRow`, `FetchFeedPageParams` |

### Variable & Constant Naming
- **Be descriptive**: Use clear, self-explanatory names
- **Avoid abbreviations**: `articleCount` instead of `artCnt`
- **Be consistent**: Use the same terminology throughout the codebase
- **Include units**: When relevant, include units in names (`timeoutMs`, `retryCount`)

```typescript
// ✅ Good
const MAX_RETRY_ATTEMPTS = 3;
const articleProcessingTimeoutMs = 5000;
const userFeedPreferences = await getUserPreferences(userId);

// ❌ Bad
const max_rt = 3;
const to = 5000;
const prefs = await getUserPrefs(uid);
```

---

## 📚 Documentation Standards

### TSDoc/JSDoc Requirements
**Always write comprehensive TSDoc/JSDoc comments** for:
- All exported functions
- All interfaces and types
- All classes
- Complex internal functions

#### Function Documentation Template
```typescript
/**
 * Brief description of what the function does
 * 
 * Detailed explanation of the function's purpose, behavior, and any important details.
 * Include edge cases, performance considerations, or usage patterns.
 * 
 * @param paramName - Description of the parameter and its expected type/behavior
 * @param optionalParam - Optional parameter description (default: defaultValue)
 * @returns Description of what the function returns and its structure
 * 
 * @example
 * ```typescript
 * // Basic usage example
 * const result = await functionName(param1, param2);
 * 
 * // Advanced usage with options
 * const advanced = await functionName({
 *   option1: true,
 *   option2: 'custom-value'
 * });
 * ```
 */
```

#### Interface Documentation Template
```typescript
/**
 * Description of what this interface represents
 * 
 * @example
 * ```typescript
 * const example: InterfaceName = {
 *   property1: 'value',
 *   property2: 123
 * };
 * ```
 */
interface InterfaceName {
  /** Description of property1 */
  property1: string;
  /** Description of property2 with optional details */
  property2: number;
}
```

### Inline Comments
**Use inline comments sparingly** to explain:
- Complex business logic
- Non-obvious algorithms
- Important decisions or workarounds
- Performance-critical sections

#### Comment Style Guidelines
- **Be concise**: Keep comments short and to the point
- **Explain why, not what**: Focus on the reasoning behind the code
- **Keep them updated**: Remove outdated comments immediately
- **Use numbered steps for complex flows**: When explaining multi-step processes

```typescript
// ✅ Good - Explains complex logic
// Process query results: check pagination, slice to correct size, format data, and prepare next cursor
const hasNext = rows.length > itemsPerPage;
const sliced = rows.slice(0, itemsPerPage);
const items = formatFeedRows(sliced);

// ✅ Good - Explains business reasoning
// Skip items with negative scores (user doesn't want to see these)
if (score < 0) continue;

// ❌ Bad - Obvious code
// Increment counter
counter++;
```

---

## 🏗️ Code Quality Standards

### Type Safety
- **Avoid `any` type**: Always use proper TypeScript types
- **Use interfaces**: Define clear interfaces for complex objects
- **Leverage generics**: Use generics for reusable components
- **Type assertions**: Prefer type guards over type assertions

```typescript
// ✅ Good
interface FeedItem {
  id: string;
  title: string;
  publishedAt: Date;
}

function processFeedItem(item: FeedItem): FormattedFeedItem {
  return {
    ...item,
    formattedTitle: item.title.toUpperCase()
  };
}

// ❌ Bad
function processItem(item: any): any {
  return {
    ...item,
    formattedTitle: (item as any).title.toUpperCase()
  };
}
```

### DRY Principle (Don't Repeat Yourself)
- **Extract common logic**: Create helper functions for repeated code
- **Use composition**: Combine small functions to create complex behavior
- **Share types**: Define common interfaces and types
- **Consolidate similar operations**: Group related functionality

```typescript
// ✅ Good - Extracted common logic
const createBaseItem = (row: FeedRow) => ({
  ...row,
  isBreaking: isBreaking({
    firstPublishedAt: row.publishedAt,
    articleCount: row.cluster.articleCount || 1,
  }),
});

// ❌ Bad - Repeated code
processed.push({
  ...row,
  isBreaking: isBreaking({
    firstPublishedAt: row.publishedAt,
    articleCount: row.cluster.articleCount || 1,
  }),
});
```

### Error Handling
- **Use consistent error patterns**: Follow existing error handling patterns
- **Provide context**: Include relevant information in error messages
- **Handle async errors**: Always handle promise rejections
- **Log appropriately**: Use structured logging for debugging

```typescript
// ✅ Good
export async function fetchFeedPage(params: FetchFeedPageParams = {}): Promise<CursorPage<FormattedFeedRow>> {
  try {
    const query = buildFeedBaseQuery(params.cursor);
    const rows = await query.limit(params.itemsPerPage || FEED_PER_PAGE).execute();
    return formatFeedResults(rows);
  } catch (error) {
    throw new Error(`Failed to fetch feed page: ${error.message}`);
  }
}
```

---

## 🎯 Project-Specific Conventions

### Database Operations
- **Use Drizzle ORM**: All database operations should use Drizzle
- **Type-safe queries**: Leverage Drizzle's type safety
- **Connection management**: Use the existing database connection pattern
- **Migrations**: Always create migrations for schema changes

### API Design
- **Consistent responses**: Use standard response formats
- **Error responses**: Follow existing error response patterns
- **Validation**: Validate inputs at route level
- **Caching**: Implement caching for expensive operations

### Performance Considerations
- **Database queries**: Optimize for serverless execution
- **Caching strategy**: Use multi-level caching (database + in-memory)
- **Bundle size**: Keep dependencies minimal
- **Cold starts**: Optimize for fast initialization

---

## 📋 Code Review Checklist

### Before Submitting Code
- [ ] All functions have proper TSDoc/JSDoc comments
- [ ] Naming conventions are followed consistently
- [ ] No `any` types are used (unless absolutely necessary)
- [ ] Code is DRY - no duplication detected
- [ ] Error handling is implemented
- [ ] Types are properly defined and used
- [ ] Inline comments explain complex logic
- [ ] Database operations use Drizzle ORM
- [ ] Performance considerations are addressed

### Common Issues to Watch For
- Missing type annotations
- Inconsistent naming
- Duplicate code patterns
- Unhandled promise rejections
- Missing error handling
- Over-commenting obvious code
- Under-commenting complex logic

---

## 🔧 Development Workflow

### File Organization
```
src/
├── cron/            # Cron jobs
├── routes/          # API route handlers
├── services/        # Business logic services
├── db/              # Database models and schemas
├── utils/           # Utility functions
├── types/           # TypeScript type definitions
├── middleware/      # Express middleware
└── config/          # Configuration files
```

### Import Organization
```typescript
// 1. Node.js built-ins
import { createHash } from 'crypto';

// 2. External dependencies
import express from 'express';
import { eq, desc } from 'drizzle-orm';

// 3. Internal modules (relative imports with `.js` extension)
import { db } from '../config/database.js';
import { FeedRow } from '../types/feed.js';
import { formatFeedRows } from '../services/feed.js';
```

---

## 💻 Development Commands

> **🔧 PowerShell Command Separator**
> 
> **Use `;` as command separator in PowerShell** to chain multiple commands:
> 
> ```powershell
> # Example: Navigate to project and run test script
> cd "e:\Flutter\MuslimDigest\backend-neon"; pnpm tsx test-hero-image.js
> 
> # Example: Test API request
> (Invoke-WebRequest -Uri "https://muslim-digest-backend.vercel.app/api/feed/saved?limit=15&collection=My+First+Collection" -Method GET -Headers @{"Content-Type"="application/json"; "X-Client-Id"="019ceaae-23e5-77af-9fcf-d6b21032f57d"; "X-App-Version"="1.0.4-beta"; "X-Platform"="android"} -UseBasicParsing).Content
> 
> # Example: Clean up test files and run type checking
> Remove-Item test-*.js; pnpm typecheck
> ```

### Development Scripts
```bash
pnpm dev          # Start development server with hot reload
pnpm dev:cron     # Run ingestion cron job locally
pnpm dev:cron:cleanup    # Run cleanup cron job locally
pnpm dev:cron:rss-finder   # Run RSS finder cron job locally
pnpm dev:cron:embeddings  # Run embeddings cron job locally
```

### Production Scripts
```bash
pnpm start          # Start production server
pnpm start:cron     # Run ingestion cron job in production
pnpm start:cron:cleanup    # Run cleanup cron job in production
pnpm start:cron:rss-finder   # Run RSS finder cron job in production
pnpm start:cron:embeddings  # Run embeddings cron job in production
```

### Build & Quality Scripts
```bash
pnpm build         # Build TypeScript to JavaScript
pnpm typecheck      # Run TypeScript type checking
pnpm lint          # Run ESLint on all files
pnpm lint:fix       # Auto-fix ESLint issues
pnpm lint:fast      # Run ESLint without promise checks
```

### Database Scripts
```bash
pnpm db:generate   # Generate database migrations
pnpm db:migrate    # Run database migrations
pnpm db:studio      # Open Drizzle Studio GUI
pnpm db:seed       # Seed database with initial data
pnpm db:test       # Test database connection
pnpm db:clear      # Clear all database data
pnpm db:reset      # Reset database (clear + migrate + seed)
```

### Lock Management Scripts
```bash
pnpm lock:clear    # Clear all distributed locks
pnpm lock:list     # List active distributed locks
pnpm lock:check    # Check lock status
```

## 🧪 Testing Guidelines

### Test File Format
Use Node.js testing approach with TypeScript and ES modules.

**Only create and run tests when explicitly requested** by the user (on-demand testing).

### Test Execution Format
```bash
# Windows PowerShell (use semicolon separator)
cd "e:\Flutter\MuslimDigest\backend-neon"; pnpm tsx test-something.js
cd "e:\Flutter\MuslimDigest\backend-neon"; Remove-Item test-*.js
# Or use pnpm for package scripts
pnpm dev:cron
```

### Test Best Practices
- **Create isolated test files** for specific debugging
- **Use descriptive names** like `test-aljazeera-feed.js`
- **Clean up test files** after debugging is complete
- **Document test purpose** and expected outcomes
- **Test without database dependencies** when possible
- **Create simple tests that don't require the database or full app dependencies**
- **Delete all temporary test files afterwards**

---

## 📖 Additional Resources

### Documentation References
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [Drizzle ORM Documentation](https://orm.drizzle.team/)
- [Express.js Guide](https://expressjs.com/en/guide/)
- [Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices)

### Project References
- README.md for project overview and setup
- Database schema files for data models
- Route files for API patterns
- Service files for business logic examples

---

*This document should be updated as the project evolves and new patterns emerge. All contributors should follow these guidelines to maintain code quality and consistency.*
