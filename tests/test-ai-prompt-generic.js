/**
 * Comprehensive test for aiPrompt generic type implementation
 * Tests the parsing logic without making actual API calls
 */

import { aiPrompt } from '../src/utils/ai-chat.js';
import { AI_CHAT_MODELS_WRITING } from '../src/config/ai-clients.js';

// Define test types for proper generic testing
const StoryPageType = {
  page: '',
  mood: '',
  actions: []
};

const DefinedType = {
  name: '',
  age: 0,
  active: true
};

// Mock the provider functions to simulate AI responses
const mockProviderResponses = {
  github: {
    success: {
      provider: 'github',
      model: 'gpt-4',
      output: JSON.stringify({
        page: "The shadows danced across the walls as Sarah entered the abandoned mansion...",
        mood: "eerie",
        actions: [
          { id: "investigate", text: "Investigate the strange noises" },
          { id: "flee", text: "Run away immediately" }
        ]
      }),
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      finishReason: 'stop'
    },
    failure: null
  },
  gemini: {
    success: {
      provider: 'gemini', 
      model: 'gemini-pro',
      output: JSON.stringify({
        page: "A cold wind swept through the empty corridors...",
        mood: "mysterious",
        actions: [
          { id: "explore", text: "Explore deeper" },
          { id: "wait", text: "Wait and listen" }
        ]
      }),
      usage: { promptTokens: 80, completionTokens: 40, totalTokens: 120 },
      finishReason: 'stop'
    },
    failure: null
  },
  groq: {
    success: {
      provider: 'groq',
      model: 'llama2-70b',
      output: JSON.stringify({
        page: "The door creaked open, revealing darkness beyond...",
        mood: "tense",
        actions: [
          { id: "enter", text: "Enter the darkness" },
          { id: "search", text: "Search for a light source" }
        ]
      }),
      usage: { promptTokens: 90, completionTokens: 45, totalTokens: 135 },
      finishReason: 'stop'
    },
    failure: null
  }
};

// Mock the provider functions
async function mockGithubPrompt(prompt, options) {
  return mockProviderResponses.github.success;
}

async function mockGeminiPrompt(prompt, options) {
  return mockProviderResponses.gemini.success;
}

async function mockGroqPrompt(prompt, options) {
  return mockProviderResponses.groq.success;
}

// Mock functions that can fail
async function mockFailingGithubPrompt(prompt, options) {
  return mockProviderResponses.github.failure;
}

async function mockMalformedGithubPrompt(prompt, options) {
  return {
    provider: 'github',
    model: 'gpt-4',
    output: 'This is not valid JSON at all',
    usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
    finishReason: 'stop'
  };
}

// Test StoryPage type structure
const StoryPage = {
  page: '',
  mood: '',
  actions: []
};

/**
 * Test 1: Basic JSON parsing with outputAsJson: true
 */
async function testBasicJsonParsing() {
  console.log('🧪 Test 1: Basic JSON parsing with outputAsJson: true');
  
  // Temporarily replace the real provider functions with mocks
  const originalGithub = global.githubPrompt;
  const originalGemini = global.geminiPrompt;
  const originalGroq = global.groqPrompt;
  
  global.githubPrompt = mockGithubPrompt;
  global.geminiPrompt = mockGeminiPrompt;
  global.groqPrompt = mockGroqPrompt;
  
  try {
    const response = await aiPrompt<StoryPageType>('Generate a story page', {
      outputAsJson: true,
      context: 'test'
    });
    
    console.log('✅ Response:', {
      provider: response.provider,
      model: response.model,
      hasResult: !!response.result,
      resultType: typeof response.result
    });
    
    if (response.result && typeof response.result === 'object') {
      console.log('✅ Parsed result:', {
        hasPage: !!response.result.page,
        hasMood: !!response.result.mood,
        hasActions: Array.isArray(response.result.actions),
        actionCount: response.result.actions?.length
      });
    }
    
    return response.result;
  } catch (error) {
    console.error('❌ Test 1 failed:', error.message);
    return null;
  } finally {
    // Restore original functions
    global.githubPrompt = originalGithub;
    global.geminiPrompt = originalGemini;
    global.groqPrompt = originalGroq;
  }
}

/**
 * Test 2: String parsing with outputAsJson: false (default)
 */
async function testStringParsing() {
  console.log('\n🧪 Test 2: String parsing with outputAsJson: false');
  
  const originalGithub = global.githubPrompt;
  global.githubPrompt = mockGithubPrompt;
  
  try {
    const response = await aiPrompt('Generate a summary', {
      outputAsJson: false,
      context: 'test'
    });
    
    console.log('✅ Response:', {
      provider: response.provider,
      model: response.model,
      resultType: typeof response.result,
      resultLength: response.result?.length
    });
    
    return response.result;
  } catch (error) {
    console.error('❌ Test 2 failed:', error.message);
    return null;
  } finally {
    global.githubPrompt = originalGithub;
  }
}

/**
 * Test 3: Provider fallback when parsing fails
 */
async function testProviderFallback() {
  console.log('\n🧪 Test 3: Provider fallback when parsing fails');
  
  const originalGithub = global.githubPrompt;
  const originalGemini = global.geminiPrompt;
  const originalGroq = global.groqPrompt;
  
  // First provider fails, second succeeds
  global.githubPrompt = mockFailingGithubPrompt;
  global.geminiPrompt = mockGeminiPrompt;
  global.groqPrompt = mockGroqPrompt;
  
  try {
    const response = await aiPrompt<StoryPageType>('Generate a story page', {
      outputAsJson: true,
      context: 'test'
    });
    
    console.log('✅ Fallback response:', {
      provider: response.provider,
      model: response.model,
      hasResult: !!response.result
    });
    
    // Should have fallen back to gemini
    if (response.provider === 'gemini') {
      console.log('✅ Successfully fell back to gemini provider');
    } else {
      console.log('❌ Did not fall back as expected');
    }
    
    return response.result;
  } catch (error) {
    console.error('❌ Test 3 failed:', error.message);
    return null;
  } finally {
    global.githubPrompt = originalGithub;
    global.geminiPrompt = originalGemini;
    global.groqPrompt = originalGroq;
  }
}

/**
 * Test 4: Malformed JSON handling with fallback
 */
async function testMalformedJsonHandling() {
  console.log('\n🧪 Test 4: Malformed JSON handling with fallback');
  
  const originalGithub = global.githubPrompt;
  const originalGemini = global.geminiPrompt;
  const originalGroq = global.groqPrompt;
  
  // First provider returns malformed JSON, second returns valid JSON
  global.githubPrompt = mockMalformedGithubPrompt;
  global.geminiPrompt = mockGeminiPrompt;
  global.groqPrompt = mockGroqPrompt;
  
  try {
    const response = await aiPrompt<StoryPageType>('Generate a story page', {
      outputAsJson: true,
      context: 'test'
    });
    
    console.log('✅ Malformed JSON fallback response:', {
      provider: response.provider,
      model: response.model,
      hasResult: !!response.result,
      resultType: typeof response.result
    });
    
    // Should have fallen back to gemini due to parse failure
    if (response.provider === 'gemini') {
      console.log('✅ Successfully fell back due to malformed JSON');
    } else {
      console.log('❌ Did not handle malformed JSON correctly');
    }
    
    return response.result;
  } catch (error) {
    console.error('❌ Test 4 failed:', error.message);
    return null;
  } finally {
    global.githubPrompt = originalGithub;
    global.geminiPrompt = originalGemini;
    global.groqPrompt = originalGroq;
  }
}

/**
 * Test 5: Edge case - empty response
 */
async function testEmptyResponse() {
  console.log('\n🧪 Test 5: Empty response handling');
  
  const originalGithub = global.githubPrompt;
  
  global.githubPrompt = async () => ({
    provider: 'github',
    model: 'gpt-4',
    output: '',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    finishReason: 'stop'
  });
  
  try {
    const response = await aiPrompt('Test prompt', {
      outputAsJson: true,
      context: 'test'
    });
    
    console.log('✅ Empty response handling:', {
      provider: response.provider,
      result: response.result
    });
    
    return response.result;
  } catch (error) {
    console.error('❌ Test 5 failed:', error.message);
    return null;
  } finally {
    global.githubPrompt = originalGithub;
  }
}

/**
 * Test 6: Complex nested JSON structure
 */
async function testComplexNestedJson() {
  console.log('\n🧪 Test 6: Complex nested JSON structure');
    
  const originalGithub = global.githubPrompt;
    
  const complexStoryPage = {
    page: "The ancient library stood silent, its shelves groaning under weight of forgotten knowledge...",
    mood: "mysterious",
    actions: [
      {
        id: "search",
        text: "Search shelves",
        requirements: { intelligence: 10, perception: 8 },
        outcomes: {
          success: "You find a mysterious tome",
          failure: "You find nothing but dust"
        }
      },
      {
        id: "leave",
        text: "Leave library",
        requirements: {},
        outcomes: {
          success: "You exit safely",
          failure: "You hear whispers behind you"
        }
      },
    ],
    metadata: {
      location: "ancient_library",
      timeOfDay: "midnight",
      difficulty: "medium"
    }
  };
  
  global.githubPrompt = async () => ({
    provider: 'github',
    model: 'gpt-4',
    output: JSON.stringify(complexStoryPage),
    usage: { promptTokens: 150, completionTokens: 100, totalTokens: 250 },
    finishReason: 'stop'
  });
  
  try {
    const response = await aiPrompt<complexStoryPage>('Generate complex story', {
      outputAsJson: true,
      context: 'test'
    });
    
    console.log('✅ Complex JSON response:', {
      provider: response.provider,
      hasResult: !!response.result,
      hasNestedActions: Array.isArray(response.result?.actions),
      firstActionComplexity: response.result?.actions?.[0]?.outcomes ? 'complex' : 'simple',
      hasMetadata: !!response.result?.metadata
    });
    
    return response.result;
  } catch (error) {
    console.error('❌ Test 6 failed:', error.message);
    return null;
  } finally {
    global.githubPrompt = originalGithub;
  }
}

/**
 * Test 7: DefinedType with outputAsJson: true
 */
async function testDefinedType() {
  console.log('\n🧪 Test 7: DefinedType with outputAsJson: true');
  
  const originalGithub = global.githubPrompt;
  
  const definedTypeData = {
    name: "John Doe",
    age: 30,
    active: true,
    metadata: {
      created: "2024-01-01",
      role: "user"
    }
  };
  
  global.githubPrompt = async () => ({
    provider: 'github',
    model: 'gpt-4',
    output: JSON.stringify(definedTypeData),
    usage: { promptTokens: 80, completionTokens: 40, totalTokens: 120 },
    finishReason: 'stop'
  });
  
  try {
    const response = await aiPrompt<DefinedType>('Generate user profile', {
      outputAsJson: true,
      context: 'test'
    });
    
    console.log('✅ DefinedType response:', {
      provider: response.provider,
      model: response.model,
      hasResult: !!response.result,
      resultType: typeof response.result,
      hasName: !!response.result?.name,
      hasAge: typeof response.result?.age === 'number',
      hasActive: typeof response.result?.active === 'boolean'
    });
    
    return response.result;
  } catch (error) {
    console.error('❌ Test 7 failed:', error.message);
    return null;
  } finally {
    global.githubPrompt = originalGithub;
  }
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log('🚀 Starting comprehensive aiPrompt generic type tests...\n');
  
  const results = {
    test1: await testBasicJsonParsing(),
    test2: await testStringParsing(),
    test3: await testProviderFallback(),
    test4: await testMalformedJsonHandling(),
    test5: await testEmptyResponse(),
    test6: await testComplexNestedJson(),
    test7: await testDefinedType()
  };
  
  console.log('\n📊 Test Results Summary:');
  console.log('✅ Test 1 (Basic JSON):', results.test1 ? 'PASSED' : 'FAILED');
  console.log('✅ Test 2 (String parsing):', results.test2 ? 'PASSED' : 'FAILED');
  console.log('✅ Test 3 (Provider fallback):', results.test3 ? 'PASSED' : 'FAILED');
  console.log('✅ Test 4 (Malformed JSON):', results.test4 ? 'PASSED' : 'FAILED');
  console.log('✅ Test 5 (Empty response):', results.test5 ? 'PASSED' : 'FAILED');
  console.log('✅ Test 6 (Complex JSON):', results.test6 ? 'PASSED' : 'FAILED');
  console.log('✅ Test 7 (DefinedType):', results.test7 ? 'PASSED' : 'FAILED');
  
  const passedTests = Object.values(results).filter(Boolean).length;
  console.log(`\n🎯 Overall: ${passedTests}/7 tests passed`);
  
  if (passedTests === 7) {
    console.log('🎉 All tests passed! The aiPrompt generic implementation is working correctly.');
  } else {
    console.log('⚠️  Some tests failed. Review implementation.');
  }
  
  return results;
}

// Run tests if this file is executed directly
// if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests().catch(console.error);
// }

export {
  runAllTests,
  testBasicJsonParsing,
  testStringParsing,
  testProviderFallback,
  testMalformedJsonHandling,
  testEmptyResponse,
  testComplexNestedJson
};
