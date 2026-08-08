# Phase X — The Narrative Protocol

## Toward an Open Standard for AI-Native Storytelling

> **Vision**
>
> The internet has standardized APIs, databases, authentication, and AI tool calling.
>
> But there is still **no standard representation of a story**.
>
> Every AI writing application, visual novel engine, RPG, interactive fiction platform, and game reinvents its own memory format, character model, and world state.
>
> Twistloom can change that.

---

# The Core Idea

Today, when two AI writing tools want to exchange a story, they usually exchange plain text.

```
Chapter 14.txt
```

or

```
story.md
```

This loses nearly all of the structured knowledge behind the narrative.

The AI must infer again:

* Who are the characters?
* Which relationships changed?
* Which secrets are known?
* Which plotlines are active?
* Which promises have not been fulfilled?
* Which objects exist?
* What happened yesterday?
* Which memories are unreliable?
* Which NPC is lying?

Almost all of that work is repeated for every generation.

The Narrative Protocol proposes something different.

Instead of exchanging **text**, systems exchange **story state**.

```
Story

↓

Narrative State

↓

AI
```

The AI becomes a consumer of structured narrative knowledge instead of reconstructing it every time.

---

# Why We Need a Narrative Protocol

The software industry already has protocols for nearly everything.

| Domain               | Standard |
| -------------------- | -------- |
| REST APIs            | OpenAPI  |
| Authentication       | OAuth    |
| Package distribution | npm      |
| Version control      | Git      |
| AI tool calling      | MCP      |
| Containers           | Docker   |
| API querying         | GraphQL  |

But storytelling still has no universal language.

Every platform stores:

* characters
* memories
* world lore
* timeline
* inventory
* locations
* dialogue history

...in incompatible formats.

A Narrative Protocol would provide a common vocabulary.

---

# Narrative Is More Than Text

A story is composed of many interconnected systems.

```
Story
│
├── Characters
├── World
├── Timeline
├── Events
├── Relationships
├── Psychology
├── Inventory
├── Lore
├── Dialogue
├── Themes
├── Plot Threads
├── Reader Choices
└── Canon
```

The protocol represents each of these as structured, machine-readable data.

---

# The Narrative Graph

Instead of thinking in chapters, think in graphs.

```
Alice
 │
 │ distrusts
 ▼
Bob

Bob
 │
 │ possesses
 ▼
Ancient Key

Ancient Key
 │
 │ opens
 ▼
Hidden Vault

Vault
 │
 │ contains
 ▼
Artifact
```

Everything in a story becomes an interconnected graph.

Advantages:

* efficient retrieval
* relationship reasoning
* consistency checking
* visualization
* semantic search

---

# Core Objects

The protocol could define standard object types.

## Character

Represents any actor.

Example fields:

* identifier
* aliases
* appearance
* personality
* goals
* fears
* beliefs
* skills
* secrets
* memories
* relationships
* inventory
* current location
* current emotional state
* narrative importance

---

## World

Represents the universe.

Contains:

* regions
* cities
* kingdoms
* planets
* factions
* religions
* languages
* cultures
* currencies
* technologies
* magic systems
* laws

---

## Event

Represents something that happened.

Includes:

* timestamp
* participants
* location
* consequences
* witnesses
* visibility
* confidence
* emotional impact

---

## Relationship

Not simply:

```
Alice knows Bob
```

Instead:

```
trust

romantic attraction

political alliance

family

mentor

rival

fear

debt

hatred

respect
```

Relationships become first-class objects.

---

## Plot Thread

Tracks unfinished narrative promises.

Example:

```
Who murdered the king?
```

Status:

```
Active
```

Progress:

```
65%
```

Characters involved:

```
Alice
Detective Kim
Prince Rowan
```

---

## Memory

Different memories have different properties.

Examples:

* permanent
* temporary
* forgotten
* suppressed
* false
* dream
* prophecy

This allows psychologically realistic storytelling.

---

# Story State Instead of Prompt Engineering

Current workflow:

```
Prompt

↓

LLM

↓

Prompt

↓

LLM
```

Narrative Protocol:

```
Narrative State

↓

Retriever

↓

Context Builder

↓

LLM
```

The prompt becomes a rendering of structured state.

---

# Narrative Diffs

Git changed software development because it stores changes instead of snapshots.

The Narrative Protocol can do the same.

Instead of storing:

```
Story v1

Story v2

Story v3
```

Store:

```
+ Alice trusts Bob

- Bob lost sword

+ Castle destroyed

+ Thread "Missing Prince" resolved
```

Advantages:

* replay
* undo
* branching
* efficient storage
* collaboration

---

# Native Branching

Branches become first-class citizens.

```
Timeline

        A

       /

Start

       \

        B

         \

          C
```

Every branch inherits previous narrative state.

This perfectly matches Twistloom's multiverse philosophy.

---

# Canon Engine

Not every fact is equally authoritative.

Facts could have confidence levels.

```
Canon

Official

Observed

Rumor

Dream

Prophecy

Hallucination

Player Theory
```

Different readers or characters may perceive different realities.

---

# Psychological Layer

Most AI systems only track facts.

The Narrative Protocol should also track minds.

```
Character

↓

Beliefs

↓

Goals

↓

Fear

↓

Trauma

↓

Bias

↓

Stress

↓

Mood
```

This enables consistent emotional behavior over long narratives.

---

# Knowledge Separation

Each character should possess independent knowledge.

Example:

Alice knows:

* secret tunnel

Bob knows:

* hidden treasure

Reader knows:

* murderer

King knows:

* nothing

The protocol separates:

* world truth
* character knowledge
* narrator knowledge
* reader knowledge

---

# Semantic Retrieval

Instead of searching raw text:

```
Find every time Alice was sad.
```

The system searches structured narrative objects.

```
Character = Alice

Emotion = Sadness
```

This dramatically improves retrieval quality.

---

# AI Model Independence

The protocol should not depend on GPT, Claude, Gemini, or any specific model.

```
Narrative State

↓

Renderer

↓

Any LLM
```

Changing models does not require changing story representation.

---

# Interoperability

Imagine exporting a story from Twistloom.

```
story.narrative
```

Another application imports it.

Everything is preserved:

* characters
* memories
* timeline
* choices
* world
* psychology
* branches
* lore

No custom converters required.

---

# MCP Integration

Narrative objects become MCP resources.

Examples:

```
character://alice

world://earth

thread://missing-prince

timeline://main

memory://alice/102
```

AI agents can query structured narrative information directly instead of reading entire documents.

---

# Story SDK

Official SDKs expose strongly typed objects.

Example concepts:

```
Story

Character

World

Relationship

Memory

Event

PlotThread

Timeline
```

Developers manipulate narrative objects rather than raw JSON.

---

# Ecosystem Possibilities

Once standardized, an entire ecosystem becomes possible.

### Writing software

Can exchange stories seamlessly.

---

### RPG engines

Can share world state.

---

### Visual novels

Can preserve branching narratives.

---

### AI agents

Can reason over structured stories.

---

### Educational software

Can analyze plot progression.

---

### Analytics

Can visualize narrative graphs.

---

### Community tools

Can build editors, debuggers, validators, timeline explorers, and relationship maps.

---

# Governance

The protocol should be open.

Possible approach:

* specification published publicly
* semantic versioning
* reference implementation
* official validator
* compliance test suite
* community RFC process
* extension mechanism

Twistloom remains the flagship implementation while encouraging adoption by the broader storytelling community.

---

# Long-Term Vision

Today, AI applications ask language models to generate text.

Tomorrow, they should ask narrative engines to reason about stories.

The Narrative Protocol provides the shared language that makes this possible.

Just as OpenAPI standardized web services and MCP is standardizing AI tool interoperability, the Narrative Protocol can standardize narrative intelligence itself.

Twistloom's long-term opportunity is therefore not merely to build another AI writing application.

It is to define the foundational language through which AI systems understand, exchange, preserve, and evolve stories.

If successful, developers won't say, "This app supports Twistloom."

Instead, they'll say:

> **"This app speaks the Narrative Protocol."**
