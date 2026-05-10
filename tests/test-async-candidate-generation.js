/**
 * Test Script for Asynchronous Candidate Generation System
 * 
 * This script tests the new pg-boss based async candidate generation
 * to ensure it works correctly and doesn't hit Vercel timeouts.
 * 
 * Usage:
 * pnpm tsx tests/test-async-candidate-generation.js
 */

import { enqueueCandidateGeneration, getQueueStats, healthCheck } from '../src/lib/pgboss.js';
import { enqueueCandidateGenerationJob, validatePageForGeneration } from '../src/utils/prompt-async.js';
import { getPageFromDB } from '../src/services/book.js';

// Test configuration
const TEST_CONFIG = {
  userId: 'test-user-123',
  pageId: 'test-page-456', 
  bookId: 'test-book-789',
  priority: 10
};

/**
 * Mock page data for testing
 */
function createMockPage() {
  return {
    id: TEST_CONFIG.pageId,
    bookId: TEST_CONFIG.bookId,
    page: 1,
    text: 'Test page content for async generation...',
    actions: [
      {
        text: 'Action 1',
        type: 'dialogue',
        hint: { text: 'Hint 1', type: 'none' },
        destination: {} // No destination - needs generation
      },
      {
        text: 'Action 2', 
        type: 'movement',
        hint: { text: 'Hint 2', type: 'none' },
        destination: {} // No destination - needs generation
      },
      {
        text: 'Action 3',
        type: 'other',
        hint: { text: 'Hint 3', type: 'none' },
        destination: {} // No destination - needs generation
      }
    ],
    selectedActions: [],
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

/**
 * Mock book data for testing
 */
function createMockBook() {
  return {
    id: TEST_CONFIG.bookId,
    userId: TEST_CONFIG.userId,
    title: 'Test Book for Async Generation',
    totalPages: 10,
    currentPage: 1,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

/**
 * Test 1: pg-boss Health Check
 */
async function testHealthCheck() {
  console.log('\n🔍 Test 1: pg-boss Health Check');
  try {
    const isHealthy = await healthCheck();
    console.log(`✅ Health check result: ${isHealthy}`);
    
    if (!isHealthy) {
      throw new Error('pg-boss system is not healthy');
    }
    
    return true;
  } catch (error) {
    console.error('❌ Health check failed:', error.message);
    return false;
  }
}

/**
 * Test 2: Queue Statistics
 */
async function testQueueStats() {
  console.log('\n📊 Test 2: Queue Statistics');
  try {
    const stats = await getQueueStats();
    console.log('✅ Queue stats:', stats);
    return true;
  } catch (error) {
    console.error('❌ Queue stats failed:', error.message);
    return false;
  }
}

/**
 * Test 3: Page Validation
 */
async function testPageValidation() {
  console.log('\n🧪 Test 3: Page Validation');
  try {
    const mockPage = createMockPage();
    const mockBook = createMockBook();
    
    // Test valid page
    const validation = validatePageForGeneration(mockPage, mockBook);
    console.log('✅ Page validation:', validation);
    
    if (!validation.canGenerate) {
      throw new Error('Expected page to need generation');
    }
    
    // Test page with no pending actions
    const pageWithCompletedActions = {
      ...mockPage,
      actions: mockPage.actions.map(action => ({
        ...action,
        destination: { pageId: 'completed', branchId: 'completed' }
      }))
    };
    
    const validation2 = validatePageForGeneration(pageWithCompletedActions, mockBook);
    console.log('✅ Completed actions validation:', validation2);
    
    if (validation2.canGenerate) {
      throw new Error('Expected page with completed actions to not need generation');
    }
    
    return true;
  } catch (error) {
    console.error('❌ Page validation failed:', error.message);
    return false;
  }
}

/**
 * Test 4: Job Enqueue
 */
async function testJobEnqueue() {
  console.log('\n📤 Test 4: Job Enqueue');
  try {
    const mockPage = createMockPage();
    const mockBook = createMockBook();
    
    // Test enqueueCandidateGenerationJob
    const jobId1 = await enqueueCandidateGenerationJob(
      TEST_CONFIG.userId, 
      mockPage, 
      mockBook
    );
    
    console.log(`✅ Enqueued job via enqueueCandidateGenerationJob: ${jobId1}`);
    
    // Test direct pg-boss enqueue
    const jobId2 = await enqueueCandidateGeneration({
      userId: TEST_CONFIG.userId,
      pageId: TEST_CONFIG.pageId,
      bookId: TEST_CONFIG.bookId,
      priority: TEST_CONFIG.priority
    });
    
    console.log(`✅ Enqueued job via pg-boss directly: ${jobId2}`);
    
    return true;
  } catch (error) {
    console.error('❌ Job enqueue failed:', error.message);
    return false;
  }
}

/**
 * Test 5: Batch Job Enqueue
 */
async function testBatchJobEnqueue() {
  console.log('\n📦 Test 5: Batch Job Enqueue');
  try {
    const pageIds = [TEST_CONFIG.pageId, 'test-page-2', 'test-page-3'];
    
    const batchJobId = await enqueueBatchCandidateGenerationJob(
      TEST_CONFIG.userId,
      pageIds,
      TEST_CONFIG.bookId,
      { priority: 5 }
    );
    
    console.log(`✅ Enqueued batch job: ${batchJobId}`);
    return true;
  } catch (error) {
    console.error('❌ Batch job enqueue failed:', error.message);
    return false;
  }
}

/**
 * Test 6: Error Handling
 */
async function testErrorHandling() {
  console.log('\n⚠️ Test 6: Error Handling');
  try {
    // Test invalid page (no book)
    const mockPage = createMockPage();
    const validation1 = validatePageForGeneration(mockPage, null);
    console.log('✅ No book validation:', validation1);
    
    if (validation1.canGenerate) {
      throw new Error('Expected page without book to fail validation');
    }
    
    // Test last page
    const lastPage = { ...mockPage, page: 10 }; // Same as totalPages
    const mockBook = createMockBook();
    const validation2 = validatePageForGeneration(lastPage, mockBook);
    console.log('✅ Last page validation:', validation2);
    
    if (validation2.canGenerate) {
      throw new Error('Expected last page to not need generation');
    }
    
    return true;
  } catch (error) {
    console.error('❌ Error handling test failed:', error.message);
    return false;
  }
}

/**
 * Test 7: Performance Check
 */
async function testPerformance() {
  console.log('\n⚡ Test 7: Performance Check');
  try {
    const startTime = Date.now();
    
    // Enqueue multiple jobs
    const jobPromises = [];
    for (let i = 0; i < 5; i++) {
      const mockPage = createMockPage();
      mockPage.id = `test-page-perf-${i}`;
      
      jobPromises.push(
        enqueueCandidateGenerationJob(
          TEST_CONFIG.userId,
          mockPage,
          createMockBook()
        )
      );
    }
    
    const jobIds = await Promise.all(jobPromises);
    const duration = Date.now() - startTime;
    
    console.log(`✅ Enqueued ${jobIds.length} jobs in ${duration}ms`);
    console.log(`Average: ${Math.round(duration / jobIds.length)}ms per job`);
    
    // Performance should be under 100ms per job
    if (duration / jobIds.length > 100) {
      console.warn('⚠️ Job enqueue took longer than expected');
    }
    
    return true;
  } catch (error) {
    console.error('❌ Performance test failed:', error.message);
    return false;
  }
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log('🚀 Starting Async Candidate Generation Tests');
  console.log('=' .repeat(50));
  
  const tests = [
    { name: 'Health Check', fn: testHealthCheck },
    { name: 'Queue Stats', fn: testQueueStats },
    { name: 'Page Validation', fn: testPageValidation },
    { name: 'Job Enqueue', fn: testJobEnqueue },
    { name: 'Batch Job Enqueue', fn: testBatchJobEnqueue },
    { name: 'Error Handling', fn: testErrorHandling },
    { name: 'Performance Check', fn: testPerformance }
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const test of tests) {
    try {
      const result = await test.fn();
      if (result) {
        passed++;
      } else {
        failed++;
      }
    } catch (error) {
      console.error(`❌ Test "${test.name}" threw error:`, error);
      failed++;
    }
  }
  
  console.log('\n' + '='.repeat(50));
  console.log('📊 Test Results:');
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Success Rate: ${Math.round((passed / (passed + failed)) * 100)}%`);
  
  if (failed > 0) {
    console.log('\n⚠️ Some tests failed. Please check the implementation.');
    process.exit(1);
  } else {
    console.log('\n🎉 All tests passed! The async system is working correctly.');
  }
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests().catch(error => {
    console.error('💥 Test suite failed:', error);
    process.exit(1);
  });
}

export {
  testHealthCheck,
  testQueueStats,
  testPageValidation,
  testJobEnqueue,
  testBatchJobEnqueue,
  testErrorHandling,
  testPerformance,
  runAllTests
};
