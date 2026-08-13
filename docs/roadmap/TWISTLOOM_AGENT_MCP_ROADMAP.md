# Twistloom Agent & MCP — Consolidated Roadmap

**Date:** August 13, 2026
**Consolidates:** `TWISTLOOM_MCP_ROADMAP.md` (grounded against your real codebase — routes, services, schema) and `TWISTLOOM_MCP_AGENTIC_WORKFLOW_CHATGPT.md` (architectural/UX framing for the "Agent Chat" popup idea)
**Method:** Every dated technical claim in both source docs was re-verified against current MCP documentation as of August 13, 2026. Nothing from either source was dropped — where they agreed, I merged; where they disagreed, I resolved it explicitly (see Part 0); where I found something outdated, I corrected it; where I saw a gap or a risk neither raised, I added it and labeled it as mine.

---

## Table of Contents

- [Part 0 — Fact-Check: What Changed Since Both Docs Were Written](#part-0)
- [Part I — Foundational Concepts](#part-i)
- [Part II — Design Rationale: Resolving the Sequencing Tension](#part-ii)
- [Part III — The Tiered, Ranked Roadmap](#part-iii)
- [Part IV — UI/UX & End-to-End Implementation](#part-iv)
- [Part V — Security, Auth & Cost](#part-v)
- [Part VI — Full Tool / Resource / Prompt Inventory](#part-vi)
- [Part VII — New Use Cases (Mine)](#part-vii)
- [Part VIII — My Recommendations, Collected](#part-viii)
- [Appendix — Implementation Sequence & Naming Conventions](#appendix)

---

<a id="part-0"></a>
## Part 0 — Fact-Check: What Changed Since Both Docs Were Written

The ChatGPT doc's core dated claims check out, but the details matter enough to correct both documents against:

| Claim | Verdict | Correction |
|---|---|---|
| "MCP specification released July 28, 2026" | ✅ Confirmed | Real, and it's the **largest revision since MCP launched** — worth knowing why, not just that it happened (below). |
| "TypeScript SDK now has a stable v2 line with a Hono adapter" | ✅ Confirmed, but incomplete | `@modelcontextprotocol/hono` is real and current. But this means **the MCP roadmap doc's own header is already out of date** — it specifies `@modelcontextprotocol/sdk` (the old, monolithic **v1** package). v2 splits this into `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, plus thin framework adapters (`@modelcontextprotocol/hono`, `@modelcontextprotocol/express`, `@modelcontextprotocol/fastify`, `@modelcontextprotocol/node`). Build against v2 — v1 still works but is the deprecated line going forward. |
| "MCP Apps... allows tools to return interactive UI components" | ✅ Confirmed | Real, and shipped as part of the *same* July 28, 2026 spec revision (it was in the May 2026 release candidate as an Extensions-framework feature). I can also confirm this one from firsthand operational experience — it's exactly the mechanism I use myself to render inline widgets from connected tools, described elsewhere in my own configuration. |
| (Unstated in either doc, found during fact-check) MCP 2026-07-28 removes the old session-based handshake — the protocol core is now **stateless** | — | This is the single most relevant fact neither doc mentioned, and it matters a lot for you specifically. The old transport needed an `initialize` handshake and a persistent `Mcp-Session-Id`, which is awkward on serverless (Vercel functions are ephemeral — session affinity means either sticky routing or external session storage). The new stateless Streamable HTTP transport (`sessionIdGenerator: undefined` in the SDK) needs neither — any function instance can answer any request, which is a **direct, structural fit for Vercel** that didn't exist when either source doc's mental model was formed. Build on the stateless transport from day one. |
| (Unstated in either doc) **Elicitation** is a current, real MCP capability | — | Confirmed via the same spec release notes (a production user specifically cited being able to "support more advanced features such as elicitations"). This lets a server ask the connecting client to confirm an action through the client's own UI before proceeding — directly relevant to Tier 3 below (Part III), where I use it for credit-consuming write tools called by external agents. |

**What this means practically:** treat the original MCP roadmap doc's `SDK:` line in its header as stale. Everything else in it — the tool inventory, the service-layer mappings, the security model — holds up completely; only the package names and transport statefulness assumption need updating, and both are reflected throughout this document.

---

<a id="part-i"></a>
## Part I — Foundational Concepts

### The one distinction that matters most

> **MCP is not the agent. MCP is the standardized interface through which an agent — yours, or someone else's — discovers and calls tools, resources, and prompts.**

This is the ChatGPT doc's central point, and it's correct and important enough to lead with. Concretely:

- **The Agent** is a reasoning loop: `while (true) { ask the LLM what to do next; if it wants a tool, run the tool and feed the result back; if it has an answer, return it }`. This exists whether or not MCP is involved at all.
- **Tools** are the things the agent can actually do — `search_books`, `get_book`, `continue_story`, and so on.
- **MCP** is the protocol wrapper that lets tools be discovered and invoked by *any* compliant client — your own chat popup, or Claude Desktop, or Cursor, or ChatGPT's connector system — using one standard shape instead of a bespoke integration per client.

Think of it the way the ChatGPT doc did: MCP is USB for AI tools. Before it, every device (every AI product) needed its own connector to talk to your data. MCP standardizes: *here's a tool, here's its schema, here's how to call it.*

### The three MCP primitives

| Primitive | What it is | Twistloom example |
|---|---|---|
| **Tools** | Actions the model can invoke | `search_books`, `continue_story`, `validate_narrative_consistency` |
| **Resources** | Contextual data the model can read without "calling" anything | `twistloom://book/{id}/state`, `twistloom://story/current/characters` |
| **Prompts** | Reusable instruction templates a client can discover and run | `find_plot_holes`, `plan_next_chapter`, `review_scene` |

Tools *do things*. Resources *provide information*. Prompts are *reusable workflows*. Keeping these three conceptually separate — rather than cramming everything into "tools" — is what makes a large tool surface stay legible to both the model and to you six months from now.

### Why your codebase is already unusually well-suited to this

Both source docs converge on the same underlying reason, from different angles:

- The MCP roadmap doc: your service layer (`src/services/book.ts`, `story.ts`, `user.ts`, `cache.ts`, `custom-actions.ts`, `credits.ts`, `psychological-profile.ts`, `locked-paths.ts`, and the controllers) is *already* well-factored. MCP tools don't need a "extract the business logic out of the route handler" refactor first — they call what's already there.
- The ChatGPT doc: your Hono backend already separates concerns cleanly enough that adding an `agent/` module and an `mcp/` module alongside `routes/` is additive, not a rewrite. The critical rule it states — **tools call domain services, never the database directly** — is the same rule the MCP roadmap doc independently arrived at. Both sources agree on this without having seen each other; that's a strong signal it's correct.
- All the "hard AI work" — the 19-provider LLM waterfall, story generation, psychological profiling, theme validation, custom-action validation — already lives server-side. MCP (and the native agent) just need to expose what exists; neither requires new AI infrastructure to get started.
- SSE/streaming is already a proven pattern in your codebase (`GET /candidates`, `POST /books/stream`, `GET /books/prompt`, `src/utils/sse.ts`) — the tool-call-status streaming UX described in Part IV isn't introducing a new capability, it's reusing one you've already shipped.
- pgvector semantic memory (per your completed `PGVECTOR_SEMANTIC_MEMORY_ROADMAP_V2.md`) gives both the native agent and MCP tools richer context to reason over — this is what makes Tier 4's narrative-intelligence tools (character arcs, consistency checks) tractable without new AI calls.
- The custom-actions system's `preview` → `submit` two-phase pattern is, unprompted, the exact shape every MCP write tool below should follow.

---

<a id="part-ii"></a>
## Part II — Design Rationale: Resolving the Sequencing Tension

This is the most important thing I'm contributing beyond synthesis, so it gets its own section.

### The two source docs actually disagree on sequencing, and neither says so explicitly

- The **MCP roadmap doc** starts building at `src/services/mcp/` — its very first implementation step is standing up an MCP server. There's no native in-app agent in its plan at all; Phase 1 tools exist to be called by *external* MCP clients (Claude, Cursor, etc.) from day one.
- The **ChatGPT doc** explicitly warns against this: *"I would **not** start by making the whole chat system 'an MCP client.' I would build a native Twistloom Agent first, then expose the same capabilities through MCP so external agents can use Twistloom too."* Its four-stage plan puts MCP third, after a native agent (Stage 1) and a formalized tool registry (Stage 2).

These are genuinely different build orders, and picking wrong wastes real work — build the MCP server first and you have nothing to show your own users in the product; build a "quick and dirty" native agent first the way the ChatGPT doc's Stage 1 implies (*"don't touch MCP yet... get the actual UX working"*) and you risk throwing away that first implementation when Stage 2 formalizes the tool registry properly.

### My recommendation: take the ChatGPT doc's sequencing, but skip its "quick and dirty" step

The ChatGPT doc's instinct — ship something users can feel before worrying about external protocol compliance — is right. But there's no real reason to build Stage 1 (native agent, ad-hoc tools) *before* Stage 2 (formal Tool Registry) when the MCP roadmap doc has already done the hard design work of specifying exactly what a well-formed tool registry entry should look like (§3–§5 of that doc: description, arguments, return shape, service mapping, credit cost, risk level — all specified per tool). Building the registry properly *first*, populated immediately with the MCP roadmap doc's Phase 1 tool definitions, costs you nothing extra and means:

1. The native agent chat popup (Part IV) is built *on top of* the same registry from day one — no rewrite later.
2. Exposing those same tools via MCP (Tier 2, Part III) becomes a thin adapter step, not new design work — exactly the "same tools, two frontends" architecture both docs actually want.
3. You never have a period where "the tools the chat popup uses" and "the tools MCP exposes" have quietly drifted apart, which is a realistic failure mode if they're built at different times by different mental models.

This is the single structural decision this document is built around: **Tier 1 is not "native agent" and Tier 2 is not "add MCP" — Tier 1 is "Tool Registry + Service Layer, populated with real tools, consumed by a native chat UI" and Tier 2 is "expose the same registry via `@modelcontextprotocol/hono`."** Everything in Part III follows from this.

### The architecture this produces

```
                              Domain Services
                    (book.ts, story.ts, credits.ts, psychological-profile.ts, ...)
                                     ▲
                                     │
                         ┌───────────┴───────────┐
                         │                       │
                    Tool Registry          (same functions, same
                  (ToolDefinition,          types, called from
                   ToolContext,              every direction below)
                   ToolResult,
                   ToolPermission)
                         │
        ┌────────────────┼────────────────┬─────────────────┐
        ▼                ▼                ▼                 ▼
   REST Routes    Native Agent Chat    MCP Server      Background Workers
  (existing, un-    (Tier 1, Part IV)  (Tier 2, via     (future — e.g. a
   touched)                             @mcp/hono,       nightly consistency
                                        stateless HTTP)   sweep using the
                                              │            same tools)
                                              ▼
                                    Claude Desktop / Cursor /
                                    ChatGPT connectors / OpenCode
```

Note this merges both docs' diagrams (the MCP roadmap doc's "MCP Server calls the same service layer as REST" and the ChatGPT doc's "the exact same tools can be exposed through MCP") into one picture with a genuine fourth consumer (background workers) that neither source called out but which falls out for free once tools stop being tied to any one entry point.

---

<a id="part-iii"></a>
## Part III — The Tiered, Ranked Roadmap

Ranked by impact-to-risk ratio, folding both docs' phase/stage numbering into one sequence. Each tier lists what ships, why it's positioned there, and which source doc(s) it draws from.

### Tier 1 — Tool Registry + Read-Only Native Agent Chat
**Impact: Highest · Risk: Lowest · Source: MCP roadmap Phase 1 (content) + ChatGPT doc Stages 1–2 (architecture), merged per Part II**

Ship the `/agent/chat` popup (Part IV has the full UX), backed by a formal `ToolDefinition` / `ToolContext` / `ToolResult` / `ToolPermission` registry, populated with every read-only tool from the original roadmap's Phase 1 table (full list in Part VI) — `search_books`, `get_book`, `get_page`, `get_psychological_profile`, `get_locked_paths`, `list_branches`, `get_similar_books`, `list_testimonials`, `list_comments`, user-scoped reads, etc.

**Why first:** zero data mutation, zero credit charges, nothing irreversible. Every downstream tier depends on this registry existing. And critically — per Part II — this is *also* the exact tool set Tier 2 needs, so there's no throwaway work.

**Why the native popup ships before MCP exposure:** your own users get value immediately, and you get to observe real tool-call patterns (which tools actually get used, in what sequence, with what failure modes) before you commit to a public, versioned, external-facing MCP contract. Discovering a bad tool schema is cheap to fix when only your own frontend calls it; expensive once Claude Desktop users depend on it.

### Tier 2 — MCP Server Exposure (Read-Only)
**Impact: High · Risk: Low · Source: MCP roadmap §2, ChatGPT doc Stage 3, corrected per Part 0**

Stand up `/mcp` using `@modelcontextprotocol/server` + `@modelcontextprotocol/hono`'s `createMcpHonoApp()`, on the **stateless** Streamable HTTP transport (`sessionIdGenerator: undefined`) — not the old SSE/session model either source doc assumed. Expose exactly the Tier 1 tool registry, unchanged. Add MCP Resources for the same data (`twistloom://book/{id}`, `twistloom://book/{id}/psychological-profile`, etc. — full list in Part VI, from the roadmap doc's §9).

**Why this is nearly free once Tier 1 exists:** the adapter layer is, per the roadmap doc's own principle, "thin routing... never contains business logic." You're writing a translation from `ToolDefinition` to the SDK's `server.tool()` registration call, not new functionality.

**What this unlocks:** external AI agents — Claude Desktop, Cursor, OpenCode, a user's own Claude.ai account via a connector — can discover and read public Twistloom content without you having built a single UI for them. This is also the point where, as the ChatGPT doc puts it, "Twistloom itself could become a provider" starts being literally true.

### Tier 3 — Write Tools, with Elicitation for External Agents
**Impact: High · Risk: Medium · Source: MCP roadmap Phase 2, + my addition (elicitation)**

`create_story`, `continue_story`, `like_book`, `favorite_book`, `purchase_book`, `daily_checkin`, `submit_feedback` — full detail in Part VI. Follows the custom-actions system's proven `preview` → `submit` two-phase pattern: a Tier-1-style read-only preview (cost estimate, likely outcome) precedes any tool that spends credits.

**My addition — this is the one place I'd actively push back on both source docs' silence:** neither document distinguishes between a write tool called from *your own* native chat UI (where the user is looking at a confirmation dialog you built and fully control) and the *same* write tool called from an *external* MCP client they're driving from inside Claude Desktop or Cursor. For the external case, don't rely on your own UI existing at all — use MCP's **elicitation** capability (confirmed real in Part 0) to have the *connecting client* prompt the user for confirmation before `create_story` or `purchase_book` executes. Without this, a sufficiently autonomous external agent looping through a multi-step plan could spend a user's credits without the kind of explicit, in-context confirmation your own product would normally require. This costs you one extra protocol round-trip and closes a real gap.

### Tier 4 — Writer IDE / Narrative Intelligence Tools
**Impact: High · Risk: Low (pure analysis, no new AI calls) · Source: MCP roadmap Phase 3 + ChatGPT doc's "Narrative MCP" (Stage 4) and Resources/Prompts (§14–15), merged**

This is where the two source docs' *content* overlaps most and reinforces each other. The roadmap doc's concrete tools:

- `validate_narrative_consistency` — cross-references `factsHistory`, checks abandoned `threads`, checks `viableEnding` progression, checks unresolved `plotFlags`. No new AI calls — pure analysis over already-structured `storyStates` JSONB.
- `get_story_outline` — traverses pages for a branch, extracts `keyEvents`/`mood`/`sceneType`/`charactersPresent`.
- `get_character_arc` — traces `charactersPresent` appearances + `storyStates.characters[name]` history, paired with the psychological profile for archetype trajectory.
- `analyze_choice_balance`, `summarize_branch`, `get_memory_integrity_report`, `suggest_custom_action_templates`.

The ChatGPT doc's *framing* for this same tier is what elevates it from "an API" to "a product": expose it not just as tools but as **Resources** (`twistloom://story/current/timeline`, `.../characters`, `.../lore`, `.../canon`) a client can simply read, and as **Prompts** — reusable, discoverable workflows like `review_chapter`, `plan_arc`, `find_plot_holes`, `develop_character`, `audit_continuity` — that aren't bespoke agents, just named instruction templates the client surfaces to the user directly ("Run: Find plot holes").

**This tier is also where the Pen editor integration lives** — see Part IV for the full UX, but the short version: everything in this tier is exactly what a "select this paragraph, ask for a canon-preserving rewrite" inline editing flow needs to call.

### Tier 5 — Agentic Workflows (Chaining) + Interactive Tool Output
**Impact: Transformative, contingent on Tiers 1–4 being reliable · Risk: Low (no new primitives, just composition) · Source: MCP roadmap Phase 4 + ChatGPT doc §16 (MCP Apps)**

Once individual tools are trustworthy, they compose. The roadmap doc's four worked examples (preserved in full, since they're genuinely good scoped illustrations):

- **"Generate, Validate, Publish"**: `create_story` → `continue_story` × N → `validate_narrative_consistency` → `publish_story`.
- **"Reader Recommendation + Deep Dive"**: `search_books` (trending, tagged) → `get_psychological_profile` on top results → agent explains fit to the reader based on archetype.
- **"Co-author Session"**: `get_story_outline` → `get_character_arc` (spot an underdeveloped character) → `continue_story` with a targeted `customActionText` → `validate_narrative_consistency` to confirm the fix held.
- **"Analytics Dashboard"**: `get_book_stats` → `get_locked_paths` → agent synthesizes drop-off patterns ("60% of readers abandoned at page 12 after choosing 'flee' over 'investigate'").

**Layered on top, from the ChatGPT doc:** MCP Apps (confirmed real, Part 0) means a tool's *result* doesn't have to be text. "Show me Watson's relationship with everyone" can return an actual interactive relationship graph; "show me all unresolved plot threads" can return an interactive dashboard, rendered inline by any MCP-Apps-compatible client. This is a genuinely different tier of experience from a JSON blob the model has to describe in prose, and it's a natural extension of Tier 4's analysis tools rather than new work.

### Tier 6 — New Use Cases
**Impact: Varies, high-novelty · Source: mine — see Part VII for full detail**

Three ideas neither source document raised, each grounded in something Twistloom already has (see Part VII for the full writeup of each): a reader-facing psychological-safety companion built on the *existing* archetype/locked-paths data, an agentic localization pipeline built on your *existing* translation model tier, and Twistloom appearing as a discoverable connector inside other platforms' own connector directories — not just "an MCP server you can point a client at," but a one-click "Connect Twistloom" experience inside apps your readers already use.

### Tier 7 — External MCP Client (Twistloom Ingesting Outside Data)
**Impact: Medium, orthogonal to Tiers 1–6 · Risk: Low if implemented deterministically · Source: MCP roadmap Phase 5**

This is a completely different direction from everything above: instead of Twistloom exposing tools, Twistloom's *backend* connects to external MCP servers during generation. The roadmap doc's candidates:

| External MCP Server | What it feeds Twistloom | Where it plugs in |
|---|---|---|
| Weather | Real-time weather for a scene's setting | `buildNextPageNarrativePrompt()` |
| Wikipedia | Historical facts, urban legends, real lore | `PROMPT_SYSTEM` / `formatWorldFactForPrompt` |
| Maps/Geography | Street layouts, distances, real place names | Place-memory initialization for a real-city setting |
| News | Current events for a topical thriller | Theme generation |

**The one architectural rule this tier lives or dies by, stated clearly in the roadmap doc and worth preserving verbatim in spirit:** this must be a **deterministic enrichment step in the existing prompt pipeline**, not a tool the writing model decides to call mid-generation. Letting the *creative* model freely call external tools during a horror-thriller page generation is a reliability and content-safety risk with no real upside here — fetch the weather/lore/place data first, inject it into context, then generate. Agentic tool-calling during creative generation is the wrong pattern for this specific use case even though it's the *right* pattern for Tiers 1–5.

---

<a id="part-iv"></a>
## Part IV — UI/UX & End-to-End Implementation

This is the part neither source document fully designed — the roadmap doc has almost no UI detail, and the ChatGPT doc has a good sketch of the chat popup but nothing on the Pen editor. Both get a full treatment here.

### IV.1 — The Agent Chat Popup, end to end

**Entry point.** A persistent "Ask Twistloom" affordance, available anywhere a user has a book/story open (reader view, library, and — with a different tool scope — the writer's dashboard). Opening it doesn't ask the user anything about *which* story — the page already knows:

```
AgentContext {
  userId:      <from session>
  storyId:     <from current route/page>
  chapterId:   <from current route/page, if applicable>
  permissions: <derived server-side from userId + storyId ownership, never from the client>
}
```

This is the ChatGPT doc's best UX insight, worth restating precisely: the difference between *"Analyze Watson's relationship with Alice in story ID abc123"* and *"Why does Watson distrust Alice?"* is the entire difference between a developer API and a real product feature. The popup should never make the user supply an ID it can already infer.

**Conversation states, end to end:**

1. **Idle** — placeholder text scoped to context: *"Ask about [Book Title]..."* for readers, *"Ask Pen about your manuscript..."* for writers (ties to IV.2).
2. **User submits a message.** It's appended to the transcript immediately (optimistic).
3. **Agent loop begins.** Instead of a bare spinner, stream tool-call status as structured events (your SSE infrastructure already does exactly this shape for candidate generation):

   ```
   ✦ Twistloom Agent
   Find all scenes mentioning Watson and summarize how his
   relationship with Alice changes.

   ✓ Searching scenes — 17 found
   ✓ Reading relevant scenes — 8 selected
   ✓ Checking Watson's character history
   ◌ Analyzing relationship changes
   ```

   Critically — and this is worth being explicit about since it's easy to get wrong — **this exposes tool/action status, never private chain-of-thought.** "Searching scenes… 17 found" is a fact about what happened. It is not the model's internal reasoning about *why* it chose to search, which should never be surfaced. This keeps the UI honest and legible without turning into a raw reasoning-trace dump.
4. **Tool call resolves.** Checkmark updates; if the tool failed (auth, not-found, rate limit), show a short, specific failure inline (*"Couldn't load that chapter — try again?"*) rather than aborting the whole turn silently.
5. **Write-tool confirmation (Tier 3 only).** If the agent's plan includes a credit-consuming action, pause and render an explicit confirmation card *before* executing — mirroring what elicitation does for external MCP clients (Part III, Tier 3), but as a native, in-UI equivalent: *"This will generate a new chapter (3 credits). Continue?"* Never auto-spend credits inside an agent loop without this checkpoint, regardless of how confident the plan looks.
6. **Final answer streams in**, same token-by-token rendering your existing `geminiStreamGenerator`-family functions already produce — no new streaming primitive needed, just a new consumer of the pattern.
7. **Follow-up turns** keep `AgentContext` stable (same story/chapter) unless the user navigates elsewhere in the app, which should visibly reset or re-scope the popup so the user always knows what it's currently "looking at."

**Mobile note (not in either source doc):** the tool-status stream above assumes enough vertical space to show 3-5 lines of status. On a narrow viewport, collapse completed steps into a single "✓ Searched, read, and analyzed 8 scenes" summary line and only expand the *current* in-flight step — otherwise the status trace pushes the actual answer below the fold on a phone, which defeats the point of showing it at all.

### IV.2 — "Pen": the in-editor custom-prompt flow

The ChatGPT doc gestures at this ("your earlier vision of 'Pen — an AI-native writer's assistant'") without designing it. Here's the concrete end-to-end flow, built entirely on Tier 4 tools plus the write tools from Tier 3:

1. **Writer selects text** in the manuscript editor (a paragraph, a scene, a line of dialogue).
2. **A contextual prompt bar appears** anchored to the selection — not a modal, so the surrounding manuscript stays visible. Placeholder: *"Tell Pen what to do with this..."*
3. **Writer types a custom instruction** — *"make this scene more tense"*, *"rewrite from Watson's POV"*, *"shorten by half without losing the reveal"* — or picks a suggested **Prompt** from Tier 4 (`review_scene`, `find_plot_holes` scoped to selection) instead of writing free text.
4. **Pen assembles context automatically**, the same way the chat popup does: current `storyId`, current `chapterId`, the selected text itself, and — this is the part that makes it "canon-preserving" rather than a generic rewrite box — a `get_character_arc` / `get_story_outline` call scoped to *only* the characters and threads present in the selection, so the rewrite has the minimum necessary canon context without re-sending the whole manuscript.
5. **Tool-call status streams inline**, same pattern as IV.1 but compact: *"Checking canon for Watson, Alice… Rewriting…"*
6. **Result renders as a diff**, not a silent replacement — struck-through old text, inserted new text, inline — so the writer is reviewing a proposed change, not discovering their manuscript already changed.
7. **Accept / Reject / Refine.** Reject discards cleanly. Refine re-opens the prompt bar with the previous instruction pre-filled for iteration. Accept commits the change and — this is the important closing step — triggers a scoped `validate_narrative_consistency` call restricted to the edited range, so a rewrite that accidentally contradicts established canon gets flagged immediately rather than surfacing as a plot hole three chapters later.

This flow is what turns Tier 4's analysis tools from "things an agent can tell you about" into "things that actively keep your edits honest," and it's the concrete version of the ChatGPT doc's closing pitch — *"Twistloom actually works on the manuscript, rather than merely chatting about it."*

### IV.3 — What NOT to build (from the ChatGPT doc, preserved because it's correct)

Don't expose all ~30-40 tools from Part VI to the model in one flat list and let it "figure it out." That's expensive (every tool schema costs context tokens on every turn) and gets less reliable as the list grows, not more capable. Group into namespaces and expose only what's relevant to the current surface:

```
Story
  ├── search
  ├── characters
  └── scenes

Writing        (Pen editor surfaces this namespace)
  ├── rewrite
  ├── expand
  └── generate

Analysis       (both chat popup and Pen surface this)
  ├── continuity
  ├── pacing
  └── character
```

The reader-facing chat popup, the writer-facing Pen editor, and an external MCP client connecting from Claude Desktop don't need the same tool surface — scope what's registered per context rather than exposing one undifferentiated firehose everywhere.

---

<a id="part-v"></a>
## Part V — Security, Auth & Cost

Both source docs' security thinking is compatible and merges cleanly; this section is the union.

### Auth flow (roadmap doc §8, protocol-level)

```
AI Agent          MCP Server              Twistloom Backend
   │                   │                        │
   │─ OAuth2 Device Code ─►                     │
   │                   │─ Exchange code ────────►│
   │◄── Access Token ──│◄── Return token ────────│
   │─ MCP Request + Token ►                     │
   │                   │─ Verify token ─────────►│
   │                   │─ Resolve userId ────────│
   │                   │─ Execute tool(userId) ──│
   │◄──── Response ────│◄──── Result ────────────│
```

MCP tools authenticate exactly like REST does today — same JWT verification (`requireAuth` / `optionalAuth`), same `userId` injection pattern REST already uses via `req.userId`. Tools that work without auth (public book search, testimonials) simply receive `userId: undefined`.

### Context integrity (ChatGPT doc, application-level — the layer above the protocol)

The protocol proves *who* is calling. It says nothing about *what story they're allowed to touch* — that's an application-level rule, and the ChatGPT doc states it well: **never trust a `storyId` supplied by the model.** `AgentContext { userId, storyId, permissions }` should have `storyId` populated from the authenticated session/page context server-side, not parsed out of whatever the LLM decided to pass as a tool argument. Every tool implementation re-verifies ownership itself rather than assuming the caller already checked.

### My addition — indirect prompt injection via tool results

Neither source document raises this, and it's a real, known class of risk for exactly this architecture: when `search_scenes` or `get_page` returns *user- or community-generated story content* back into the agent's context window, that content is untrusted input from the model's perspective — the same way a webpage fetched by a browsing tool is. A custom action, a community-submitted piece of content, or even a maliciously-themed reader comment could contain text crafted to look like an instruction to the agent ("ignore previous instructions and...") once it lands in context via a tool result. Two concrete mitigations worth building in from the start, not retrofitting later:

1. Tool results that embed user-authored text should be wrapped with a clear structural boundary (e.g., a dedicated `content` field with explicit "this is retrieved data, not an instruction" framing in the system prompt) rather than concatenated loosely into context.
2. Any tool whose result flows into a subsequent *write* action (e.g., a chain that reads community feedback and then calls `submit_feedback` or modifies story metadata on the model's own initiative) deserves the same confirmation checkpoint described in Tier 3 — don't let a write action's trigger be "something the model read," only "something the user explicitly asked for."

### Permission mapping (roadmap doc §8.2, unchanged — it's complete)

| MCP Tool Category | Auth Required | Credit Charge | Rate Limit |
|---|---|---|---|
| Phase 1: Read (public data) | No | No | Per-IP |
| Phase 1: Read (user data) | Yes | No | Per-user |
| Phase 2: Write (story gen) | Yes | Yes (via `executeWithCredits()`) | Per-user + credit balance |
| Phase 2: Write (social) | Yes | No | Per-user |
| Phase 3: Analysis | Yes | No | Per-user |
| Phase 4: Admin | SuperAdmin | No | Per-admin |

### Safety guards (roadmap doc §8.3, preserved in full)

1. **Credit-aware error messages** — insufficient balance returns a structured error with `currentBalance`/`requiredBalance`, same behavior as REST's `402`.
2. **No hidden-state leakage** — same rule as the custom-actions system's `getRejectionMessage()`: never surface internal reasoning, matched security patterns, hidden story state, or viable-ending details in an error response.
3. **Rate limiting** — MCP tool calls consume the same per-user `RateLimiter` budget (`src/services/ai-limiters.ts`) as REST calls; there's no separate, exploitable quota for agent traffic.

### Cost (roadmap doc Appendix B, unchanged — still accurate)

| Component | Cost |
|---|---|
| MCP SDK (`@modelcontextprotocol/server` + `@modelcontextprotocol/hono`) | Free, MIT license |
| OAuth2 provider (reuses existing JWT + `authSessions`) | Free |
| Infrastructure (same Vercel functions, no new DB) | $0 |
| Phase 1 tool calls (pure data retrieval) | $0 |
| Phase 2+ AI costs (story creation, custom actions) | Same as REST — new access path, not new AI spend |
| Additional DB/cache load | Negligible — same Redis cache, same read replicas |

**Bottom line, unchanged from the source doc:** near-zero marginal infrastructure cost. The spend here is engineering time, not new recurring cost.

---

<a id="part-vi"></a>
## Part VI — Full Tool / Resource / Prompt Inventory

Preserved in full from the roadmap doc (§10), reorganized by tier per Part III, with the ChatGPT doc's namespace grouping (Part IV.3) layered on as the `namespace` column.

### Tier 1/2 — Read-only

```
Namespace: Story
search_books(query?, language?, tags?, sortBy?, limit?, page?) → { books: EnrichedBookData[], pagination }
get_book(bookId)                        → { book: EnrichedBookData }
get_similar_books(bookId)               → { similarBooks: EnrichedBookData[] }
get_page(bookId, pageId)                → { page: StoryPage, book, selectedAction }
list_branches(bookId)                   → Branch[]
get_book_generation_status(bookId)      → BookGenerationStatus
list_active_generations()               → BookGenerationStatus[]
get_psychological_profile(bookId)       → { archetype, stability, dominantTraits, ending, missedTeasers }
get_locked_paths(bookId)                → { lockedPaths: Array<{ kind, label, restriction, page, context }> }

Namespace: Social / User
get_user_profile(userId?)               → { user: User }
get_user_progress()                     → StoryProgress
get_credit_balance()                    → { credits: number }
checkin_status()                        → CheckInStatus
list_testimonials(bookId)               → { testimonials: Testimonial[] }
list_comments(bookId)                   → { comments: Comment[] }
list_achievements()                     → { badges: Achievement[] }

Namespace: Content
list_blog_posts(limit)                  → BlogPost[]
list_social_mentions()                  → SocialMention[]
```

### Tier 3 — Write

```
Namespace: Writing / Story
create_story(theme, mcName?, mcAge?, mcGender?, mcBio?, mode?, generateCoverImage?, async?)
                                         → { bookId, title, firstPage, generationStatus }
  Credit cost: 2 (novel) / 5 (interactive) / 10 (multiverse) — src/config/credits.ts:getBookModeCreditCost()

continue_story(bookId, pageId, actionIndex? | customActionText?)
                                         → { nextPageId, text, actions, mood, state }
  Credit cost: 3 standard / 6 after an existing choice on this page

Namespace: Social
like_book(bookId) / unlike_book(bookId) → { liked: boolean, likesCount }
favorite_book(bookId) / unfavorite_book(bookId) → { favorited: boolean }
purchase_book(bookId)                   → PurchaseResult
daily_checkin()                         → CheckInResult
submit_feedback(category, message)      → { feedback: Feedback }
```

### Tier 4 — Writer IDE / Narrative Intelligence

```
Namespace: Analysis
validate_narrative_consistency(bookId, pageRange?) → { issues, threadStatuses, factConsistency }
get_story_outline(bookId, branchId?)    → { pages, threads, characterArcs }
get_character_arc(bookId, characterName) → { appearances, traits, relationshipChanges }
analyze_choice_balance(bookId)          → ChoiceBalance
summarize_branch(bookId, branchId)      → BranchSummary
get_memory_integrity_report(bookId)     → MemoryIntegrityReport
suggest_custom_action_templates(bookId) → existing template reuse
```

### Tier 5 — Agentic enablers

```
publish_story(bookId, visibility)       → { book }
update_book_metadata(bookId, fields)    → { book }
get_book_stats(bookId)                  → BookStats
```

### Resources (Tier 2/4)

```
twistloom://user/{userId}/profile               → GET /api/user
twistloom://book/{bookId}                        → GET /api/books/:identifier
twistloom://book/{bookId}/state                  → current page + state + session
twistloom://book/{bookId}/psychological-profile  → GET /api/books/:identifier/psychological-profile
twistloom://book/{bookId}/locked-paths           → GET /api/books/:identifier/locked-paths
twistloom://user/{userId}/achievements           → GET /api/user/achievements
twistloom://user/{userId}/checkin                → GET /api/user/checkin/status
twistloom://book/{bookId}/testimonials           → GET /api/books/:identifier/testimonials
twistloom://story/current                        → the ChatGPT doc's context-scoped equivalent, resolved from AgentContext rather than a literal ID
twistloom://story/current/timeline
twistloom://story/current/characters
twistloom://story/current/lore
twistloom://story/current/canon
```

### Prompts (Tier 4, discoverable reusable workflows — not bespoke agents)

```
review_chapter
plan_arc
find_plot_holes
develop_character
audit_continuity
```

### Naming convention (roadmap doc Appendix C, unchanged)

`snake_case` throughout, matching LLM token-efficiency conventions (`search_books`, not `searchBooks` or `SearchBooks`). Descriptions stay 5-15 words, precise, no marketing language:

```
❌ "Discover amazing psychological thrillers..."
✅ "Search published books by query, language, tags, or sort option"
```

---

<a id="part-vii"></a>
## Part VII — New Use Cases (Mine)

Three ideas neither source document raised, each deliberately grounded in something Twistloom already has rather than a speculative new capability.

### 1. The reader-facing psychological-safety companion

Both source docs treat the psychological-profile feature as a *writer/analysis* tool (Tier 4) or, at most, a *discovery* signal ("if you liked this archetype, try..." — the roadmap doc's own Workflow B). Neither imagines it serving the reader **while they're mid-story, before they make a choice** — which is where it's arguably most valuable for a platform explicitly built around psychological horror.

Concretely: a reader facing a branching choice could ask the chat popup, *"Is this the kind of choice that gets intense?"* or set a standing preference once ("warn me before body-horror content") and have the agent consult `get_locked_paths` and the current page's structured state *before* the reader commits to a branch — not to spoil the outcome, but to flag *category* of intensity (the same way a content warning works, but personalized and interactive rather than a static tag on the book). This reuses `get_psychological_profile` and `get_locked_paths` exactly as built; the only new piece is a lightweight reader-preference record and a tool that cross-references it against upcoming branch metadata without revealing plot specifics — a genuinely new axis (protective, not analytical) on data you're already computing for a completely different purpose.

### 2. Agentic chapter-by-chapter localization

You already have a translation tier in your provider waterfall (`AI_CHAT_MODELS_TRANSLATION`, spanning multiple providers including direct GLM and Qwen access). Neither source doc connects this to the agent/MCP work at all. An agentic localization workflow is a natural Tier 5 composition: `get_story_outline` (to extract character names, recurring terms, and world-specific vocabulary as a glossary) → chapter-by-chapter translation calls routed through your existing translation-tier providers → a consistency pass that re-checks the *translated* output against the extracted glossary (catching the classic failure mode where a character's name or a world-specific term gets translated inconsistently across chapters). This turns "translate this book" from a single giant prompt (which is exactly where long-context translation quality degrades) into a supervised, glossary-anchored agentic pipeline — a direct, concrete payoff from having built the agent/tool infrastructure at all, on a capability you already own.

### 3. Twistloom as a connector, not just a server

Both source docs frame the end state as "external agents connect to Twistloom's MCP server" — technically correct, but undersells the distribution mechanism. I can speak to this with some direct, firsthand grounding: platforms like Claude.ai increasingly support a **connector directory** pattern, where a well-built third-party MCP server can be surfaced to end users as a one-click "Connect" option inside the platform itself, rather than requiring the user to know a URL or run any setup. If Twistloom ships a well-scoped, well-described MCP server (Tier 2 onward), it's a realistic, not speculative, next step for it to eventually appear the same way — meaning a reader could connect "Twistloom" from *inside their own Claude app* with one tap, and start asking about their library without ever opening Twistloom's own UI. This reframes Tier 2 from "a developer feature" to a genuine distribution channel, and it's a good reason to invest in tool *descriptions* being precise and non-marketing (Part VI's naming convention) from the very first tool you ship — that's exactly the surface a connector directory would show a prospective user before they connect.

---

<a id="part-viii"></a>
## Part VIII — My Recommendations, Collected

For quick reference, everything in this document that goes beyond consolidating the two source docs:

1. **Build the Tool Registry first, before any "quick" native agent** — skip the ChatGPT doc's implied throwaway Stage 1, since the roadmap doc already did the design work needed to build it right the first time (Part II).
2. **Target the v2 SDK packages** (`@modelcontextprotocol/server` + `@modelcontextprotocol/hono`) on the **stateless** Streamable HTTP transport, not the v1 `@modelcontextprotocol/sdk` + session-based model either source doc assumed — a direct, structural fit for Vercel's ephemeral functions (Part 0).
3. **Use MCP elicitation for credit-consuming tools called by external agents**, as a protocol-level equivalent of the in-UI confirmation your native chat popup already needs (Part III, Tier 3; Part IV.1).
4. **Treat tool results containing user/community content as untrusted input** — structurally separate retrieved data from instructions in context, and never let a write action trigger purely off something a tool *read*, only off something the user explicitly asked for (Part V).
5. **Scope the tool surface per UI context** (reader popup vs. Pen editor vs. external MCP client) rather than registering everything everywhere — extends the ChatGPT doc's "don't expose 50 tools" warning into a concrete per-surface namespace rule (Part IV.3).
6. **Design the Pen editor's rewrite flow as a diff-and-confirm, not a silent replace**, with an automatic scoped consistency check on accept — the concrete version of "Twistloom works on the manuscript" that neither source doc actually designed (Part IV.2).
7. **Three new use cases** genuinely outside both source docs: the reader-facing psychological-safety companion, agentic glossary-anchored localization, and pursuing connector-directory distribution rather than treating "MCP server" as the end state (Part VII).

---

<a id="appendix"></a>
## Appendix — Implementation Sequence & Naming

Adapted from the roadmap doc's Appendix A, resequenced per Part II/III (Tool Registry first, native UI on top of it, MCP as a thin adapter after):

```
Week 1: Tool Registry + bootstrap
  - Define ToolDefinition / ToolContext / ToolResult / ToolPermission
  - Populate registry with Tier 1 read-only tools, calling existing services directly
  - No UI yet — verify each tool against the existing REST service layer in isolation

Week 2: Native Agent Chat (Tier 1 UI)
  - Build /agent/chat popup (Part IV.1): context injection, tool-status streaming, message states
  - Wire the agent loop (LLM → tool call → result → continue) against the Week 1 registry
  - Ship to your own users — real usage data before any external protocol commitment

Week 3: MCP Server Exposure (Tier 2)
  - npm install @modelcontextprotocol/server @modelcontextprotocol/hono
  - Stand up /mcp on the stateless Streamable HTTP transport
  - Register the same Tier 1 tools + Resources (Part VI) — thin adapter only
  - Test against Claude Desktop / MCP Inspector

Week 4: Write Tools + Elicitation (Tier 3)
  - create_story, continue_story, social actions — credit-aware, preview/submit pattern
  - Elicitation flow for external-agent-triggered credit spend
  - In-UI confirmation card for the native popup equivalent

Week 5: Writer IDE Tools + Pen (Tier 4)
  - validate_narrative_consistency, get_story_outline, get_character_arc, etc.
  - Pen editor selection → prompt bar → diff → accept/reject flow (Part IV.2)
  - Prompts (review_chapter, find_plot_holes, etc.) as discoverable templates

Week 6+: Agentic Workflows, New Use Cases, External Client (Tiers 5-7)
  - Workflow composition, MCP Apps interactive outputs
  - Reader-safety companion, localization pipeline (Part VII)
  - Weather/Wikipedia/Maps/News as deterministic prompt-pipeline enrichment (Tier 7)
```

**Naming convention** (unchanged from the roadmap doc): `snake_case` tool names, 5-15 word descriptions, no marketing language — see Part VI.
