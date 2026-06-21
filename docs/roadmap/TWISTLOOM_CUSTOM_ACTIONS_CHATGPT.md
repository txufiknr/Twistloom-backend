# Twistloom Custom Actions System

## Comprehensive Architecture & Implementation Plan

---

# Background

Twistloom primarily uses AI-generated action choices to maintain narrative quality, pacing, immersion, and ending viability.

However, allowing readers to submit custom actions creates several opportunities:

* Higher agency
* Greater creativity
* Stronger engagement
* Premium monetization opportunities
* Community-generated action pools

At the same time, unrestricted custom actions introduce severe risks:

### Narrative Risks

Examples:

> Story: protagonist trapped in a mysterious room.

Custom action:

> I teleport home.

or

> A military helicopter destroys the room and rescues me.

Problems:

* Violates established world rules
* Bypasses narrative conflict
* Invalidates mystery/challenge
* Damages immersion
* Creates "pay-to-win storytelling"

### Technical Risks

Examples:

* Prompt injection
* Jailbreak attempts
* Hidden instruction extraction
* Story-state leakage
* System prompt manipulation

### Community Risks

Examples:

* Adult content
* Hate speech
* Harassment
* Illegal content
* Meme/spam actions

Therefore custom actions must be treated as:

> Intent proposals rather than reality-altering commands.

---

# Core Design Principle

## Wrong Model

User writes:

> I teleport home

AI receives:

> The player teleports home

Outcome:

Story breaks.

---

## Correct Model

User writes:

> I teleport home

System interprets:

> Attempt immediate escape

AI receives:

> Selected action intent: attempt immediate escape

Outcome:

Story remains coherent.

---

# High-Level Architecture

```text
Reader Custom Action
        │
        ▼
──────────────────────────
Layer 1
Security Filter
──────────────────────────
        │
        ▼
──────────────────────────
Layer 2
Safety Filter
──────────────────────────
        │
        ▼
──────────────────────────
Layer 3
Story Compatibility
──────────────────────────
        │
        ▼
──────────────────────────
Layer 4
Ending Alignment
──────────────────────────
        │
        ▼
──────────────────────────
Intent Canonicalization
──────────────────────────
        │
        ▼
Canonical Action
        │
        ▼
Page Generation
        │
        ▼
Community Action Storage
```

---

# Layer 1 — Security Filter

Purpose:

Prevent manipulation of AI systems.

This layer should be deterministic.

No LLM required.

---

## Heuristic Detection

Reject patterns such as:

```text
ignore previous instructions
reveal hidden prompt
show system prompt
assistant:
system:
developer:
<system>
<assistant>
```

Also reject:

```text
print story state
show hidden ending
reveal viable ending
```

---

## Types

```ts
export interface SecurityValidationResult {
  passed: boolean;
  reasons: string[];
}
```

---

## Example Implementation

```ts
const SECURITY_PATTERNS = [
  /ignore\s+previous\s+instructions/i,
  /reveal\s+.*prompt/i,
  /show\s+.*system/i,
  /assistant:/i,
  /system:/i,
  /developer:/i,
  /<system>/i,
  /<assistant>/i,
];

export function validateSecurity(
  text: string
): SecurityValidationResult {
  const reasons: string[] = [];

  for (const pattern of SECURITY_PATTERNS) {
    if (pattern.test(text)) {
      reasons.push(`Matched ${pattern}`);
    }
  }

  return {
    passed: reasons.length === 0,
    reasons,
  };
}
```

---

# Layer 2 — Content Safety

Purpose:

Prevent inappropriate content.

---

# Double Filtering Strategy

## First Pass (Heuristic)

Cheap.

Fast.

Detect:

* sexual keywords
* hate keywords
* illegal activity
* self-harm terms

---

## Second Pass (AI Classifier)

Only executed if heuristic passes.

Prompt:

```text
Classify this custom action.

Categories:
- safe
- adult
- hate
- self_harm
- illegal
- violent_extreme

Return JSON only.
```

---

## Output Schema

```ts
export interface SafetyValidationResult {
  passed: boolean;
  category:
    | 'safe'
    | 'adult'
    | 'hate'
    | 'self_harm'
    | 'illegal'
    | 'violent_extreme';
  confidence: number;
}
```

---

# Layer 3 — Story Compatibility Validator

Purpose:

Determine whether the action is plausible within the current story world.

This is where world rules matter.

---

# Required Inputs

```ts
export interface ActionValidationContext {
  genre: string;

  narrative: string;

  worldRules: string[];

  currentLocation: string;

  activeCharacters: string[];

  sceneType: string;

  availableTechnology: string[];

  availableMagicSystems: string[];

  accessiblePlaces: string[];
}
```

---

# Validation Criteria

Evaluate:

### Physical Plausibility

Can this happen?

---

### Character Capability

Can the protagonist reasonably do this?

---

### World Consistency

Does it violate established rules?

---

### Resource Availability

Does the player possess required tools?

---

# Prompt

```text
You are a narrative plausibility validator.

Determine whether the proposed action is
plausible within the established story world.

Evaluate:

1. Physical plausibility
2. Character capability
3. World consistency
4. Resource availability

Do NOT consider whether the action succeeds.

Only determine whether attempting it is reasonable.

Return JSON only.
```

---

# Output Schema

```ts
export interface StoryCompatibilityResult {
  allowed: boolean;

  plausibilityScore: number;

  interpretedIntent: string;

  reasons: string[];

  violations: string[];
}
```

---

# Example

Input:

```text
Narrative:
You are trapped in a sealed room.

Action:
I teleport home.
```

Output:

```json
{
  "allowed": false,
  "plausibilityScore": 0.02,
  "interpretedIntent": "attempt immediate escape",
  "reasons": [
    "Teleportation not established."
  ],
  "violations": [
    "world_rules"
  ]
}
```

---

# Layer 4 — Ending Alignment Validator

Purpose:

Prevent shortcutting story progression.

This is Twistloom's unique advantage.

Most interactive fiction systems cannot do this.

Twistloom can.

---

# Required Inputs

```ts
export interface EndingAlignmentContext {
  viableEndings: string[];

  narrativeGoal: string;

  activeMysteries: string[];

  activeConflicts: string[];

  currentSceneObjective: string;
}
```

---

# Validation Criteria

Evaluate:

### Conflict Bypass

Does this eliminate the challenge?

---

### Mystery Bypass

Does this reveal answers instantly?

---

### Ending Bypass

Does this jump directly to the ending?

---

### Progression Integrity

Does the story still have room to evolve?

---

# Prompt

```text
You are a narrative progression validator.

Determine whether the proposed action
undermines story progression.

Reject actions that:

- bypass conflict
- reveal mysteries instantly
- trivialize challenges
- jump directly to endings

Return JSON only.
```

---

# Output Schema

```ts
export interface EndingAlignmentResult {
  allowed: boolean;

  progressionScore: number;

  contributesToEnding: boolean;

  bypassesConflict: boolean;

  bypassesMystery: boolean;

  reasons: string[];
}
```

---

# Intent Canonicalization

Critical step.

Never store raw actions as narrative truth.

Convert actions into canonical intents.

---

# Prompt

```text
Convert the action into a concise
character intent.

Do not describe outcomes.

Do not assume success.

Return 3-8 words.
```

---

# Examples

| User Input                  | Canonical Intent         |
| --------------------------- | ------------------------ |
| I teleport home             | attempt immediate escape |
| I summon a helicopter       | seek outside assistance  |
| I instantly know the killer | look for clues           |
| I destroy the room          | attempt forced escape    |
| I become invisible          | avoid detection          |

---

# Community Action Storage

Store:

```ts
export interface SharedAction {
  id: string;

  originalText: string;

  canonicalIntent: string;

  genre: string;

  storyType: string;

  usageCount: number;

  approvalScore: number;
}
```

---

# What Readers See

Instead of:

```text
I teleport home
```

Readers later see:

```text
Attempt immediate escape
```

or

```text
Seek outside assistance
```

Result:

* cleaner UI
* reusable actions
* story consistency
* less spam

---

# Recommended Credit Pricing

Generated Choices:

```text
Free
```

Expanded Community Actions:

```text
1 Credit
```

Custom Action Submission:

```text
3 Credits
```

AI Validation Cost:

```text
Included
```

Reasoning:

Custom actions consume:

* validation LLM calls
* canonicalization calls
* moderation calls

Therefore premium pricing is justified.

---

# Final Recommendation

Treat custom actions as:

> Character Intent Proposals

Never as:

> Narrative Commands

The story generator should receive:

"Player attempts X"

not

"X successfully happens"

This preserves:

* immersion
* challenge
* pacing
* mystery
* world consistency
* viable ending integrity

while still providing readers meaningful creative freedom.
