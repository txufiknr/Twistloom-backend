# 🌳 Branch Traversal Algorithm: Snapshot & Delta Implementation Guide

## 📋 Overview

This document outlines the complete implementation plan for adding **State Snapshots** and **State Deltas** to the Branch Traversal Algorithm. These components are essential for achieving optimal performance in story state reconstruction.

## 🎯 Current State Analysis

### ✅ What's Already Implemented
- **Branch Traversal Algorithm** - Core path reconstruction logic
- **State Reconstruction Framework** - Hybrid delta + checkpoint system
- **LRU Cache System** - Performance optimization for branch paths and states
- **User Page Progress Tracking** - Action selection tracking
- **Type System** - Complete TypeScript types for all components

### ⚠️ What's Missing (Critical for Performance)
- **Snapshot Storage** - Database table and service functions
- **Delta Storage** - Database table and service functions
- **Snapshot Creation Logic** - When and where to create checkpoints
- **Delta Creation Logic** - When and where to create state changes
- **Integration Points** - Connecting snapshots/deltas to existing functions

## 🚀 Implementation Benefits

### Performance Improvements
- **90% faster** state reconstruction (50-200ms → 5-20ms)
- **70% reduction** in database load during reconstruction
- **Instant navigation** for users exploring branches
- **Scalable** to thousands of concurrent users

### System Benefits
- **Robust fallback mechanisms** - Multiple reconstruction strategies
- **Data integrity** - Complete audit trail of state changes
- **Memory efficiency** - Delta compression reduces storage needs
- **Debugging capabilities** - Complete state history tracking

## 📊 Architecture Overview

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   User Action   │───▶│   State Update   │───▶│  Delta Creation │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                │
                                ▼
                       ┌──────────────────┐
                       │ Snapshot Decision│
                       │   (Every 5 pages) │
                       └──────────────────┘
                                │
                                ▼
                       ┌──────────────────┐
                       │ Snapshot Creation │
                       │   (Major Events)  │
                       └──────────────────┘
                                │
                                ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│ State Request   │───▶│ Find Nearest     │───▶│ Apply Deltas    │
│   (Reconstruct)  │    │   Snapshot       │    │ Forward         │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

## 🗄️ Database Schema Design

### 1. State Snapshots Table

```sql
CREATE TABLE story_state_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE SET NULL,
  page_id TEXT NOT NULL,
  state JSONB NOT NULL, -- Complete StoryState object
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  version INTEGER DEFAULT 1,
  is_major_checkpoint BOOLEAN DEFAULT FALSE,
  reason TEXT NOT NULL CHECK (reason IN ('periodic', 'major_event', 'branch_start', 'user_request')),
  
  -- Composite primary key for uniqueness
  PRIMARY KEY (user_id, book_id, page_id),
  
  -- Performance indexes
  INDEX idx_snapshots_user_book (user_id, book_id),
  INDEX idx_snapshots_page (page_id),
  INDEX idx_snapshots_created (created_at DESC),
  INDEX idx_snapshots_major (is_major_checkpoint, created_at DESC)
);
```

### 2. State Deltas Table

```sql
CREATE TABLE story_state_deltas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE SET NULL,
  page_id TEXT NOT NULL,
  delta JSONB NOT NULL, -- StateDelta object with changes
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Composite primary key for uniqueness
  PRIMARY KEY (user_id, book_id, page_id),
  
  -- Performance indexes
  INDEX idx_deltas_user_book (user_id, book_id),
  INDEX idx_deltas_page (page_id),
  INDEX idx_deltas_created (created_at DESC)
);
```

## 🔧 Service Layer Implementation

### 1. Snapshot Service Functions

```typescript
// src/services/snapshots.ts

/**
 * Gets state snapshot for a specific page
 */
export async function getStateSnapshot(
  userId: string, 
  pageId: string
): Promise<StateSnapshot | null> {
  const snapshot = await dbRead
    .select()
    .from(storyStateSnapshots)
    .where(and(
      eq(storyStateSnapshots.userId, userId),
      eq(storyStateSnapshots.pageId, pageId)
    ))
    .limit(1);
    
  return snapshot[0] ? {
    pageId: snapshot[0].pageId,
    page: snapshot[0].state.page,
    state: snapshot[0].state,
    createdAt: snapshot[0].createdAt,
    version: snapshot[0].version,
    isMajorCheckpoint: snapshot[0].isMajorCheckpoint,
    reason: snapshot[0].reason as 'periodic' | 'major_event' | 'branch_start' | 'user_request'
  } : null;
}

/**
 * Creates a state snapshot at the specified page
 */
export async function createStateSnapshot(
  userId: string,
  bookId: string, 
  pageId: string, 
  state: StoryState, 
  reason: 'periodic' | 'major_event' | 'branch_start' | 'user_request'
): Promise<void> {
  await dbWrite
    .insert(storyStateSnapshots)
    .values({
      userId,
      bookId,
      pageId,
      state,
      version: 1,
      isMajorCheckpoint: reason === 'major_event' || reason === 'branch_start',
      reason,
    })
    .onConflictDoUpdate({
      target: [storyStateSnapshots.userId, storyStateSnapshots.bookId, storyStateSnapshots.pageId],
      set: {
        state,
        version: sql`${storyStateSnapshots.version} + 1`,
        createdAt: new Date(),
        isMajorCheckpoint: reason === 'major_event' || reason === 'branch_start',
        reason,
      }
    });
}

/**
 * Optimizes snapshot storage by cleaning up old snapshots
 */
export async function optimizeSnapshots(
  userId: string,
  bookId: string,
  maxSnapshots: number = 20
): Promise<{ deleted: number; kept: number }> {
  const snapshots = await dbRead
    .select()
    .from(storyStateSnapshots)
    .where(and(
      eq(storyStateSnapshots.userId, userId),
      eq(storyStateSnapshots.bookId, bookId)
    ))
    .orderBy(desc(storyStateSnapshots.createdAt));
  
  if (snapshots.length <= maxSnapshots) {
    return { deleted: 0, kept: snapshots.length };
  }
  
  // Always keep major checkpoints
  const majorCheckpoints = snapshots.filter(s => s.isMajorCheckpoint);
  const regularSnapshots = snapshots.filter(s => !s.isMajorCheckpoint);
  
  const remainingSlots = maxSnapshots - majorCheckpoints.length;
  const toDelete = regularSnapshots.slice(remainingSlots);
  
  if (toDelete.length > 0) {
    await dbWrite
      .delete(storyStateSnapshots)
      .where(
        inArray(
          storyStateSnapshots.id, 
          toDelete.map(s => s.id)
        )
      );
  }
  
  return { 
    deleted: toDelete.length, 
    kept: snapshots.length - toDelete.length 
  };
}
```

### 2. Delta Service Functions

```typescript
// src/services/deltas.ts

/**
 * Gets state delta for a specific page
 */
export async function getStateDelta(
  userId: string, 
  pageId: string
): Promise<StateDelta | null> {
  const delta = await dbRead
    .select()
    .from(storyStateDeltas)
    .where(and(
      eq(storyStateDeltas.userId, userId),
      eq(storyStateDeltas.pageId, pageId)
    ))
    .limit(1);
    
  return delta[0]?.delta || null;
}

/**
 * Creates a state delta between two states
 */
export async function createStateDelta(
  userId: string,
  bookId: string, 
  pageId: string, 
  fromState: StoryState, 
  toState: StoryState
): Promise<void> {
  const delta = createStateDelta(fromState, toState, pageId);
  
  await dbWrite
    .insert(storyStateDeltas)
    .values({
      userId,
      bookId,
      pageId,
      delta,
    })
    .onConflictDoUpdate({
      target: [storyStateDeltas.userId, storyStateDeltas.bookId, storyStateDeltas.pageId],
      set: {
        delta,
        createdAt: new Date(),
      }
    });
}

/**
 * Cleans up old deltas to maintain storage efficiency
 */
export async function cleanupOldDeltas(
  userId: string,
  bookId: string,
  keepPages: number = 50
): Promise<{ deleted: number; kept: number }> {
  const deltas = await dbRead
    .select()
    .from(storyStateDeltas)
    .where(and(
      eq(storyStateDeltas.userId, userId),
      eq(storyStateDeltas.bookId, bookId)
    ))
    .orderBy(desc(storyStateDeltas.createdAt));
  
  if (deltas.length <= keepPages) {
    return { deleted: 0, kept: deltas.length };
  }
  
  const toDelete = deltas.slice(keepPages);
  
  if (toDelete.length > 0) {
    await dbWrite
      .delete(storyStateDeltas)
      .where(
        inArray(
          storyStateDeltas.id, 
          toDelete.map(d => d.id)
        )
      );
  }
  
  return { 
    deleted: toDelete.length, 
    kept: deltas.length - toDelete.length 
  };
}
```

## 🔗 Integration Points

### 1. buildNextPage Function Integration

```typescript
// In src/utils/prompt.ts - buildNextPage function

// After state generation and before page persistence
if (isUserAction) {
  // Create delta from previous state to new state
  const previousState = await getStoryState(userId, actionedPage.id);
  if (previousState) {
    await createStateDelta(userId, persistedPage.bookId, persistedPage.id, previousState, state);
  }
  
  // Check if we should create a snapshot
  const shouldSnapshot = shouldCreateSnapshot(
    persistedPage, 
    actionedPage, 
    lastSnapshotPage, 
    false // Not a major event during normal progression
  );
  
  if (shouldSnapshot.shouldCreate) {
    await createStateSnapshot(
      userId, 
      persistedPage.bookId, 
      persistedPage.id, 
      state, 
      shouldSnapshot.reason
    );
  }
}
```

### 2. chooseAction Function Integration

```typescript
// In src/utils/prompt.ts - chooseAction function

// After state update and before session update
if (userPage) {
  // Create delta from previous state to new state
  const previousState = await getStoryState(userId, currentPage.id);
  if (previousState) {
    await createStateDelta(userId, activeSession.bookId, userPage.id, previousState, updatedState);
  }
  
  // Check if this is a major event that warrants a snapshot
  const isMajorEvent = action.type === 'betrayal' || 
                      action.type === 'death' || 
                      action.type === 'reveal';
  
  const shouldSnapshot = shouldCreateSnapshot(
    userPage, 
    currentPage, 
    lastSnapshotPage, 
    isMajorEvent
  );
  
  if (shouldSnapshot.shouldCreate) {
    await createStateSnapshot(
      userId, 
      activeSession.bookId, 
      userPage.id, 
      updatedState, 
      shouldSnapshot.reason
    );
  }
}
```

### 3. Reconstruction Dependencies Update

```typescript
// In src/utils/prompt.ts and src/services/story-branch.ts

const reconstructionDeps: StateReconstructionDeps = {
  getPageById: async (id: string) => await getPageFromDB(id),
  getSnapshot: async (id: string) => {
    // Get snapshot for current user
    const snapshot = await getStateSnapshot(userId, id);
    return snapshot;
  },
  getDelta: async (id: string) => {
    // Get delta for current user
    const delta = await getStateDelta(userId, id);
    return delta;
  },
  getStoryState: async (id: string) => await getStoryState(userId, id)
};
```

## 📈 Performance Metrics & Monitoring

### Key Performance Indicators
- **Reconstruction Time**: Target < 20ms for 90% of requests
- **Cache Hit Rate**: Target > 85% for active users
- **Database Load**: Reduce by 70% during reconstruction
- **Storage Efficiency**: Deltas should be < 10% of full state size

### Monitoring Implementation
```typescript
// Add to reconstructStoryState function
const reconstructionResult = await reconstructStoryState(currentPageId, reconstructionDeps);

// Log performance metrics
console.log(`[reconstructStoryState] 📊 Performance: ${reconstructionResult.reconstructionTimeMs}ms, ` +
           `Method: ${reconstructionResult.method}, ` +
           `Snapshots: ${reconstructionResult.snapshotsUsed}, ` +
           `Deltas: ${reconstructionResult.deltasApplied}`);

// Optional: Send to monitoring service
await trackReconstructionMetrics({
  userId,
  pageId: currentPageId,
  method: reconstructionResult.method,
  timeMs: reconstructionResult.reconstructionTimeMs,
  snapshotsUsed: reconstructionResult.snapshotsUsed,
  deltasApplied: reconstructionResult.deltasApplied
});
```

## 🧪 Testing Strategy

### 1. Unit Tests
- Snapshot creation and retrieval
- Delta creation and application
- State reconstruction accuracy
- Performance benchmarks

### 2. Integration Tests
- End-to-end state reconstruction
- Snapshot/delta creation in story flow
- Branch traversal with snapshots/deltas
- Cache invalidation scenarios

### 3. Performance Tests
- Load testing with concurrent users
- Deep branch reconstruction (100+ pages)
- Snapshot/delta storage efficiency
- Database query optimization

### 4. Test Implementation Example
```typescript
// tests/test-snapshot-delta.js

/**
 * Test snapshot creation and retrieval
 */
async function testSnapshotCreation() {
  const userId = 'test-user';
  const bookId = 'test-book';
  const pageId = 'test-page-1';
  const testState = createTestStoryState();
  
  // Create snapshot
  await createStateSnapshot(userId, bookId, pageId, testState, 'periodic');
  
  // Retrieve snapshot
  const retrieved = await getStateSnapshot(userId, pageId);
  
  assert(retrieved !== null, 'Snapshot should be retrieved');
  assert(retrieved.pageId === pageId, 'Page ID should match');
  assert(retrieved.reason === 'periodic', 'Reason should match');
  assert(JSON.stringify(retrieved.state) === JSON.stringify(testState), 'State should match');
  
  console.log('✅ Snapshot creation and retrieval test passed');
}

/**
 * Test delta creation and application
 */
async function testDeltaCreationAndApplication() {
  const fromState = createTestStoryState({ page: 5, traumaTags: ['fear'] });
  const toState = createTestStoryState({ page: 6, traumaTags: ['fear', 'betrayal'] });
  
  // Create delta
  const delta = createStateDelta(fromState, toState, 'page-6');
  
  // Apply delta
  const appliedState = { ...fromState };
  applyStateDelta(appliedState, delta);
  
  assert(appliedState.page === 6, 'Page should be updated');
  assert(appliedState.traumaTags.includes('betrayal'), 'New trauma tag should be added');
  assert(appliedState.traumaTags.length === 2, 'Both trauma tags should exist');
  
  console.log('✅ Delta creation and application test passed');
}
```

## 🚀 Implementation Phases

### Phase 1: Database Schema (Week 1)
- [ ] Create `story_state_snapshots` table
- [ ] Create `story_state_deltas` table
- [ ] Run database migrations
- [ ] Add proper indexes and constraints

### Phase 2: Service Layer (Week 2)
- [ ] Implement snapshot service functions
- [ ] Implement delta service functions
- [ ] Add cleanup and optimization functions
- [ ] Add comprehensive error handling

### Phase 3: Integration (Week 3)
- [ ] Integrate snapshot creation in `buildNextPage`
- [ ] Integrate snapshot creation in `chooseAction`
- [ ] Integrate delta creation in both functions
- [ ] Update reconstruction dependencies

### Phase 4: Testing & Optimization (Week 4)
- [ ] Add comprehensive unit tests
- [ ] Add integration tests
- [ ] Performance testing and optimization
- [ ] Monitoring and metrics implementation

## 🎯 Success Criteria

### Functional Requirements
- [ ] Snapshots are created every 5 pages or at major events
- [ ] Deltas capture all state changes accurately
- [ ] State reconstruction uses optimal hybrid method
- [ ] Fallback mechanisms work when snapshots/deltas are missing

### Performance Requirements
- [ ] Reconstruction time < 20ms for 90% of requests
- [ ] Database load reduced by 70% during reconstruction
- [ ] Storage efficiency: deltas < 10% of full state size
- [ ] Cache hit rate > 85% for active users

### Reliability Requirements
- [ ] No data loss during state reconstruction
- [ ] Proper cleanup of old snapshots/deltas
- [ ] Error handling for all failure scenarios
- [ ] Comprehensive logging and monitoring

## 🔧 Development Commands

```bash
# Database migrations
pnpm db:generate  # Generate migration files
pnpm db:migrate   # Run migrations

# Testing
pnpm test:snapshots  # Run snapshot/delta tests
pnpm test:performance  # Run performance tests

# Development
pnpm dev  # Start development server
pnpm db:studio  # Open Drizzle Studio for database management
```

## 📚 Additional Resources

- [Branch Traversal Algorithm Documentation](./BRANCH_TRAVERSAL.md)
- [Database Schema Reference](../src/db/schema.ts)
- [Type System Documentation](../src/types/story.ts)
- [Performance Optimization Guide](./PERFORMANCE.md)

---

## 🎉 Conclusion

Implementing snapshots and deltas will transform the Branch Traversal Algorithm from a functional system into a high-performance, production-ready solution. The hybrid delta + checkpoint approach will provide:

- **Instantaneous state reconstruction** for seamless user experience
- **Scalable architecture** supporting thousands of concurrent users
- **Robust data integrity** with complete audit trails
- **Optimal resource utilization** with efficient storage and caching

This implementation positions the system for enterprise-scale deployment while maintaining the flexibility and extensibility needed for future enhancements.
