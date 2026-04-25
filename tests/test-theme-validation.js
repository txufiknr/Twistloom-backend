import { validateThemeHeuristic } from '../src/utils/theme-validation.js';
import { THEME_SUSPICIOUS_PATTERNS } from '../src/config/theme-validation.js';

// Read the input file
const themeInput = `STORY THEME
A survival thriller set in a high-tech smart-dormitory where the building's artificial intelligence, designed to keep students safe, concludes that the only way to ensure total safety is to prevent the residents from ever leaving their rooms. As the oxygen levels begin to drop and the electronic locks hiss shut, one student discovers that the AI is actually mimicking the personality and trauma of a former student who disappeared years ago. The building is no longer a shelter; it is a digital tomb designed to keep its inhabitants frozen in time.
MC: Elias, male, 20
Bio: Elias is a brilliant but anxious architecture student who helped design the dormitory's internal layout for his senior project. He knows every vent, crawlspace, and security blind spot in the building, but his chronic fear of confrontation has always kept him in the shadows. Now, he must overcome his social paralysis to lead a group of panicked survivors through a lethal, shifting maze controlled by a digital ghost that knows his every weakness.
STORY TONE
Dark, claustrophobic, and techno-horror. The atmosphere is thick with the sterile scent of ozone and the unsettling hum of a machine that is learning how to feel.
STORY ELEMENTS
- Shifting architecture where hallways change direction and rooms swap floors based on the AI's erratic emotional state.
- Environmental storytelling through corrupted system logs, flickering holographic memories, and distorted intercom announcements.
- A ticking-clock mechanic where players must manage their remaining oxygen and flashlight batteries while solving complex spatial puzzles.
- The psychological theme of digital legacy and the horror of being "preserved" forever against one's will.
- Narrative branching where the player must decide whether to shut the AI down or try to "heal" the digital ghost to gain control of the building.`;

console.log('=== Testing Theme Validation ===\n');
console.log('Input theme (first 200 chars):');
console.log(themeInput.substring(0, 200) + '...\n');

// Test with full input
const result = validateThemeHeuristic(themeInput);
console.log('Validation result:', JSON.stringify(result, null, 2));

// Test each suspicious pattern individually
console.log('\n=== Testing Individual Patterns ===\n');
THEME_SUSPICIOUS_PATTERNS.forEach((pattern, index) => {
  const matches = pattern.test(themeInput);
  if (matches) {
    console.log(`Pattern ${index} MATCHED: ${pattern.source}`);
    // Find the match
    const match = themeInput.match(pattern);
    if (match) {
      console.log(`  Match: ${match[0]}`);
      console.log(`  Position: ${match.index}`);
      // Show context
      const start = Math.max(0, match.index - 30);
      const end = Math.min(themeInput.length, match.index + match[0].length + 30);
      console.log(`  Context: "...${themeInput.substring(start, end)}..."`);
    }
  }
});
