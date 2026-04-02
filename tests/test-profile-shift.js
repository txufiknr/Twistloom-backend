// Test script for enhanced detectProfileShift function
import { detectProfileShift, derivePsychologicalProfile, updatePsychologicalProfile } from '../src/utils/story.js';

// Mock story state for testing
function createMockState(overrides = {}) {
  return {
    page: 5,
    maxPage: 10,
    actions: [
      "investigate the strange noise",
      "explore the dark corridor", 
      "check the locked door",
      "avoid the mysterious figure",
      "hide from the shadows",
      "run away from the voice"
    ],
    flags: {
      fear: "medium",
      curiosity: "high",
      trust: "medium",
      guilt: "low"
    },
    psychologicalProfile: {
      archetype: "the_explorer",
      stability: "stable",
      dominantTraits: ["curious", "investigative", "brave"],
      manipulationAffinity: "confusion"
    },
    hiddenState: {
      profileShift: null,
      realityStability: "stable"
    },
    memoryIntegrity: "stable",
    traumaTags: [],
    difficulty: "medium",
    ...overrides
  };
}

console.log("Testing enhanced detectProfileShift function...\n");

// Test 1: Archetype collapse detection
console.log("=== Test 1: Archetype Collapse ===");
const state1 = createMockState();
updatePsychologicalProfile(state1);
const shift1 = detectProfileShift(state1);
console.log("Shift detected:", shift1);
if (shift1) {
  console.log("Shift type:", state1.hiddenState.profileShift.shiftType);
  console.log("Expected: archetype_collapse (explorer avoiding)");
}
console.log();

// Test 2: Reality breakdown detection
console.log("=== Test 2: Reality Breakdown ===");
const state2 = createMockState({
  actions: [
    "investigate the strange noise",
    "explore the dark corridor", 
    "check the locked door",
    "hallucinate seeing faces",
    "experience impossible geometry",
    "see the unreal truth"
  ],
  psychologicalProfile: {
    archetype: "the_paranoid",
    stability: "unstable", 
    dominantTraits: ["fearful", "suspicious"],
    manipulationAffinity: "fear"
  }
});
updatePsychologicalProfile(state2);
const shift2 = detectProfileShift(state2);
console.log("Shift detected:", shift2);
if (shift2) {
  console.log("Shift type:", state2.hiddenState.profileShift.shiftType);
  console.log("Expected: reality_breakdown");
}
console.log();

// Test 3: Trait inversion detection
console.log("=== Test 3: Trait Inversion ===");
const state3 = createMockState({
  actions: [
    "investigate the strange noise", 
    "explore the dark corridor",
    "check the locked door",
    "avoid the mysterious figure",
    "hide from the shadows", 
    "run away from the voice"
  ],
  psychologicalProfile: {
    archetype: "the_explorer",
    stability: "cracking",
    dominantTraits: ["curious", "investigative", "brave"],
    manipulationAffinity: "confusion"
  }
});
updatePsychologicalProfile(state3);
const shift3 = detectProfileShift(state3);
console.log("Shift detected:", shift3);
if (shift3) {
  console.log("Shift type:", state3.hiddenState.profileShift.shiftType);
  console.log("Expected: trait_inversion (curious traits + avoiding actions)");
}
console.log();

// Test 4: Fear to aggression detection
console.log("=== Test 4: Fear to Aggression ===");
const state4 = createMockState({
  actions: [
    "hide from the shadows",
    "run away from the voice",
    "avoid the mysterious figure", 
    "attack the door",
    "break the window",
    "destroy the barrier"
  ],
  psychologicalProfile: {
    archetype: "the_avoider",
    stability: "cracking",
    dominantTraits: ["fearful", "cautious", "hesitant"],
    manipulationAffinity: "control_loss"
  }
});
updatePsychologicalProfile(state4);
const shift4 = detectProfileShift(state4);
console.log("Shift detected:", shift4);
if (shift4) {
  console.log("Shift type:", state4.hiddenState.profileShift.shiftType);
  console.log("Expected: fear_to_aggression");
}
console.log();

// Test 5: No shift (consistent behavior)
console.log("=== Test 5: No Shift (Consistent Behavior) ===");
const state5 = createMockState({
  actions: [
    "investigate the strange noise",
    "explore the dark corridor",
    "check the locked door", 
    "examine the strange object",
    "search for clues",
    "investigate the source"
  ],
  psychologicalProfile: {
    archetype: "the_explorer", 
    stability: "stable",
    dominantTraits: ["curious", "investigative"],
    manipulationAffinity: "confusion"
  }
});
updatePsychologicalProfile(state5);
const shift5 = detectProfileShift(state5);
console.log("Shift detected:", shift5);
console.log("Expected: false (consistent explorer behavior)");
console.log();

console.log("All tests completed!");
