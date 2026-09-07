/**
 * Byte-level verification of @isdk/json-repair consumeString bug
 */
import { readFileSync } from 'fs';
import { SchemaWalker, RepairParser } from '@isdk/json-repair';

// Simple test: does consumeString strip backslashes from \n?
const testCases = [
  { input: '{"text":"Hello\\n\\nWorld"}', desc: 'Standard \\n\\n escapes' },
  { input: '{"text":"Line1\\nLine2"}', desc: 'Single \\n' },
  { input: '{"text":"Tab\\tHere"}', desc: '\\t escape' },
  { input: '{"text":"Quote\\"Here"}', desc: '\\" escape' },
];

const schema = {
  type: 'object' as const,
  properties: { text: { type: 'string' as const } }
};

const walker = await SchemaWalker.create(schema);

console.log('=== @isdk/json-repair consumeString behavior ===\n');
for (const tc of testCases) {
  const parser = new RepairParser(walker);
  const result = parser.parse(tc.input);
  const inputChars = [...tc.input];
  const resultChars = [...(result?.text ?? '')];
  console.log(`Input:    ${tc.input}`);
  console.log(`Expected: ${tc.desc}`);
  console.log(`Result:   "${result?.text}"`);
  console.log(`Result chars: [${resultChars.map(c => `U+${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(', ')}]`);
  console.log(`Backslashes stripped: ${(result?.text ?? '').includes('n') && !(result?.text ?? '').includes('\\n')}`);
  console.log();
}

// Now test with the actual nn.txt content
console.log('=== Actual nn.txt balanced extraction ===');
const raw = readFileSync('D:/Projects/Twistloom/Twistloom-backend/sample/eval_output_json_string_nn.txt', 'utf8');
const jsonLines = raw.split('\n').filter(l => !l.startsWith('//')).join('\n');
const start = jsonLines.indexOf('{');
const end = jsonLines.lastIndexOf('}');
const outerObj = JSON.parse(jsonLines.substring(start, end + 1));
const evaluatorOutput = outerObj.output as string;

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
const fullSchema = {
  type: 'object' as const,
  properties: {
    text: { type: 'string' as const },
    mood: { type: 'string' as const },
    placeId: { type: 'string' as const },
    sceneType: { type: 'string' as const },
    charactersPresent: { type: 'array' as const },
    keyEvents: { type: 'array' as const },
    branchNames: { type: 'array' as const },
  }
};

const fullWalker = await SchemaWalker.create(fullSchema);
const fullParser = new RepairParser(fullWalker);
const result = fullParser.parse(balanced);

console.log(`Balanced length: ${balanced.length}`);
console.log(`result.text length: ${result?.text?.length}`);
console.log(`result.text has "nn": ${result?.text?.includes('nn')}`);
console.log(`result.text has "\\n\\n": ${result?.text?.includes('\n\n')}`);

// Show the actual bytes of the first 100 chars
const textChars = [...(result?.text ?? '').slice(0, 100)];
console.log(`\nFirst 100 chars (byte view):`);
console.log(textChars.map((c, i) => {
  const code = c.charCodeAt(0);
  if (code === 0x0A) return '\\n(LF)';
  if (code === 0x0D) return '\\r(CR)';
  if (code === 0x09) return '\\t(TAB)';
  if (code === 0x5C) return '\\\\(BACKSLASH)';
  return c;
}).join(''));
