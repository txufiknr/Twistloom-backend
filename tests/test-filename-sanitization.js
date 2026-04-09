/**
 * Test filename sanitization with comprehensive edge cases
 */

import { sanitizeFilename } from '../src/utils/formatter.js';

// Test cases
const testCases = [
  // Basic cases
  { input: 'simple', expected: 'simple' },
  { input: 'My File', expected: 'my_file' },
  { input: 'hello world', expected: 'hello_world' },
  
  // Special characters
  { input: 'file<name>', expected: 'filename' },
  { input: 'file"name"', expected: 'filename' },
  { input: 'file\\path', expected: 'filepath' },
  { input: 'file|pipe', expected: 'filepipe' },
  { input: 'file?query', expected: 'filequery' },
  { input: 'file*', expected: 'file' },
  
  // Spaces and underscores
  { input: 'my file name', expected: 'my_file_name' },
  { input: 'multiple   spaces', expected: 'multiple_spaces' },
  { input: 'file__name', expected: 'file_name' },
  { input: '_leading', expected: 'leading' },
  { input: 'trailing_', expected: 'trailing' },
  { input: '__both__', expected: 'both' },
  { input: '___triple___', expected: 'triple' },
  
  // Ampersands
  { input: 'file & name', expected: 'file_name' },
  { input: 'a & b & c', expected: 'a_b_c' },
  { input: 'file&test', expected: 'filetest' },
  
  // Numbers and mixed
  { input: 'file123', expected: 'file123' },
  { input: 'book123_The_Haunted_House.jpg', expected: 'book123_the_haunted_house.jpg' },
  { input: 'MyImage_1.png', expected: 'myimage_1.png' },
  
  // Edge cases
  { input: '', expected: '' },
  { input: '   ', expected: '' },
  { input: '___', expected: '' },
  { input: 'file   name', expected: 'file_name' },
  
  // Case preservation test (what user wants)
  { input: 'book123_The_Haunted_House.jpg', expected: 'book123_the_haunted_house.jpg' },
];

console.log('🧪 Running filename sanitization tests...\n');

let passed = 0;
let failed = 0;

for (const testCase of testCases) {
  const result = sanitizeFilename(testCase.input);
  const success = result === testCase.expected;
  
  if (success) {
    console.log(`✅ PASS: "${testCase.input}" → "${result}"`);
    passed++;
  } else {
    console.log(`❌ FAIL: "${testCase.input}" → "${result}" (expected: "${testCase.expected}")`);
    failed++;
  }
}

console.log(`\n📊 Results: ${passed}/${testCases.length} tests passed`);
console.log(`🔴 Issues: ${failed} tests failed`);

if (failed > 0) {
  console.log('\n⚠️  Sanitization function needs improvement!');
  process.exit(1);
} else {
  console.log('\n✅ Sanitization function working correctly!');
}
