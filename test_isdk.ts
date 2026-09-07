/**
 * @isdk/json-repair consumeString bug verification
 */
import { readFileSync } from 'fs';
import { SchemaWalker, RepairParser } from '@isdk/json-repair';

const raw = readFileSync('D:/Projects/Twistloom/Twistloom-backend/sample/eval_output_json_string_nn.txt', 'utf8');
const jsonLines = raw.split('\n').filter(l => !l.startsWith('//')).join('\n');
const start = jsonLines.indexOf('{');
const end = jsonLines.lastIndexOf('}');
const outerObj = JSON.parse(jsonLines.substring(start, end + 1));
const evaluatorOutput = outerObj.output as string;

// Balanced extraction (the valid StoryGeneration JSON)
function extractFirstBalancedJsonObject(str: string): string | null {
  const s = str.indexOf('{');
  if (s === -1) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = s; i < str.length; i++) {
    const ch = str[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return str.substring(s, i + 1); }
    }
  }
  return null;
}

const balanced = extractFirstBalancedJsonObject(evaluatorOutput)!;
const fullCandidate = evaluatorOutput.substring(evaluatorOutput.indexOf('{'), evaluatorOutput.lastIndexOf('}') + 1);

console.log(`Balanced length: ${balanced.length}, Full candidate length: ${fullCandidate.length}`);
console.log();

// Test 1: @isdk/json-repair on BALANCED (valid JSON) - should preserve \n\n
console.log('=== Test 1: @isdk/json-repair on BALANCED extraction ===');
const schema = {
  type: 'object' as const,
  properties: {
    text: { type: 'string' as const },
    mood: { type: 'string' as const },
    placeId: { type: 'string' as const },
  }
};
const walker = await SchemaWalker.create(schema);
const parser = new RepairParser(walker);

try {
  const result = parser.parse(balanced);
  console.log(`SUCCEEDED: ${!!result}`);
  console.log(`text has "nn": ${result?.text?.includes('nn')}`);
  console.log(`text has "\\n\\n": ${result?.text?.includes('\n\n')}`);
  console.log(`First 200: ${JSON.stringify(result?.text?.slice(0, 200))}`);
} catch (e: any) {
  console.log(`FAILED: ${e.message?.slice(0, 200)}`);
}
console.log();

// Test 2: @isdk/json-repair on FULL candidate (with leaked fields) - this is what actually happens
console.log('=== Test 2: @isdk/json-repair on FULL candidate (leaked fields) ===');
try {
  const result = parser.parse(fullCandidate);
  console.log(`SUCCEEDED: ${!!result}`);
  console.log(`text has "nn": ${result?.text?.includes('nn')}`);
  console.log(`text has "\\n\\n": ${result?.text?.includes('\n\n')}`);
  console.log(`First 200: ${JSON.stringify(result?.text?.slice(0, 200))}`);
} catch (e: any) {
  console.log(`FAILED: ${e.message?.slice(0, 200)}`);
}
console.log();

// Test 3: @isdk/json-repair on a simple test string with \n escapes
console.log('=== Test 3: @isdk/json-repair consumeString on \\\\n escapes ===');
const testJson = '{"text":"Hello\\\\n\\\\nWorld"}';
console.log(`Input: ${testJson}`);
try {
  const result = parser.parse(testJson);
  console.log(`result.text: "${result?.text}"`);
  console.log(`result.text has "nn": ${result?.text?.includes('nn')}`);
  console.log(`result.text has "\\n": ${result?.text?.includes('\n')}`);
} catch (e: any) {
  console.log(`FAILED: ${e.message?.slice(0, 200)}`);
}
