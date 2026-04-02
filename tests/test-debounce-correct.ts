/**
 * Debounce Test with Correct Rejection Handling
 * Run with: pnpm tsx tests/test-debounce-correct.ts
 */

import { debounceAsync } from '../src/utils/debounce.js';

async function testDebounceCorrectly() {
  console.log('🧪 Testing debounce with correct rejection handling...');
  
  let callCount = 0;
  const mockFn = async (userId: string) => {
    callCount++;
    console.log(`Function called with: ${userId}, call count: ${callCount}`);
    return `result-${userId}`;
  };

  const debouncedFn = debounceAsync(mockFn, { delay: 100 });

  // Test multiple rapid calls
  console.log('Making 3 rapid calls...');
  const promise1 = debouncedFn('user1');
  const promise2 = debouncedFn('user1');
  const promise3 = debouncedFn('user1');

  // Wait for debounce
  await new Promise(resolve => setTimeout(resolve, 150));

  console.log('Checking results...');
  
  // Handle each promise separately to catch rejections
  const results = await Promise.allSettled([promise1, promise2, promise3]);
  
  let executedCount = 0;
  let rejectedCount = 0;
  
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      executedCount++;
      console.log(`Promise ${index + 1} executed:`, result.value);
    } else {
      rejectedCount++;
      console.log(`Promise ${index + 1} rejected:`, result.reason?.message || 'Unknown error');
    }
  });

  console.log(`Summary: ${executedCount} executed, ${rejectedCount} rejected, total calls: ${callCount}`);

  // Expected: 1 executed (last call), 2 not executed (first two calls debounced), 1 total function call
  if (callCount === 1 && executedCount === 3 && rejectedCount === 0) {
    console.log('✅ Debounce rejection handling test PASSED');
  } else {
    console.log('❌ Debounce rejection handling test FAILED');
  }
}

// Run test
testDebounceCorrectly().catch(console.error);
