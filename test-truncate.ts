import { truncateToLastCompleteSentence } from './src/utils/text-processing.js';

console.log('1:', JSON.stringify(truncateToLastCompleteSentence('Hello world. This is a longer sentence that goes beyond the limit.', 20)));
console.log('2:', JSON.stringify(truncateToLastCompleteSentence('No punctuation here at all just words', 15)));
console.log('3:', JSON.stringify(truncateToLastCompleteSentence('Short.', 100)));
console.log('4:', JSON.stringify(truncateToLastCompleteSentence('First sentence. Second sentence.', 16)));
console.log('5:', JSON.stringify(truncateToLastCompleteSentence('A. B. C. D. E. F. G.', 10)));
console.log('6:', JSON.stringify(truncateToLastCompleteSentence('Stop! Do not go past this point! More text.', 30)));
