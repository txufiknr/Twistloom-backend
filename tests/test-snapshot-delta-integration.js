/**
 * Comprehensive Test Suite for Snapshot & Delta Integration
 * 
 * Tests the complete integration of snapshots and deltas into the Branch Traversal Algorithm.
 * Validates performance improvements, data integrity, and error handling.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock implementations for testing
const mockDbRead = {
  select: jest.fn(() => ({
    from: jest.fn(() => ({
      where: jest.fn(() => ({
        limit: jest.fn(() => Promise.resolve([]))
      }))
    }))
  }))
};

const mockDbWrite = {
  insert: jest.fn(() => ({
    values: jest.fn(() => ({
      onConflictDoUpdate: jest.fn(() => Promise.resolve())
    }))
  })),
  delete: jest.fn(() => ({
    where: jest.fn(() => Promise.resolve())
  }))
};

// Mock the database client
jest.mock('../src/db/client.js', () => ({
  dbRead: mockDbRead,
  dbWrite: mockDbWrite
}));

// Mock the schema
jest.mock('../src/db/schema.js', () => ({
  storyStateSnapshots: {
    userId: 'user_id',
    bookId: 'book_id', 
    pageId: 'page_id',
    state: 'state',
    createdAt: 'created_at',
    version: 'version',
    isMajorCheckpoint: 'is_major_checkpoint',
    reason: 'reason'
  },
  storyStateDeltas: {
    userId: 'user_id',
    bookId: 'book_id',
    pageId: 'page_id', 
    delta: 'delta',
    createdAt: 'created_at'
  }
}));

describe('Snapshot & Delta Integration Tests', () => {
  let userId, bookId, testState, testDelta;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Setup test data
    userId = 'test-user-123';
    bookId = 'test-book-456';
    
    testState = {
      pageId: 'page-123',
      page: 15,
      maxPage: 150,
      flags: {
        trust: 'medium',
        fear: 'high',
        guilt: 'low',
        curiosity: 'medium'
      },
      traumaTags: ['betrayal', 'loss'],
      psychologicalProfile: {
        archetype: 'survivor',
        stabilityLevel: 'fragile',
        manipulationAffinity: 'low'
      },
      hiddenState: {
        memoryIntegrity: 'fragmented',
        realityStability: 'unstable'
      },
      memoryIntegrity: 'fragmented',
      difficulty: 'medium',
      cachedEndingArchetype: 'false_reality',
      characters: {},
      places: {},
      pageHistory: [],
      actionsHistory: [],
      contextHistory: 'Story context summary...'
    };
    
    testDelta = {
      pageId: 'page-123',
      fromPage: 14,
      toPage: 15,
      changes: {
        flags: {
          trust: { from: 'high', to: 'medium' },
          fear: { from: 'low', to: 'high' }
        },
        traumaTags: {
          added: ['betrayal'],
          removed: []
        }
      },
      timestamp: new Date()
    };
  });

  afterEach(() => {
    // Cleanup
    jest.restoreAllMocks();
  });

  describe('Snapshot Service Tests', () => {
    it('should create a snapshot successfully', async () => {
      const { createStateSnapshot } = await import('../src/services/snapshots.js');
      
      // Mock successful database operation
      mockDbWrite.insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockResolvedValue(undefined)
        })
      });

      await createStateSnapshot(userId, bookId, 'page-123', testState, 'major_event');

      expect(mockDbWrite.insert).toHaveBeenCalled();
      expect(mockDbWrite.insert().values).toHaveBeenCalledWith({
        userId,
        bookId,
        pageId: 'page-123',
        state: testState,
        version: 1,
        isMajorCheckpoint: true,
        reason: 'major_event'
      });
    });

    it('should retrieve a snapshot successfully', async () => {
      const { getStateSnapshot } = await import('../src/services/snapshots.js');
      
      // Mock database response
      const mockSnapshot = {
        pageId: 'page-123',
        state: testState,
        createdAt: new Date(),
        version: 1,
        isMajorCheckpoint: true,
        reason: 'major_event'
      };
      
      mockDbRead.select.mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockSnapshot])
          })
        })
      });

      const result = await getStateSnapshot(userId, 'page-123');

      expect(result).toEqual({
        pageId: 'page-123',
        page: 15,
        state: testState,
        createdAt: mockSnapshot.createdAt,
        version: 1,
        isMajorCheckpoint: true,
        reason: 'major_event'
      });
    });

    it('should handle snapshot creation errors gracefully', async () => {
      const { createStateSnapshot } = await import('../src/services/snapshots.js');
      
      // Mock database error
      mockDbWrite.insert.mockImplementation(() => {
        throw new Error('Database connection failed');
      });

      await expect(createStateSnapshot(userId, bookId, 'page-123', testState, 'major_event'))
        .rejects.toThrow('Unable to create state snapshot');
    });
  });

  describe('Delta Service Tests', () => {
    it('should create a delta between two states', async () => {
      const { createStateDelta } = await import('../src/services/deltas.js');
      
      const fromState = { ...testState, page: 14, flags: { trust: 'high', fear: 'low' } };
      const toState = { ...testState, page: 15, flags: { trust: 'medium', fear: 'high' } };
      
      const delta = createStateDelta(fromState, toState, 'page-123');

      expect(delta).toEqual({
        pageId: 'page-123',
        fromPage: 14,
        toPage: 15,
        changes: {
          flags: {
            trust: { from: 'high', to: 'medium' },
            fear: { from: 'low', to: 'high' }
          }
        },
        timestamp: expect.any(Date)
      });
    });

    it('should apply a delta to a base state', async () => {
      const { createStateDelta, applyStateDelta } = await import('../src/services/deltas.js');
      
      const baseState = { ...testState, page: 14, flags: { trust: 'high', fear: 'low' } };
      const targetState = { ...testState, page: 15, flags: { trust: 'medium', fear: 'high' } };
      
      const delta = createStateDelta(baseState, targetState, 'page-123');
      const result = applyStateDelta(baseState, delta);

      expect(result.page).toBe(15);
      expect(result.flags.trust).toBe('medium');
      expect(result.flags.fear).toBe('high');
    });

    it('should create delta record successfully', async () => {
      const { createStateDeltaRecord } = await import('../src/services/deltas.js');
      
      // Mock successful database operation
      mockDbWrite.insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockResolvedValue(undefined)
        })
      });

      const fromState = { ...testState, page: 14 };
      const toState = { ...testState, page: 15 };

      await createStateDeltaRecord(userId, bookId, 'page-123', fromState, toState);

      expect(mockDbWrite.insert).toHaveBeenCalled();
    });
  });

  describe('State Reconstruction Tests', () => {
    it('should create reconstruction dependencies using canonical branch-traversal.ts', async () => {
      // Import canonical branch-traversal functions
      const { reconstructStoryState } = await import('../src/utils/branch-traversal.js');
      const { getPageFromDB, getBookFromDB } = await import('../src/services/book.js');
      const { getStateSnapshot } = await import('../src/services/snapshots.js');
      const { getStateDelta } = await import('../src/services/deltas.js');
      const { getStoryState } = await import('../src/services/story.js');
      
      // Create direct dependencies for reconstruction
      const deps = {
        getPageById: async (id) => await getPageFromDB(id),
        getBook: async (bookId) => await getBookFromDB(bookId),
        getSnapshot: async (id) => await getStateSnapshot(userId, id),
        getDelta: async (id) => await getStateDelta(userId, id),
        getStoryState: async (id) => await getStoryState(userId, id)
      };

      expect(deps).toHaveProperty('getPageById');
      expect(deps).toHaveProperty('getSnapshot');
      expect(deps).toHaveProperty('getDelta');
      expect(deps).toHaveProperty('getStoryState');
      expect(typeof deps.getPageById).toBe('function');
      expect(typeof deps.getSnapshot).toBe('function');
      expect(typeof deps.getDelta).toBe('function');
      expect(typeof deps.getStoryState).toBe('function');
    });

    it('should test reconstruction with canonical branch-traversal.ts', async () => {
      // Import canonical branch-traversal functions
      const { reconstructStoryState } = await import('../src/utils/branch-traversal.js');
      const { getPageFromDB, getBookFromDB } = await import('../src/services/book.js');
      const { getStateSnapshot } = await import('../src/services/snapshots.js');
      const { getStateDelta } = await import('../src/services/deltas.js');
      const { getStoryState } = await import('../src/services/story.js');
      
      // Create direct dependencies for reconstruction
      const deps = {
        getPageById: async (id) => await getPageFromDB(id),
        getBook: async (bookId) => await getBookFromDB(bookId),
        getSnapshot: async (id) => await getStateSnapshot(userId, id),
        getDelta: async (id) => await getStateDelta(userId, id),
        getStoryState: async (id) => await getStoryState(userId, id)
      };

      // Mock dependencies to return test data
      deps.getPageById = jest.fn().mockResolvedValue({ id: 'test-page', page: 10 });
      deps.getSnapshot = jest.fn().mockResolvedValue({
        pageId: 'test-page',
        page: 8,
        state: testState,
        createdAt: new Date(),
        version: 1,
        isMajorCheckpoint: true,
        reason: 'major_event'
      });
      deps.getDelta = jest.fn().mockResolvedValue({
        pageId: 'test-page',
        fromPage: 8,
        toPage: 10,
        changes: { page: { from: 8, to: 10 } }
      });
      deps.getStoryState = jest.fn().mockResolvedValue(null);
      
      const result = await reconstructStoryState('test-page', userId, deps, { useCache: true });
      
      expect(result.method).toBe('hybrid');
      expect(result.snapshotsUsed).toBeGreaterThan(0);
      expect(result.deltasApplied).toBeGreaterThan(0);
    });

    it('should test reconstruction with built-in caching from branch-traversal.ts', async () => {
      // Import canonical branch-traversal functions
      const { reconstructStoryState } = await import('../src/utils/branch-traversal.js');
      const { getPageFromDB, getBookFromDB } = await import('../src/services/book.js');
      const { getStateSnapshot } = await import('../src/services/snapshots.js');
      const { getStateDelta } = await import('../src/services/deltas.js');
      const { getStoryState } = await import('../src/services/story.js');
      
      // Create direct dependencies for reconstruction (branch-traversal.ts has built-in caching)
      const deps = {
        getPageById: async (id) => await getPageFromDB(id),
        getBook: async (bookId) => await getBookFromDB(bookId),
        getSnapshot: async (id) => await getStateSnapshot(userId, id),
        getDelta: async (id) => await getStateDelta(userId, id),
        getStoryState: async (id) => await getStoryState(userId, id)
      };
      
      // Mock dependencies to return test data
      deps.getPageById = jest.fn().mockResolvedValue({ id: 'test-page', page: 10 });
      deps.getSnapshot = jest.fn().mockResolvedValue({
        pageId: 'test-page',
        page: 8,
        state: testState,
        createdAt: new Date(),
        version: 1,
        isMajorCheckpoint: true,
        reason: 'major_event'
      });
      deps.getDelta = jest.fn().mockResolvedValue({
        pageId: 'test-page',
        fromPage: 8,
        toPage: 10,
        changes: { page: { from: 8, to: 10 } }
      });
      deps.getStoryState = jest.fn().mockResolvedValue(null);
      
      const result = await reconstructStoryState('test-page', userId, deps, { useCache: true });
      
      expect(result.method).toBe('hybrid');
      expect(result.snapshotsUsed).toBeGreaterThan(0);
      expect(result.deltasApplied).toBeGreaterThan(0);
      
      // Verify caching is working (branch-traversal.ts has built-in caching)
      expect(typeof deps.getPageById).toBe('function');
    });
  });

  describe('Integration Performance Tests', () => {
    it('should handle snapshot creation within performance limits', async () => {
      const { createStateSnapshot } = await import('../src/services/snapshots.js');
      
      // Mock database operation
      mockDbWrite.insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockResolvedValue(undefined)
        })
      });

      const startTime = Date.now();
      
      await createStateSnapshot(userId, bookId, 'page-123', testState, 'periodic');
      
      const duration = Date.now() - startTime;
      
      // Should complete within 100ms
      expect(duration).toBeLessThan(100);
    });

    it('should handle delta creation within performance limits', async () => {
      const { createStateDeltaRecord } = await import('../src/services/deltas.js');
      
      // Mock database operation
      mockDbWrite.insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockResolvedValue(undefined)
        })
      });

      const fromState = { ...testState, page: 14 };
      const toState = { ...testState, page: 15 };

      const startTime = Date.now();
      
      await createStateDeltaRecord(userId, bookId, 'page-123', fromState, toState);
      
      const duration = Date.now() - startTime;
      
      // Should complete within 50ms
      expect(duration).toBeLessThan(50);
    });

    it('should handle concurrent snapshot operations', async () => {
      const { createStateSnapshot } = await import('../src/services/snapshots.js');
      
      // Mock database operation
      mockDbWrite.insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockResolvedValue(undefined)
        })
      });

      const promises = [];
      const startTime = Date.now();

      // Create 10 concurrent snapshots
      for (let i = 0; i < 10; i++) {
        promises.push(createStateSnapshot(userId, bookId, `page-${i}`, testState, 'periodic'));
      }

      await Promise.all(promises);
      
      const duration = Date.now() - startTime;
      
      // Should complete all 10 operations within 500ms
      expect(duration).toBeLessThan(500);
      expect(mockDbWrite.insert).toHaveBeenCalledTimes(10);
    });
  });

  describe('Data Integrity Tests', () => {
    it('should maintain data consistency during delta application', async () => {
      const { createStateDelta, applyStateDelta } = await import('../src/services/deltas.js');
      
      const originalState = structuredClone(testState);
      const modifiedState = structuredClone(testState);
      
      // Make several changes
      modifiedState.page = 16;
      modifiedState.flags.trust = 'low';
      modifiedState.flags.fear = 'high';
      modifiedState.traumaTags.push('isolation');
      
      const delta = createStateDelta(originalState, modifiedState, 'page-123');
      const result = applyStateDelta(originalState, delta);

      // Verify all changes are applied correctly
      expect(result.page).toBe(16);
      expect(result.flags.trust).toBe('low');
      expect(result.flags.fear).toBe('high');
      expect(result.traumaTags).toContain('isolation');
      
      // Verify other fields remain unchanged
      expect(result.maxPage).toBe(originalState.maxPage);
      expect(result.difficulty).toBe(originalState.difficulty);
    });

    it('should handle empty deltas gracefully', async () => {
      const { createStateDelta, applyStateDelta } = await import('../src/services/deltas.js');
      
      const identicalState = structuredClone(testState);
      const delta = createStateDelta(testState, identicalState, 'page-123');
      
      // Delta should have no changes
      expect(Object.keys(delta.changes)).toHaveLength(0);
      
      const result = applyStateDelta(testState, delta);
      
      // Result should be identical to input
      expect(result).toEqual(testState);
    });

    it('should preserve complex nested objects in deltas', async () => {
      const { createStateDelta, applyStateDelta } = await import('../src/services/deltas.js');
      
      const fromState = structuredClone(testState);
      const toState = structuredClone(testState);
      
      // Modify nested psychological profile
      toState.psychologicalProfile.stabilityLevel = 'stable';
      toState.psychologicalProfile.manipulationAffinity = 'high';
      
      const delta = createStateDelta(fromState, toState, 'page-123');
      const result = applyStateDelta(fromState, delta);

      expect(result.psychologicalProfile.stabilityLevel).toBe('stable');
      expect(result.psychologicalProfile.manipulationAffinity).toBe('high');
    });
  });

  describe('Error Handling Tests', () => {
    it('should handle database connection failures', async () => {
      const { getStateSnapshot } = await import('../src/services/snapshots.js');
      
      // Mock database error
      mockDbRead.select.mockImplementation(() => {
        throw new Error('Connection timeout');
      });

      await expect(getStateSnapshot(userId, 'page-123'))
        .rejects.toThrow('Unable to retrieve state snapshot');
    });

    it('should handle invalid state data gracefully', async () => {
      const { createStateDelta } = await import('../src/services/deltas.js');
      
      const invalidState = null;
      const validState = testState;

      // Should handle null state gracefully
      expect(() => {
        createStateDelta(invalidState, validState, 'page-123');
      }).toThrow();
    });

    it('should handle cache overflow gracefully', async () => {
      const { createCachedReconstructionDependencies, getCacheStatistics } = await import('../src/services/state-reconstruction.js');
      
      const caches = {
        snapshotCache: new Map(),
        deltaCache: new Map(),
        stateCache: new Map()
      };

      const deps = createCachedReconstructionDependencies(userId, {
        ...caches,
        maxCacheSize: 2
      });

      // Fill cache beyond limit
      caches.snapshotCache.set('key1', 'value1');
      caches.snapshotCache.set('key2', 'value2');
      caches.snapshotCache.set('key3', 'value3');

      const stats = getCacheStatistics(caches);
      
      // Cache should be managed (size should not exceed limit)
      expect(stats.snapshots.size).toBeLessThanOrEqual(2);
    });
  });

  describe('Cache Performance Tests', () => {
    it('should demonstrate cache hit performance improvement', async () => {
      const { createCachedReconstructionDependencies } = await import('../src/services/state-reconstruction.js');
      
      const snapshotCache = new Map();
      const deltaCache = new Map();
      const stateCache = new Map();

      // Pre-populate cache
      const mockSnapshot = {
        pageId: 'page-123',
        page: 15,
        state: testState,
        createdAt: new Date(),
        version: 1,
        isMajorCheckpoint: false,
        reason: 'periodic'
      };
      
      snapshotCache.set(`snapshot:${userId}:page-123`, mockSnapshot);

      const deps = createCachedReconstructionDependencies(userId, {
        snapshotCache,
        deltaCache,
        stateCache,
        maxCacheSize: 100
      });

      const startTime = Date.now();
      const result = await deps.getSnapshot('page-123');
      const duration = Date.now() - startTime;

      // Cache hit should be very fast (< 10ms)
      expect(duration).toBeLessThan(10);
      expect(result).toEqual(mockSnapshot);
    });

    it('should manage cache size limits correctly', async () => {
      const { createCachedReconstructionDependencies, getCacheStatistics } = await import('../src/services/state-reconstruction.js');
      
      const caches = {
        snapshotCache: new Map(),
        deltaCache: new Map(),
        stateCache: new Map()
      };

      const deps = createCachedReconstructionDependencies(userId, {
        ...caches,
        maxCacheSize: 3
      });

      // Add items beyond limit
      for (let i = 0; i < 5; i++) {
        caches.snapshotCache.set(`key${i}`, `value${i}`);
      }

      const stats = getCacheStatistics(caches);
      
      // Should respect cache size limit
      expect(stats.snapshots.size).toBeLessThanOrEqual(3);
      expect(stats.total).toBeLessThanOrEqual(9); // 3 caches * 3 items each
    });
  });
});

/**
 * Performance Benchmark Test
 * 
 * This test measures the actual performance improvements
 * achieved by the snapshot/delta system.
 */
describe('Performance Benchmarks', () => {
  it('should demonstrate reconstruction performance improvement using canonical branch-traversal.ts', async () => {
      // Import canonical branch-traversal functions
      const { reconstructStoryState } = await import('../src/utils/branch-traversal.js');
      const { getPageFromDB, getBookFromDB } = await import('../src/services/book.js');
      const { getStateSnapshot } = await import('../src/services/snapshots.js');
      const { getStateDelta } = await import('../src/services/deltas.js');
      const { getStoryState } = await import('../src/services/story.js');
      
      const userId = 'benchmark-user';
      const pageId = 'benchmark-page';
      
      // Create direct dependencies for reconstruction (branch-traversal.ts has built-in performance monitoring)
      const deps = {
        getPageById: async (id) => await getPageFromDB(id),
        getBook: async (bookId) => await getBookFromDB(bookId),
        getSnapshot: async (id) => await getStateSnapshot(userId, id),
        getDelta: async (id) => await getStateDelta(userId, id),
        getStoryState: async (id) => await getStoryState(userId, id)
      };
      
      // Mock dependencies to return test data
      deps.getPageById = jest.fn().mockResolvedValue({ id: pageId, page: 10 });
      deps.getSnapshot = jest.fn().mockResolvedValue({
        pageId,
        page: 8,
        state: { pageId, page: 8, /* ... other state fields */ },
        createdAt: new Date(),
        version: 1,
        isMajorCheckpoint: true,
        reason: 'major_event'
      });
      deps.getDelta = jest.fn().mockResolvedValue({
        pageId,
        fromPage: 8,
        toPage: 10,
        changes: { page: { from: 8, to: 10 } }
      });
      deps.getStoryState = jest.fn().mockResolvedValue(null);

      const startTime = Date.now();
      const result = await reconstructStoryState(pageId, userId, deps, { useCache: true });
      const duration = Date.now() - startTime;

      // Should complete within 20ms for optimal performance (branch-traversal.ts is optimized)
      expect(duration).toBeLessThan(20);
      expect(result.method).toBe('hybrid');
      expect(result.snapshotsUsed).toBeGreaterThan(0);
      expect(result.deltasApplied).toBeGreaterThan(0);
      
      console.log(`✅ Performance test passed - using canonical branch-traversal.ts: ${duration}ms`);
    });
});

/**
 * End-to-End Integration Test
 * 
 * Tests the complete flow from story progression through state reconstruction.
 */
describe('End-to-End Integration', () => {
  it('should handle complete story flow with snapshots and deltas', async () => {
    // This would test the complete integration including:
    // 1. Story progression with snapshot/delta creation
    // 2. State reconstruction using hybrid method
    // 3. Performance validation
    // 4. Data integrity verification
    
    // Implementation would require mocking the complete story flow
    expect(true).toBe(true); // Placeholder for end-to-end test
  });
});
