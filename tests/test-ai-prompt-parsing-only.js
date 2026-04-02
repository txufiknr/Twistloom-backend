/**
 * Standalone test for aiPrompt parsing logic only
 * Tests parseAISafely integration without calling actual providers
 */

import { parseAISafely } from '../src/utils/parser.js';

// Mock AI response structure
function createMockAIResponse(provider, model, output, usage = null, finishReason = 'stop') {
  return {
    provider,
    model,
    output,
    usage: usage || { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    finishReason
  };
}

// Test types
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

/**
 * Replicates the aiPrompt parsing logic for testing
 */
async function testParsingLogic() {
  console.log('🧪 Testing aiPrompt parsing logic (no actual API calls)\n');
  
  // Test 1: Valid JSON with outputAsJson: true
  console.log('📝 Test 1: Valid JSON with outputAsJson: true');
  const validJsonOutput = JSON.stringify({
    page: "The shadows danced across the walls as Sarah entered the abandoned mansion...",
    mood: "eerie",
    actions: [
      { id: "investigate", text: "Investigate strange noises" },
      { id: "flee", text: "Run away immediately" }
    ]
  });
  
  const mockResponse1 = createMockAIResponse('github', 'gpt-4', validJsonOutput);
  
  try {
    let parsedResult;
    const outputAsJson = true;
    
    if (outputAsJson) {
      const compatibleResponse = {
        ...mockResponse1,
        result: { output: mockResponse1.output }
      };
      parsedResult = parseAISafely(compatibleResponse, {
        logContext: 'test-parsing'
      });
    } else {
      parsedResult = mockResponse1.output;
    }
    
    console.log('✅ Test 1 Result:', {
      hasResult: !!parsedResult,
      resultType: typeof parsedResult,
      hasPage: !!parsedResult?.page,
      hasMood: !!parsedResult?.mood,
      hasActions: Array.isArray(parsedResult?.actions),
      actionCount: parsedResult?.actions?.length
    });
  } catch (error) {
    console.error('❌ Test 1 failed:', error.message);
  }
  
  // Test 2: Invalid JSON with outputAsJson: true (should fallback to plain text)
  console.log('\n📝 Test 2: Invalid JSON with outputAsJson: true');
  const invalidJsonOutput = 'This is not valid JSON at all { broken syntax';
  const mockResponse2 = createMockAIResponse('gemini', 'gemini-pro', invalidJsonOutput);
  
  try {
    let parsedResult;
    const outputAsJson = true;
    
    if (outputAsJson) {
      const compatibleResponse = {
        ...mockResponse2,
        result: { output: mockResponse2.output }
      };
      parsedResult = parseAISafely(compatibleResponse, {
        logContext: 'test-parsing'
      });
    } else {
      parsedResult = mockResponse2.output;
    }
    
    console.log('✅ Test 2 Result:', {
      hasResult: !!parsedResult,
      resultType: typeof parsedResult,
      fallbackUsed: parsedResult?.output === invalidJsonOutput
    });
  } catch (error) {
    console.error('❌ Test 2 failed:', error.message);
  }
  
  // Test 3: Valid JSON with outputAsJson: false (should treat as string)
  console.log('\n📝 Test 3: Valid JSON with outputAsJson: false');
  const validJsonOutput3 = JSON.stringify({
    name: "John Doe",
    age: 30,
    active: true
  });
  const mockResponse3 = createMockAIResponse('groq', 'llama2-70b', validJsonOutput3);
  
  try {
    let parsedResult;
    const outputAsJson = false;
    
    if (outputAsJson) {
      const compatibleResponse = {
        ...mockResponse3,
        result: { output: mockResponse3.output }
      };
      parsedResult = parseAISafely(compatibleResponse, {
        logContext: 'test-parsing'
      });
    } else {
      parsedResult = mockResponse3.output;
    }
    
    console.log('✅ Test 3 Result:', {
      hasResult: !!parsedResult,
      resultType: typeof parsedResult,
      treatedAsString: !outputAsJson,
      isString: typeof parsedResult === 'string'
    });
  } catch (error) {
    console.error('❌ Test 3 failed:', error.message);
  }
  
  // Test 4: Complex nested JSON with outputAsJson: true
  console.log('\n📝 Test 4: Complex nested JSON with outputAsJson: true');
  const complexJsonOutput = JSON.stringify({
    page: "The ancient library stood silent...",
    mood: "mysterious",
    actions: [
      {
        id: "search",
        text: "Search the shelves",
        requirements: { intelligence: 10, perception: 8 },
        outcomes: {
          success: "You find a mysterious tome",
          failure: "You find nothing but dust"
        }
      }
    ],
    metadata: {
      location: "ancient_library",
      timeOfDay: "midnight",
      difficulty: "medium"
    }
  });
  const mockResponse4 = createMockAIResponse('cerebras', 'llama3-8b', complexJsonOutput);
  
  try {
    let parsedResult;
    const outputAsJson = true;
    
    if (outputAsJson) {
      const compatibleResponse = {
        ...mockResponse4,
        result: { output: mockResponse4.output }
      };
      parsedResult = parseAISafely(compatibleResponse, {
        logContext: 'test-parsing'
      });
    } else {
      parsedResult = mockResponse4.output;
    }
    
    console.log('✅ Test 4 Result:', {
      hasResult: !!parsedResult,
      resultType: typeof parsedResult,
      hasNestedActions: Array.isArray(parsedResult?.actions),
      firstActionComplexity: parsedResult?.actions?.[0]?.outcomes ? 'complex' : 'simple',
      hasMetadata: !!parsedResult?.metadata,
      locationValue: parsedResult?.metadata?.location
    });
  } catch (error) {
    console.error('❌ Test 4 failed:', error.message);
  }
  
  // Test 5: Empty string with outputAsJson: true
  console.log('\n📝 Test 5: Empty string with outputAsJson: true');
  const emptyOutput = '';
  const mockResponse5 = createMockAIResponse('nvidia', 'nim-llama-2.5b', emptyOutput);
  
  try {
    let parsedResult;
    const outputAsJson = true;
    
    if (outputAsJson) {
      const compatibleResponse = {
        ...mockResponse5,
        result: { output: mockResponse5.output }
      };
      parsedResult = parseAISafely(compatibleResponse, {
        logContext: 'test-parsing'
      });
    } else {
      parsedResult = mockResponse5.output;
    }
    
    console.log('✅ Test 5 Result:', {
      hasResult: !!parsedResult,
      resultType: typeof parsedResult,
      fallbackValue: parsedResult?.output
    });
  } catch (error) {
    console.error('❌ Test 5 failed:', error.message);
  }
  
  console.log('\n🎯 Parsing Logic Test Summary:');
  console.log('✅ All parsing logic tests completed');
  console.log('📊 This test validates parseAISafely integration without API calls');
}

// Run test if executed directly
// if (import.meta.url === `file://${process.argv[1]}`) {
  testParsingLogic().catch(console.error);
// }

export { testParsingLogic };
