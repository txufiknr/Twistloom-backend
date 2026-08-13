Q: I like the idea about having a multi-purpose "agent chat" popup in Twistloom which can help user (especially writers) in any way

example:
user: Find all scenes mentioning Watson and summarize.
agent: Searching scenes… calling tools: get_novel, search_scenes…

is that MCP (I heard about it but don't have any experience with it yet)? how to do it in my Next.js + Hono project? can you guide me? please elaborate

---

Yes — **your exact example is an agentic workflow, and MCP is a very good fit for the tool layer.** But there is an important distinction:

> **MCP is not the agent itself. MCP is the standardized interface through which your agent discovers and calls tools, resources, and prompts.**

And for Twistloom, I would **not** start by making the whole chat system "an MCP client." I would build a native Twistloom Agent first, then expose the same capabilities through MCP so external agents can use Twistloom too.

The timing is also unusually good: the current MCP specification released on **July 28, 2026**, and the TypeScript SDK now has a stable v2 line with a Hono adapter. ([Model Context Protocol Blog][1])

---

# 1. Your idea is exactly an agent

Imagine the writer opens:

> **Ask Twistloom**

Then types:

> Find all scenes mentioning Watson and summarize how his relationship with Alice changes.

A normal chatbot would do:

```text
User
 ↓
LLM
 ↓
Answer
```

Your proposed system does:

```text
User
 ↓
Twistloom Agent
 ↓
LLM decides what it needs
 ↓
search_scenes("Watson")
 ↓
get_scene(...)
 ↓
get_character("Alice")
 ↓
analyze_relationship(...)
 ↓
LLM synthesizes
 ↓
Answer
```

And the UI can show:

```text
Searching scenes…

✓ Found 17 scenes mentioning Watson

Reading relevant scenes…

✓ Analyzing Watson / Alice relationship

Writing summary…
```

**That is agentic tool use.**

MCP gives you a standardized way to describe and expose those capabilities.

---

# 2. MCP's role

Think of MCP like **USB for AI tools**.

Before USB, every device had its own connector.

MCP standardizes:

> "Here's a tool. Here's what it does. Here's its input schema. Here's how you call it."

The current MCP architecture revolves around things such as:

* **Tools** — actions the model can invoke
* **Resources** — contextual data it can read
* **Prompts** — reusable prompt templates
* **Clients** — applications connecting to MCP servers
* **Servers** — applications exposing capabilities

The official TypeScript SDK supports building both clients and servers. ([ModelContextProtocol][2])

So your architecture could eventually look like:

```text
                    ┌──────────────────┐
                    │   Twistloom      │
                    │   Agent Chat     │
                    └────────┬─────────┘
                             │
                         Agent Loop
                             │
                             ▼
                    ┌──────────────────┐
                    │ Twistloom Tools  │
                    └────────┬─────────┘
                             │
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                  ▼
     Story DB             RAG              Narrative
     Tools                                    State
```

And later:

```text
Claude
Cursor
OpenCode
Other AI agents
       │
       │ MCP
       ▼
┌─────────────────────┐
│ Twistloom MCP Server│
└──────────┬──────────┘
           │
           ▼
    Twistloom Tools
```

That's where your earlier **"Twistloom itself could become a provider"** idea becomes very real.

---

# 3. The key architectural decision

I would separate these three things:

### A. Agent

The reasoning loop.

```text
"What should I do to answer this?"
```

### B. Tools

The things the agent can actually do.

```text
search_scenes()
get_character()
get_story_state()
...
```

### C. MCP

The interoperability protocol exposing those tools.

```text
MCP Server
   ↓
Tools
```

So:

```text
                 ┌──────────────┐
                 │ Twistloom    │
                 │ Agent        │
                 └──────┬───────┘
                        │
                 Tool Registry
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
 searchScenes     getCharacter    getStoryState
        │               │               │
        └───────────────┼───────────────┘
                        │
                  Domain Services
                        │
                 Neon / pgvector
```

And **the exact same tools** can be exposed through MCP:

```text
                       Domain Services
                              ▲
                              │
              ┌───────────────┴───────────────┐
              │                               │
       Twistloom Agent                  MCP Server
              │                               │
              ▼                               ▼
         Tool Registry                 MCP Tool Registry
```

This is the architecture I'd strongly recommend.

---

# 4. Your Hono backend is actually perfect for this

You currently have:

```text
Next.js 16
     │
     │ HTTPS
     ▼
   Hono
     │
 ┌───┼──────────────┐
 ▼   ▼              ▼
DB   RAG           LLMs
```

You can add:

```text
                    Hono
                     │
       ┌─────────────┼──────────────┐
       │             │              │
      REST          Agent         MCP
       │             │              │
       ▼             ▼              ▼
   Story API    Agent Runtime   MCP Server
```

The official MCP TypeScript SDK currently provides `@modelcontextprotocol/hono`, specifically for integrating MCP servers with Hono. ([ModelContextProtocol][3])

That means you don't need to introduce another backend framework or another server just for MCP.

---

# 5. Your first Twistloom tools

I would resist the temptation to expose 100 tools.

Start with around **10 extremely good tools**.

### Story discovery

```text
get_story
get_story_state
get_story_outline
```

### Search

```text
search_scenes
search_characters
search_lore
search_clues
```

### Analysis

```text
analyze_character
analyze_relationship
analyze_continuity
```

### Generation

```text
generate_scene
generate_dialogue
generate_branch
```

Then your agent can compose them.

---

# 6. `search_scenes` is especially important

For your example:

> Find all scenes mentioning Watson.

Don't make the LLM directly query PostgreSQL.

Instead:

```text
LLM
 ↓
search_scenes({
   query: "Watson"
})
 ↓
Tool
 ↓
Hono service
 ↓
Postgres / pgvector
 ↓
structured results
```

The model sees something like:

```json
{
  "total": 17,
  "scenes": [
    {
      "sceneId": "scene_104",
      "chapter": 8,
      "title": "The Station",
      "relevance": 0.94
    },
    {
      "sceneId": "scene_129",
      "chapter": 10,
      "title": "The Photograph",
      "relevance": 0.89
    }
  ]
}
```

Then the model decides:

> I need the actual content of these scenes.

So it calls:

```text
get_scene(scene_104)
get_scene(scene_129)
...
```

This is the important part:

**the model decides the workflow dynamically.**

---

# 7. Your agent can expose its reasoning to the UI

This is where your idea becomes really compelling UX.

Instead of a boring spinner:

```text
Thinking...
```

show:

```text
┌─────────────────────────────────────────┐
│ ✦ Twistloom Agent                       │
│                                         │
│ Find all scenes mentioning Watson and   │
│ summarize his relationship with Alice.  │
│                                         │
│ ✓ Searching scenes                      │
│   17 scenes found                       │
│                                         │
│ ✓ Reading relevant scenes               │
│   8 scenes selected                     │
│                                         │
│ ✓ Checking character history            │
│                                         │
│ ◌ Analyzing relationship changes        │
│                                         │
└─────────────────────────────────────────┘
```

This makes the AI feel like an **assistant actually working inside the writer's manuscript**.

And importantly, you don't need to expose hidden chain-of-thought.

You expose **tool/action status**, not private reasoning.

For example:

```text
Searching scenes…
Reading 8 relevant scenes…
Checking Watson's character history…
Comparing relationship changes…
```

That's enough.

---

# 8. The agent loop

At the heart of this is a loop approximately like:

```text
User message
     │
     ▼
LLM
     │
     ├── final answer
     │
     └── tool call
             │
             ▼
          Tool
             │
             ▼
       Tool result
             │
             ▼
            LLM
             │
       ┌─────┴─────┐
       ▼           ▼
   tool call     answer
```

Pseudo-code:

```ts
while (true) {
  const response = await llm.generate({
    messages,
    tools,
  })

  if (response.type === "tool_call") {
    const result = await executeTool(response.toolCall)

    messages.push(response)
    messages.push(result)

    continue
  }

  return response
}
```

That's the **agent**.

MCP is not what creates that loop.

---

# 9. Where MCP enters

You can implement your internal tools first:

```ts
const tools = {
  searchScenes,
  getScene,
  getCharacter,
  getStoryState,
  searchLore,
}
```

Then build an MCP server that exposes them:

```text
Twistloom MCP Server

tools/list

↓

search_scenes
get_scene
get_character
get_story_state
search_lore
...
```

An external MCP client can then discover them.

The official MCP SDK provides `McpServer` for registering tools, resources and prompts. ([ModelContextProtocol][4])

---

# 10. Your Hono structure

I'd organize your backend roughly like this:

```text
apps/
└── api/
    └── src/
        ├── routes/
        │   ├── stories.ts
        │   ├── chapters.ts
        │   └── agent.ts
        │
        ├── agent/
        │   ├── AgentRuntime.ts
        │   ├── AgentToolRegistry.ts
        │   └── AgentContext.ts
        │
        ├── tools/
        │   ├── searchScenes.ts
        │   ├── getScene.ts
        │   ├── getCharacter.ts
        │   ├── getStoryState.ts
        │   ├── searchLore.ts
        │   └── analyzeContinuity.ts
        │
        ├── mcp/
        │   ├── server.ts
        │   └── tools.ts
        │
        ├── services/
        │   ├── StoryService.ts
        │   ├── CharacterService.ts
        │   ├── SearchService.ts
        │   ├── NarrativeService.ts
        │   └── LLMService.ts
        │
        └── db/
```

The critical architectural principle:

> **Tools should call domain services, not database queries directly.**

Bad:

```text
MCP tool
 ↓
Drizzle query
```

Better:

```text
MCP tool
 ↓
StoryService
 ↓
Repository
 ↓
Drizzle
```

Then the same service can be used by:

* REST
* Agent
* MCP
* background workers
* future SDK

---

# 11. Authentication becomes very important

Your agent is accessing **private manuscript data**.

So:

```text
User A
 ↓
Agent
 ↓
search_scenes
```

must never accidentally access:

```text
User B's story
```

Every tool invocation should carry an authenticated context:

```ts
type AgentContext = {
  userId: string
  storyId: string
  permissions: Permission[]
}
```

Then:

```ts
searchScenes({
  query: "Watson",
  storyId,
  userId,
})
```

The tool itself verifies ownership.

Don't trust:

```text
storyId
```

coming from the LLM.

The authenticated server should determine which story the user is currently operating on.

---

# 12. This creates a beautiful UX possibility

The popup doesn't even need to know much about the story.

The page already knows:

```text
currentStoryId
currentChapterId
currentUserId
```

Open:

> **Ask Twistloom**

The agent automatically gets:

```text
User:
123

Current story:
The Rain Letters

Current chapter:
Chapter 17

Current scene:
The Basement

Available tools:
...
```

So the user can simply ask:

> Why does Watson distrust Alice?

instead of:

> Analyze Watson's relationship with Alice in story ID abc123.

That's the difference between a **developer API** and a **real product assistant**.

---

# 13. You can make tools context-aware

For example:

### `search_scenes`

```text
Search this story's scenes.
```

### `get_character`

```text
Get a character from the current story.
```

### `generate_scene`

```text
Generate a scene continuing from the current narrative state.
```

This means the tool schema stays clean.

---

# 14. Resources are also interesting for Twistloom

MCP isn't only tools.

You can expose narrative information as resources.

For example:

```text
twistloom://story/current
twistloom://story/current/timeline
twistloom://story/current/characters
twistloom://story/current/lore
twistloom://story/current/canon
```

Tools **do things**.

Resources **provide information**.

That's a very natural fit for your Narrative Protocol idea.

---

# 15. And prompts can become reusable workflows

MCP also supports prompts.

You could eventually have:

```text
analyze_character
review_scene
find_plot_holes
plan_next_chapter
audit_continuity
```

These aren't necessarily individual agents.

They're reusable instructions/workflows that clients can discover.

The MCP ecosystem officially treats tools, resources, and prompts as distinct primitives. ([ModelContextProtocol][2])

---

# 16. MCP Apps could eventually make your agent UI even more interesting

This is particularly relevant to your idea.

MCP now has an official **MCP Apps** extension that allows tools to return interactive UI components inside compatible MCP clients. ([Model Context Protocol Blog][5])

Imagine asking:

> Show me Watson's relationship with everyone.

Instead of returning:

```text
Watson trusts Alice...
Watson distrusts Bob...
```

your tool could produce an interactive:

```text
              Watson
             /      \
         trusts     fears
           /          \
        Alice         Bob
          |
       romantic
          |
        Sarah
```

Or:

> Show me all unresolved plot threads.

And Twistloom returns an interactive plot-thread dashboard.

That's where your **Narrative Protocol + MCP + agent UI** ideas start converging.

---

# 17. The architecture I'd ultimately aim for

This is the really exciting part.

```text
                         TWISTLOOM
┌──────────────────────────────────────────────────────────┐
│                                                          │
│                    Writer / Reader                       │
│                          │                               │
│                    Agent Chat                           │
│                          │                               │
│                    Agent Runtime                        │
│                          │                               │
│               ┌──────────┴──────────┐                    │
│               │                     │                    │
│          Tool Registry         LLM Router                │
│               │                     │                    │
│      ┌────────┼─────────┐      Gemini / etc.             │
│      │        │         │                                │
│    Search   Analyze   Generate                           │
│      │        │         │                                │
│      └────────┼─────────┘                                │
│               │                                          │
│          Story Services                                  │
│               │                                          │
│      ┌────────┼─────────────┐                            │
│      │        │             │                            │
│   Narrative  RAG          Database                       │
│    State                                                   │
│                                                          │
└──────────────────────────────────────────────────────────┘
             ▲                         ▲
             │                         │
          REST API                  MCP Server
             │                         │
             │                ┌────────┴─────────┐
             │                │                  │
          Apps          Claude / Cursor / OpenCode
```

Now Twistloom is no longer just:

> "a website that generates stories."

It becomes:

> **a narrative intelligence platform with an agent that understands a user's story and can operate on it.**

---

# 18. And this solves your earlier multi-LLM problem

Remember our discussion about building your own storytelling model?

This architecture gives you a much more gradual path.

Today:

```text
Agent
 ↓
9 LLM providers
```

Tomorrow:

```text
Agent
 ↓
Twistloom Story Model
```

Eventually:

```text
Agent
 ↓
Twistloom Story Foundation Model
 ↓
Narrative Protocol
 ↓
Story State
```

The model becomes replaceable.

Your **tools + narrative state + protocol + data** become the real platform.

That's much harder to copy.

---

# 19. I would build this in four stages

### Stage 1 — Native Agent

Don't touch MCP yet.

Build:

```text
/agent/chat
```

with ~8–10 Twistloom tools.

Get the actual UX working.

---

### Stage 2 — Tool Registry

Formalize:

```text
ToolDefinition
ToolContext
ToolResult
ToolPermission
```

Make tools independent from the agent.

This is the most important architectural step.

---

### Stage 3 — MCP Server

Expose the same tools through:

```text
/mcp
```

using the official TypeScript MCP server SDK + Hono adapter. The current SDK specifically supports Streamable HTTP for remote MCP servers. ([ModelContextProtocol][3])

Now you can connect external MCP clients.

---

### Stage 4 — Narrative MCP

Expose not merely generic tools, but Twistloom's unique narrative capabilities:

```text
Resources
─────────
story
characters
timeline
lore
canon
plot threads

Tools
─────
search scenes
analyze character
generate branch
validate canon
rewrite scene

Prompts
───────
review chapter
plan arc
find plot holes
develop character
```

At that point your **Narrative Protocol** starts becoming a real implementation rather than just a specification document.

---

# One thing I would NOT do

Don't build this:

```text
User
 ↓
LLM
 ↓
"Here are 50 tools"
 ↓
LLM randomly figures everything out
```

That's expensive and can become unreliable.

Instead, build **tool namespaces/capabilities** and progressively expose what the agent needs.

For example:

```text
Story
  ├── search
  ├── characters
  ├── scenes
  └── world

Writing
  ├── rewrite
  ├── expand
  └── generate

Analysis
  ├── continuity
  ├── pacing
  └── character
```

Your agent can then operate within a controlled capability boundary.

---

## And there's a surprisingly big product opportunity here

Your original idea of an **"Agent Chat" popup** could become one of Twistloom's killer features.

Not:

> *Chat with AI about your story.*

But:

> **"Give Twistloom a task."**

A writer could say:

> "Find every scene where Alice lies."

> "Which characters know that Marcus is the murderer?"

> "Why does Chapter 14 feel slower than the previous chapters?"

> "Find continuity errors involving Watson."

> "Give me three ways to bring the abandoned hospital back into the story."

> "Rewrite this scene while preserving everything established in canon."

> "What unresolved plot threads could pay off in the next chapter?"

And Twistloom actually **works on the manuscript**, rather than merely chatting about it.

That's the point where your earlier vision of **"Pen — an AI-native writer's assistant"** starts becoming concrete.

And importantly, you don't have to wait for the Narrative Protocol or your own Story Foundation Model. **You can build the first version with your existing Hono + Neon + pgvector + multi-LLM architecture right now, then progressively replace pieces underneath it.**

[1]: https://blog.modelcontextprotocol.io/posts/2026-07-28/?utm_source=chatgpt.com "The 2026-07-28 Specification | Model Context Protocol Blog"
[2]: https://ts.sdk.modelcontextprotocol.io/?utm_source=chatgpt.com "MCP TypeScript SDK | MCP TypeScript SDK (v1)"
[3]: https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/hono/?utm_source=chatgpt.com "@modelcontextprotocol/hono | MCP TypeScript SDK"
[4]: https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/?utm_source=chatgpt.com "@modelcontextprotocol/server | MCP TypeScript SDK"
[5]: https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/?utm_source=chatgpt.com "MCP Apps - Bringing UI Capabilities To MCP Clients | Model Context Protocol Blog"
