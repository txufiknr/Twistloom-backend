# Twistloom Story Bible Architecture

## Overview

The book initialization step does **not** simply generate the first page.

Its primary responsibility is to create a **Story Bible**—a structured foundation that future page-generation AIs can consistently build upon across dozens or even hundreds of stateless generation requests.

Every field exists to answer a different question about the story. Their responsibilities intentionally overlap as little as possible to minimize redundancy and improve long-term consistency.

---

# Core Philosophy

Think of the Story Bible as four independent planning layers:

```
Reader Curiosity
        │
     Threads

Author Intent
        │
   Future Notes

Story Assets
        │
 Characters / Places / Facts

Narrative Destiny
        │
  Viable Ending
```

Each layer serves a unique purpose.

---

# Main Character

### Question

> Who is this story about, and why are they vulnerable?

### Responsibility

Defines the protagonist that the entire story revolves around.

This includes:

* identity
* personality
* psychological weaknesses
* motivations
* perspective

The MC should be emotionally compatible with the story's central conflict.

The MC is **not** a plot summary.

---

# Initial Characters

### Question

> Who is physically present when the story begins?

### Responsibility

Represents characters already participating in the opening scene.

Only include characters that are actually present.

Do not include:

* characters mentioned only in dialogue
* future characters
* unseen antagonists
* historical figures

These characters become immediately available to future page generation.

---

# Planned Characters

### Question

> Who else exists in this story and will matter later?

### Responsibility

Represents important story characters that already exist in the story world but have not yet appeared.

These are long-term narrative assets.

Every planned character should have:

* a narrative purpose
* an intended introduction
* a meaningful relationship to the story

Do not include disposable NPCs.

---

# Story Purpose

### Question

> Why does this character exist in the narrative?

### Responsibility

Describes the character's long-term narrative function.

Examples:

* emotional anchor
* mentor
* rival
* hidden antagonist
* unreliable ally
* red herring

This explains **why the writer created this character**, not what they do next.

Avoid describing specific future events.

---

# Planned Introduction

### Question

> How and when should this character first enter the story?

### Responsibility

Provides guidance for naturally introducing the character later.

This is about their first appearance.

It is **not** their entire story arc.

---

# Initial Relationships

### Question

> Which relationships already exist before the story begins?

### Responsibility

Represents established relationships between characters already introduced.

Relationship changes belong in future updates.

---

# Threads

### Question

> What unanswered questions keep the reader turning pages?

### Responsibility

Threads represent long-term narrative questions.

Examples:

* mysteries
* investigations
* emotional conflicts
* conspiracies
* survival goals

Threads exist primarily for the **reader**.

They create curiosity.

Not every thread needs a complete explanation.

Psychological horror often benefits from ambiguity.

Good threads make readers wonder.

Bad threads simply restate the plot.

---

# Future Notes

### Question

> What should future AI generations remember that hasn't happened yet?

### Responsibility

Future Notes are narrative reminders for future page generation.

They preserve information that would otherwise be lost across stateless LLM calls.

Future Notes may describe:

* future events
* delayed consequences
* planned introductions
* environmental changes
* recurring motifs
* pacing beats
* countdowns
* world evolution
* character reminders
* atmosphere transitions

Future Notes may be:

* major
* minor

Both are valuable.

Future Notes are **not** story threads.

Future Notes are **not** outlines.

Future Notes are **not** summaries.

Instead, they represent narrative obligations that future generation should remember.

Examples:

Good:

* The generator should fail after prolonged use.
* Dawn should break around Day 3.
* Introduce the mayor before the festival.
* Jack secretly survives the explosion.
* The pendant reacts near the church.

Bad:

* Search the room.
* Walk upstairs.
* Continue exploring.

Those are immediate actions, not long-term reminders.

---

# Viable Ending

### Question

> Where is this story naturally trying to arrive?

### Responsibility

The Viable Ending is the story's narrative destination.

It is the Story Bible's **north star**.

It guides future page generation toward a coherent long-term direction without prescribing every intermediate event.

The Viable Ending should define:

* the protagonist's ultimate fate
* the final state of the central conflict
* the intended emotional tone
* the intended ending type

Unlike traditional mystery novels, the Viable Ending does **not** need to explain everything.

Psychological thrillers and horror often preserve ambiguity.

A satisfying ending may conclude through:

* revelation
* tragedy
* sacrifice
* corruption
* acceptance
* escape
* deliberate ambiguity

Not every mystery needs an explicit answer.

---

# Initial Facts

### Question

> What truths are already established and should be remembered long-term?

### Responsibility

Facts represent persistent world knowledge.

Facts should survive dozens of pages.

Good facts:

* Sarah is allergic to morphine.
* The manor was built in 1898.
* The pendant belongs to the Ashcroft family.

Bad facts:

* Sarah opened a door.
* It was raining.
* Jack looked nervous.

Those belong elsewhere.

---

# Initial Place

### Question

> Where does the story begin?

### Responsibility

Represents the opening location as a reusable world asset.

Places should evolve over time instead of being recreated every page.

---

# First Page

### Question

> What is happening right now?

### Responsibility

The first page establishes immediate immersion.

Unlike every other Story Bible component, this represents the present rather than future planning.

---

# Separation of Responsibilities

Every field exists to answer one specific question.

| Field                 | Primary Question                                         |
| --------------------- | -------------------------------------------------------- |
| Main Character        | Who is this story about?                                 |
| Initial Characters    | Who is here right now?                                   |
| Planned Characters    | Who else will matter later?                              |
| Story Purpose         | Why does this character exist?                           |
| Planned Introduction  | How should this character first appear?                  |
| Initial Relationships | Which relationships already exist?                       |
| Threads               | What questions keep readers engaged?                     |
| Future Notes          | What should future AI remember that hasn't happened yet? |
| Initial Facts         | What truths are already established?                     |
| Initial Place         | Where does the story begin?                              |
| Viable Ending         | Where is the story naturally trying to arrive?           |
| First Page            | What is happening right now?                             |

---

# Design Principles

A Story Bible should not merely describe the opening.

It should provide enough structure that future AI generations can consistently maintain:

* characters
* relationships
* mysteries
* pacing
* atmosphere
* world state
* long-term narrative direction

while still allowing individual pages and branching choices to feel surprising and organic.

The Story Bible should act as a compass—not a script.
