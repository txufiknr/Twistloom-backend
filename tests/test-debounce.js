/**
 * Test script for debounce utility
 * Run with: pnpm tsx test-debounce.js
 */

import { debounceAsync } from '../src/utils/debounce.js';

// Mock database update function
let updateCount = 0;
const mockUpdateUserLastActivity = async (userId) => {
  updateCount++;
  console.log(`[${new Date().toISOString()}] Updating activity for user: ${userId} (call #${updateCount})`);
  await new Promise(resolve => setTimeout(resolve, 100)); // Simulate DB delay
};

// Create debounced version
const debouncedUpdate = debounceAsync(mockUpdateUserLastActivity, { delay: 2000 });

async function testDebouncing() {
  console.log('=== Testing Debounce Functionality ===\n');
  
  const userId = 'test-user-123';
  
  console.log('1. Making rapid successive calls for same user:');
  console.log('Expected: Only last call should execute after 2 seconds\n');
  
  // Make multiple rapid calls (don't await to simulate rapid successive calls)
  const start = Date.now();
  
  debouncedUpdate(userId);
  console.log(`   Call 1 at ${Date.now() - start}ms`);
  
  debouncedUpdate(userId);
  console.log(`   Call 2 at ${Date.now() - start}ms (should be debounced)`);
  
  debouncedUpdate(userId);
  console.log(`   Call 3 at ${Date.now() - start}ms (should be debounced)`);
  
  await new Promise(resolve => setTimeout(resolve, 2500)); // Wait for debounce
  
  console.log(`\nResult: ${updateCount} database updates (should be 1)\n`);
  
  // Test different user
  console.log('2. Testing different user (should execute immediately):');
  const differentUser = 'test-user-456';
  
  await debouncedUpdate(differentUser);
  console.log(`   Different user call at ${Date.now() - start}ms`);
  
  await new Promise(resolve => setTimeout(resolve, 2500)); // Wait for debounce
  
  console.log(`\nResult: ${updateCount} database updates (should be 2)\n`);
  
  // Test per-key independence
  console.log('3. Testing per-key independence:');
  updateCount = 0; // Reset counter
  
  const user1 = 'user-1';
  const user2 = 'user-2';
  
  debouncedUpdate(user1);
  debouncedUpdate(user2);
  debouncedUpdate(user1); // This should be debounced
  debouncedUpdate(user2); // This should be debounced
  
  await new Promise(resolve => setTimeout(resolve, 2500));
  
  console.log(`\nResult: ${updateCount} database updates (should be 2 - one for each user)\n`);
  
  console.log('=== Test Complete ===');
}

// Run the test
testDebouncing().catch(console.error);
