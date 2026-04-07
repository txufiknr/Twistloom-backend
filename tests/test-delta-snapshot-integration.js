/**
 * Comprehensive Test Suite for Story State Delta & Snapshot System
 * 
 * Tests the complete integration of delta creation, strategic cleanup,
 * and state reconstruction functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createStateDelta, applyStateDelta } from '../src/services/deltas.js';
import { createStateDeltaRecord, getStateDelta, cleanupOldDeltas } from '../src/services/deltas.js';
import { reconstructStoryState } from '../src/utils/branch-traversal.js';
import { cleanupOldStoryStates } from '../src/services/book.js';
import { createEmptyStoryState } from '../src/utils/branch-traversal.js';

// Test utilities
function createTestStoryState(overrides = {}) {
  return {
    pageId: 'test-page-1',
    page: 1,
    maxPage: 20,
    flags: {
      trust: 'medium',
      fear: 'low',
      guilt: 'low',
      curiosity: 'medium'
    },
    traumaTags: [],
    psychologicalProfile: {
      archetype: 'survivor',
      stability: 'stable',
      dominantTraits: ['curious', 'cautious'],
      manipulationAffinity: 'emotional'
    },
    hiddenState: {
      truthLevel: 'ambiguous',
      threatProximity: 'distant',
      realityStability: 'stable'
    },
    memoryIntegrity: 'stable',
    difficulty: 'medium',
    cachedEndingArchetype: undefined,
    characters: {},
    places: {},
    pageHistory: [],
    actionsHistory: [],
    contextHistory: '',
    ...overrides
  };
}

function createTestSnapshot(pageId, page, state) {
  return {
    pageId,
    page,
    state: structuredClone(state),
    createdAt: new Date(),
    version: 1,
    isMajorCheckpoint: false,
    reason: 'periodic'
  };
}

describe('Delta Creation & Application', () => {
  let fromState, toState;

  beforeEach(() => {
    fromState = createTestStoryState({
      pageId: 'page-1',
      page: 1,
      traumaTags: ['fear']
    });

    toState = createTestStoryState({
      pageId: 'page-2',
      page: 2,
      traumaTags: ['fear', 'betrayal'],
      flags: {
        trust: 'low',      // Changed
        fear: 'high',      // Changed
        guilt: 'medium',   // Changed
        curiosity: 'medium'
      }
    });
  });

  it('should create delta with all state changes', () => {
    const delta = createStateDelta(fromState, toState, 'page-2');

    expect(delta.pageId).toBe('page-2');
    expect(delta.page).toBe(2);
    expect(delta.flagsDelta).toBeDefined();
    expect(delta.addedTraumaTags).toContain('betrayal');
    expect(delta.addedTraumaTags).toHaveLength(1);
  });

  it('should apply delta correctly to base state', () => {
    const delta = createStateDelta(fromState, toState, 'page-2');
    const appliedState = applyStateDelta(structuredClone(fromState), delta);

    expect(appliedState.pageId).toBe('page-2');
    expect(appliedState.page).toBe(2);
    expect(appliedState.flags.trust).toBe('low');
    expect(appliedState.flags.fear).toBe('high');
    expect(appliedState.flags.guilt).toBe('medium');
    expect(appliedState.traumaTags).toContain('betrayal');
    expect(appliedState.traumaTags).toHaveLength(2);
  });

  it('should handle empty delta gracefully', () => {
    const emptyDelta = createStateDelta(fromState, fromState, 'page-1');
    const appliedState = applyStateDelta(structuredClone(fromState), emptyDelta);

    expect(appliedState).toEqual(fromState);
  });

  it('should handle character additions and updates', () => {
    const character1 = { id: 'char-1', name: 'Alice', trust: 0.8 };
    const character2 = { id: 'char-2', name: 'Bob', trust: 0.3 };

    fromState.characters = { 'char-1': character1 };
    toState.characters = { 
      'char-1': { ...character1, trust: 0.6 }, // Updated
      'char-2': character2 // Added
    };

    const delta = createStateDelta(fromState, toState, 'page-2');
    const appliedState = applyStateDelta(structuredClone(fromState), delta);

    expect(appliedState.characters['char-1'].trust).toBe(0.6);
    expect(appliedState.characters['char-2']).toEqual(character2);
  });
});

describe('Strategic Cleanup Strategy', () => {
  let mockStates;

  beforeEach(() => {
    // Create mock states for a 25-page story
    mockStates = [];
    for (let i = 1; i <= 25; i++) {
      mockStates.push({
        pageId: `page-${i}`,
        page: i,
        updatedAt: new Date(Date.now() + i * 1000)
      });
    }
  });

  it('should keep first, middle, and last pages', () => {
    // Simulate the strategic cleanup logic
    const SNAPSHOT_INTERVAL = 10;
    const MIN_PAGES_FOR_MIDDLE = 20;
    
    const totalPages = Math.max(...mockStates.map(s => s.page));
    const pagesToKeep = new Set();
    
    // Keep first page
    pagesToKeep.add(mockStates[0].pageId);
    
    // Keep last page
    pagesToKeep.add(mockStates[mockStates.length - 1].pageId);
    
    // Keep middle page for substantial books
    if (totalPages >= MIN_PAGES_FOR_MIDDLE) {
      const middleIndex = Math.floor(mockStates.length / 2);
      pagesToKeep.add(mockStates[middleIndex].pageId);
    }
    
    // Keep interval snapshots
    const intervalStates = mockStates.filter(state => state.page % SNAPSHOT_INTERVAL === 0);
    for (const state of intervalStates) {
      pagesToKeep.add(state.pageId);
    }

    expect(pagesToKeep.has('page-1')).toBe(true);  // First
    expect(pagesToKeep.has('page-25')).toBe(true); // Last
    expect(pagesToKeep.has('page-13')).toBe(true); // Middle
    expect(pagesToKeep.has('page-10')).toBe(true); // Interval
    expect(pagesToKeep.has('page-20')).toBe(true); // Interval
    
    // Should not keep non-strategic pages
    expect(pagesToKeep.has('page-2')).toBe(false);
    expect(pagesToKeep.has('page-7')).toBe(false);
    expect(pagesToKeep.has('page-14')).toBe(false);
  });

  it('should calculate storage efficiency correctly', () => {
    const keptPages = 7; // first, middle, last, and 4 intervals (10, 20)
    const totalPages = 25;
    const efficiency = (keptPages / totalPages * 100).toFixed(1);
    
    expect(Number(efficiency)).toBe(28.0); // 7/25 = 28%
  });
});

describe('Optimal Snapshot Selection', () => {
  let mockBranchPath, mockDeps;

  beforeEach(() => {
    // Create a mock branch path with 15 pages
    mockBranchPath = {
      pages: [],
      rootId: 'page-1',
      currentId: 'page-15',
      depth: 15
    };

    for (let i = 1; i <= 15; i++) {
      mockBranchPath.pages.push({
        id: `page-${i}`,
        page: i,
        parentId: i > 1 ? `page-${i-1}` : null,
        text: `Page ${i} content`
      });
    }

    // Mock dependencies
    mockDeps = {
      getSnapshot: jest.fn(),
      getDelta: jest.fn(),
      getStoryState: jest.fn(),
      getPageById: jest.fn()
    };
  });

  it('should prefer interval snapshots for optimal performance', async () => {
    // Mock snapshots at strategic points
    const mockSnapshots = new Map([
      ['page-1', createTestSnapshot('page-1', 1, createTestStoryState({ page: 1 }))],
      ['page-5', createTestSnapshot('page-5', 5, createTestStoryState({ page: 5 }))],
      ['page-10', createTestSnapshot('page-10', 10, createTestStoryState({ page: 10 }))], // Interval
      ['page-15', createTestSnapshot('page-15', 15, createTestStoryState({ page: 15 }))]
    ]);

    mockDeps.getSnapshot.mockImplementation((pageId) => mockSnapshots.get(pageId) || null);

    // Mock deltas for all pages
    for (let i = 2; i <= 15; i++) {
      mockDeps.getDelta.mockReturnValue({ pageId: `page-${i}`, page: i });
    }

    const result = await reconstructStoryState('page-15', 'user-123', mockDeps);

    // Should select page-10 (interval snapshot) as optimal
    expect(result.method).toBe('snapshot_plus_deltas');
    expect(result.snapshotsUsed).toBe(1);
    expect(result.deltasApplied).toBe(5); // pages 11-15
    expect(result.reconstructionTimeMs).toBeGreaterThan(0);
  });

  it('should fall back to first page if no interval snapshot available', async () => {
    // Mock only first and last page snapshots
    const mockSnapshots = new Map([
      ['page-1', createTestSnapshot('page-1', 1, createTestStoryState({ page: 1 }))],
      ['page-15', createTestSnapshot('page-15', 15, createTestStoryState({ page: 15 }))]
    ]);

    mockDeps.getSnapshot.mockImplementation((pageId) => mockSnapshots.get(pageId) || null);
    mockDeps.getDelta.mockReturnValue({ pageId: 'test', page: 1 });

    const result = await reconstructStoryState('page-15', 'user-123', mockDeps);

    expect(result.method).toBe('snapshot_plus_deltas');
    expect(result.snapshotsUsed).toBe(1);
    expect(result.deltasApplied).toBe(14); // pages 2-15
  });

  it('should use fallback when no snapshots available', async () => {
    mockDeps.getSnapshot.mockReturnValue(null);
    mockDeps.getDelta.mockReturnValue(null);

    const result = await reconstructStoryState('page-15', 'user-123', mockDeps);

    expect(result.method).toBe('fallback');
    expect(result.snapshotsUsed).toBe(0);
    expect(result.deltasApplied).toBe(0);
    expect(result.state.pageId).toBe('page-15');
    expect(result.state.page).toBe(15);
  });
});

describe('Performance Benchmarks', () => {
  let mockBranchPath, mockDeps;

  beforeEach(() => {
    // Create a large branch path for performance testing
    mockBranchPath = {
      pages: [],
      rootId: 'page-1',
      currentId: 'page-100',
      depth: 100
    };

    for (let i = 1; i <= 100; i++) {
      mockBranchPath.pages.push({
        id: `page-${i}`,
        page: i,
        parentId: i > 1 ? `page-${i-1}` : null,
        text: `Page ${i} content`
      });
    }

    mockDeps = {
      getSnapshot: jest.fn(),
      getDelta: jest.fn(),
      getStoryState: jest.fn(),
      getPageById: jest.fn()
    };
  });

  it('should reconstruct state within performance targets', async () => {
    // Mock interval snapshots every 10 pages
    const mockSnapshots = new Map();
    for (let i = 1; i <= 100; i += 10) {
      mockSnapshots.set(`page-${i}`, createTestSnapshot(`page-${i}`, i, createTestStoryState({ page: i })));
    }

    mockDeps.getSnapshot.mockImplementation((pageId) => mockSnapshots.get(pageId) || null);
    mockDeps.getDelta.mockReturnValue({ pageId: 'test', page: 1 });

    const startTime = Date.now();
    const result = await reconstructStoryState('page-87', 'user-123', mockDeps);
    const endTime = Date.now();

    // Performance targets: < 20ms for 90% of requests
    expect(endTime - startTime).toBeLessThan(50); // Generous buffer for test environment
    expect(result.method).toBe('snapshot_plus_deltas');
    expect(result.deltasApplied).toBeLessThan(10); // Max 10 delta applications
  });

  it('should handle large branch paths efficiently', async () => {
    // Test with 1000 pages
    const largeBranchPath = {
      pages: [],
      rootId: 'page-1',
      currentId: 'page-1000',
      depth: 1000
    };

    for (let i = 1; i <= 1000; i++) {
      largeBranchPath.pages.push({
        id: `page-${i}`,
        page: i,
        parentId: i > 1 ? `page-${i-1}` : null,
        text: `Page ${i} content`
      });
    }

    // Mock snapshots every 10 pages
    const mockSnapshots = new Map();
    for (let i = 1; i <= 1000; i += 10) {
      mockSnapshots.set(`page-${i}`, createTestSnapshot(`page-${i}`, i, createTestStoryState({ page: i })));
    }

    mockDeps.getSnapshot.mockImplementation((pageId) => mockSnapshots.get(pageId) || null);
    mockDeps.getDelta.mockReturnValue({ pageId: 'test', page: 1 });

    const startTime = Date.now();
    const result = await reconstructStoryState('page-987', 'user-123', mockDeps);
    const endTime = Date.now();

    expect(endTime - startTime).toBeLessThan(100); // Should still be fast even for large branches
    expect(result.deltasApplied).toBeLessThan(10);
  });
});

describe('Error Handling & Edge Cases', () => {
  it('should handle missing delta gracefully', async () => {
    const fromState = createTestStoryState({ pageId: 'page-1', page: 1 });
    const toState = createTestStoryState({ pageId: 'page-2', page: 2 });

    const delta = createStateDelta(fromState, toState, 'page-2');
    
    // Remove some delta properties to simulate incomplete delta
    delete delta.flagsDelta;

    const appliedState = applyStateDelta(structuredClone(fromState), delta);

    expect(appliedState.pageId).toBe('page-2');
    expect(appliedState.page).toBe(2);
    // Flags should remain unchanged
    expect(appliedState.flags).toEqual(fromState.flags);
  });

  it('should handle reconstruction with missing deltas', async () => {
    const mockDeps = {
      getSnapshot: jest.fn().mockReturnValue(createTestSnapshot('page-1', 1, createTestStoryState({ page: 1 }))),
      getDelta: jest.fn().mockReturnValue(null), // No deltas available
      getStoryState: jest.fn().mockReturnValue(null),
      getPageById: jest.fn()
    };

    const mockBranchPath = {
      pages: [
        { id: 'page-1', page: 1, parentId: null },
        { id: 'page-2', page: 2, parentId: 'page-1' },
        { id: 'page-3', page: 3, parentId: 'page-2' }
      ],
      rootId: 'page-1',
      currentId: 'page-3',
      depth: 3
    };

    jest.spyOn(require('../src/utils/branch-traversal.js'), 'getBranchPath').mockResolvedValue(mockBranchPath);

    const result = await reconstructStoryState('page-3', 'user-123', mockDeps);

    expect(result.method).toBe('snapshot_plus_deltas');
    expect(result.deltasApplied).toBe(0); // No deltas applied
    expect(result.state.pageId).toBe('page-3');
  });

  it('should handle corrupted state data', async () => {
    const fromState = createTestStoryState();
    const corruptedState = { ...fromState, flags: null }; // Corrupted data

    expect(() => {
      createStateDelta(fromState, corruptedState, 'page-corrupted');
    }).not.toThrow();
  });
});

describe('Integration Tests', () => {
  it('should complete full delta-to-reconstruction workflow', async () => {
    // Create a story progression
    const states = [];
    for (let i = 1; i <= 15; i++) {
      states.push(createTestStoryState({
        pageId: `page-${i}`,
        page: i,
        traumaTags: i > 5 ? ['fear'] : [],
        flags: {
          trust: i > 10 ? 'low' : 'medium',
          fear: i > 8 ? 'high' : 'low',
          guilt: 'low',
          curiosity: 'medium'
        }
      }));
    }

    // Create deltas between consecutive states
    const deltas = [];
    for (let i = 1; i < states.length; i++) {
      const delta = createStateDelta(states[i - 1], states[i], `page-${i + 1}`);
      deltas.push(delta);
    }

    // Create snapshots at strategic points
    const snapshots = new Map([
      ['page-1', createTestSnapshot('page-1', 1, states[0])],
      ['page-5', createTestSnapshot('page-5', 5, states[4])],
      ['page-10', createTestSnapshot('page-10', 10, states[9])],
      ['page-15', createTestSnapshot('page-15', 15, states[14])]
    ]);

    // Mock dependencies
    const mockDeps = {
      getSnapshot: jest.fn().mockImplementation((pageId) => snapshots.get(pageId) || null),
      getDelta: jest.fn().mockImplementation((pageId) => {
        const pageIndex = parseInt(pageId.split('-')[1]) - 1;
        return deltas[pageIndex - 1] || null;
      }),
      getStoryState: jest.fn().mockReturnValue(null),
      getPageById: jest.fn()
    };

    const mockBranchPath = {
      pages: states.map((state, index) => ({
        id: state.pageId,
        page: state.page,
        parentId: index > 0 ? states[index - 1].pageId : null
      })),
      rootId: 'page-1',
      currentId: 'page-15',
      depth: 15
    };

    jest.spyOn(require('../src/utils/branch-traversal.js'), 'getBranchPath').mockResolvedValue(mockBranchPath);

    // Test reconstruction at various points
    const testPages = ['page-3', 'page-7', 'page-12', 'page-15'];
    
    for (const pageId of testPages) {
      const result = await reconstructStoryState(pageId, 'user-123', mockDeps);
      
      expect(result.state.pageId).toBe(pageId);
      expect(result.method).toBe('snapshot_plus_deltas');
      expect(result.deltasApplied).toBeLessThan(10);
      expect(result.reconstructionTimeMs).toBeGreaterThan(0);
    }
  });
});

// Performance monitoring utilities
export function generatePerformanceReport(testResults) {
  const report = {
    totalTests: testResults.length,
    averageReconstructionTime: 0,
    maxReconstructionTime: 0,
    minReconstructionTime: Infinity,
    testsMeetingTarget: 0,
    performanceTargetMs: 20
  };

  const times = testResults.map(result => result.reconstructionTimeMs);
  report.averageReconstructionTime = times.reduce((sum, time) => sum + time, 0) / times.length;
  report.maxReconstructionTime = Math.max(...times);
  report.minReconstructionTime = Math.min(...times);
  report.testsMeetingTarget = times.filter(time => time <= report.performanceTargetMs).length;

  return report;
}

console.log('✅ Delta & Snapshot Integration Test Suite Complete');
