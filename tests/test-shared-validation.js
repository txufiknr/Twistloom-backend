/**
 * Test Script for Shared Candidate Generation Validation
 * 
 * This script tests the new shared validation logic to ensure it works
 * correctly across different contexts and eliminates code duplication.
 * 
 * Usage:
 * pnpm tsx tests/test-shared-validation.js
 */

import { validateCandidateGeneration, validatePageForJobEnqueue, getGenerationStrategy, calculateGenerationTimeout } from '../src/utils/candidate-generation-shared.js';

// Test data
const createMockPage = (page = 1, totalPages = 10, actions = []) => ({
  id: `test-page-${page}`,
  bookId: 'test-book-123',
  page,
  actions: actions.length > 0 ? actions : [
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
    }
  ],
  selectedActions: [],
  createdAt: new Date(),
  updatedAt: new Date()
});

const createMockBook = (totalPages = 10) => ({
  id: 'test-book-123',
  userId: 'test-user-456',
  title: 'Test Book',
  totalPages,
  currentPage: 1,
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date()
});

/**
 * Test 1: Full validation with valid page
 */
async function testFullValidationValid() {
  console.log('\n🧪 Test 1: Full validation with valid page');
  try {
    const page = createMockPage(1, 10);
    const book = createMockBook(10);
    
    const validation = await validateCandidateGeneration('test-user', page, book);
    
    console.log('✅ Validation result:', {
      canGenerate: validation.canGenerate,
      reason: validation.reason,
      pendingActions: validation.pendingActions.length,
      currentDepth: validation.currentDepth,
      maxDepth: validation.maxDepth
    });
    
    if (!validation.canGenerate) {
      throw new Error('Expected valid page to pass validation');
    }
    
    if (validation.pendingActions.length !== 2) {
      throw new Error(`Expected 2 pending actions, got ${validation.pendingActions.length}`);
    }
    
    return true;
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    return false;
  }
}

/**
 * Test 2: Full validation with last page
 */
async function testFullValidationLastPage() {
  console.log('\n🧪 Test 2: Full validation with last page');
  try {
    const page = createMockPage(10, 10); // Last page
    const book = createMockBook(10);
    
    const validation = await validateCandidateGeneration('test-user', page, book);
    
    console.log('✅ Validation result:', {
      canGenerate: validation.canGenerate,
      reason: validation.reason
    });
    
    if (validation.canGenerate) {
      throw new Error('Expected last page to fail validation');
    }
    
    if (!validation.reason?.includes('last page')) {
      throw new Error('Expected reason to mention last page');
    }
    
    return true;
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    return false;
  }
}

/**
 * Test 3: Full validation with no pending actions
 */
async function testFullValidationNoPending() {
  console.log('\n🧪 Test 3: Full validation with no pending actions');
  try {
    const page = createMockPage(1, 10, [
      {
        text: 'Action 1',
        type: 'dialogue',
        hint: { text: 'Hint 1', type: 'none' },
        destination: { pageId: 'generated-1', branchId: 'branch-1' } // Already generated
      }
    ]);
    const book = createMockBook(10);
    
    const validation = await validateCandidateGeneration('test-user', page, book);
    
    console.log('✅ Validation result:', {
      canGenerate: validation.canGenerate,
      reason: validation.reason
    });
    
    if (validation.canGenerate) {
      throw new Error('Expected page with no pending actions to fail validation');
    }
    
    if (!validation.reason?.includes('No actions need generation')) {
      throw new Error('Expected reason to mention no actions need generation');
    }
    
    return true;
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    return false;
  }
}

/**
 * Test 4: Job enqueue validation
 */
async function testJobEnqueueValidation() {
  console.log('\n🧪 Test 4: Job enqueue validation');
  try {
    const page = createMockPage(1, 10);
    const book = createMockBook(10);
    
    const validation = validatePageForJobEnqueue(page, book);
    
    console.log('✅ Job enqueue validation:', {
      canEnqueue: validation.canEnqueue,
      reason: validation.reason,
      pendingActions: validation.pendingActions.length
    });
    
    if (!validation.canEnqueue) {
      throw new Error('Expected valid page to pass job enqueue validation');
    }
    
    if (validation.pendingActions.length !== 2) {
      throw new Error(`Expected 2 pending actions, got ${validation.pendingActions.length}`);
    }
    
    return true;
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    return false;
  }
}

/**
 * Test 5: Generation strategies
 */
async function testGenerationStrategies() {
  console.log('\n🧪 Test 5: Generation strategies');
  try {
    const vercelStrategy = getGenerationStrategy('vercel');
    const githubStrategy = getGenerationStrategy('github-action');
    const cronStrategy = getGenerationStrategy('cron');
    
    console.log('✅ Vercel strategy:', {
      useParallel: vercelStrategy.useParallel,
      enforceVercelLimits: vercelStrategy.enforceVercelLimits,
      customTimeoutMs: vercelStrategy.customTimeoutMs
    });
    
    console.log('✅ GitHub Action strategy:', {
      useParallel: githubStrategy.useParallel,
      enforceVercelLimits: githubStrategy.enforceVercelLimits,
      customTimeoutMs: githubStrategy.customTimeoutMs
    });
    
    console.log('✅ Cron strategy:', {
      useParallel: cronStrategy.useParallel,
      enforceVercelLimits: cronStrategy.enforceVercelLimits,
      customTimeoutMs: cronStrategy.customTimeoutMs
    });
    
    // Verify strategy differences
    if (vercelStrategy.useParallel !== true) {
      throw new Error('Expected Vercel strategy to use parallel generation');
    }
    
    if (githubStrategy.useParallel !== false) {
      throw new Error('Expected GitHub Action strategy to use sequential generation');
    }
    
    if (vercelStrategy.enforceVercelLimits !== true) {
      throw new Error('Expected Vercel strategy to enforce timeout limits');
    }
    
    return true;
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    return false;
  }
}

/**
 * Test 6: Timeout calculation
 */
async function testTimeoutCalculation() {
  console.log('\n🧪 Test 6: Timeout calculation');
  try {
    const requestStartTime = Date.now();
    
    // Test Vercel timeout calculation
    const vercelStrategy = getGenerationStrategy('vercel');
    const vercelTimeout = calculateGenerationTimeout(vercelStrategy, requestStartTime);
    
    console.log('✅ Vercel timeout:', vercelTimeout, 'ms');
    
    if (vercelTimeout < 60000 || vercelTimeout > 300000) {
      throw new Error(`Expected Vercel timeout between 60s-300s, got ${vercelTimeout}ms`);
    }
    
    // Test GitHub Action timeout calculation
    const githubStrategy = getGenerationStrategy('github-action');
    const githubTimeout = calculateGenerationTimeout(githubStrategy);
    
    console.log('✅ GitHub Action timeout:', githubTimeout, 'ms');
    
    if (githubTimeout !== 600000) {
      throw new Error(`Expected GitHub Action timeout to be 10 minutes, got ${githubTimeout}ms`);
    }
    
    // Test custom timeout
    const customStrategy = { customTimeoutMs: 120000 };
    const customTimeout = calculateGenerationTimeout(customStrategy);
    
    console.log('✅ Custom timeout:', customTimeout, 'ms');
    
    if (customTimeout !== 120000) {
      throw new Error(`Expected custom timeout to be 120000ms, got ${customTimeout}ms`);
    }
    
    return true;
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    return false;
  }
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log('🚀 Starting Shared Validation Tests');
  console.log('=' .repeat(50));
  
  const tests = [
    { name: 'Full Validation (Valid)', fn: testFullValidationValid },
    { name: 'Full Validation (Last Page)', fn: testFullValidationLastPage },
    { name: 'Full Validation (No Pending)', fn: testFullValidationNoPending },
    { name: 'Job Enqueue Validation', fn: testJobEnqueueValidation },
    { name: 'Generation Strategies', fn: testGenerationStrategies },
    { name: 'Timeout Calculation', fn: testTimeoutCalculation }
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
    console.log('\n🎉 All tests passed! The shared validation system is working correctly.');
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
  testFullValidationValid,
  testFullValidationLastPage,
  testFullValidationNoPending,
  testJobEnqueueValidation,
  testGenerationStrategies,
  testTimeoutCalculation,
  runAllTests
};
