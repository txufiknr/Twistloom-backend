// Test script for generateRandomCharacterBio function
import { generateRandomCharacter } from '../src/utils/characters.js';

console.log('Testing generateRandomCharacterBio function - 20 samples:\n');

for (let i = 1; i <= 20; i++) {
  const character = generateRandomCharacter();
  console.log(`${i}. ${character.name} (${character.gender}, ${character.age})`);
  console.log(`   Bio: ${character.bio}`);
  console.log('---');
}
