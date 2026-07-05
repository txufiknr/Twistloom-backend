# Twistloom BGM — Backend Considerations

## Current Architecture (no backend changes required)

The BGM system is **fully frontend-implemented**. The engine derives everything it needs from existing API response fields:

### Data used by the BGM engine

| Field | API source | Usage in frontend |
|---|---|---|
| `page.context.places[]` | `/api/books/:id/:pageId` | Look up raw `place.type` string by matching `placeId` |
| `page.placeId` | Same | Key to find the current place in the `places` array |
| `page.mood` | Same | Derive `TensionGroup` (neutral → distorted) |
| `page.weather` | Same | Select ambience overlay track |

**No new fields were added to the API.** The `normalizePlaceType()` function in
`src/lib/audio/bgm-selector.ts` maps free-form AI strings (e.g. `"abandoned hospital"`,
`"old church"`, `"dimly lit corridor"`) to one of 12 `CanonicalPlaceType` values
via a priority-ordered keyword map with 100+ entries.

## Frontend type contract

### `Place.type` is `string` (free-form)

```ts
// src/lib/types/books.ts
export interface Place {
  name: string;
  type: string;  // ← free-form AI string, NOT CanonicalPlaceType
  context: string;
  ...
}
```

The backend sends whatever the AI generates for `place.type`. The frontend normalizes
it at the point of use via `normalizePlaceType()`. This is intentional — same pattern
as `Mood = string` and `ActionType = string` elsewhere in the codebase.

### `page.context.places` structure

The BGM engine reads from `page.context.places`:

```ts
// Expected shape (from backend API response):
[
  {
    placeId: string;       // matches page.placeId
    name: string;          // display name
    type: string;          // free-form AI string
    context: string;       // place description
  },
  ...
]
```

This array already exists in the API response. No changes needed.

## Optional backend optimizations (future)

None of these are required — the BGM system works correctly as-is. They are purely
optimizations for better audio quality.

### 1. Constrain `place.type` generation to canonical values

**Goal:** Reduce normalization errors so the engine selects the correct track more often.

**Where:** AI prompt / system prompt in the generation service.

**What:** Instruct the AI to classify `place.type` into one of the 12 canonical values
instead of generating free-form strings:

```
"abandoned hospital" → preferred: "abandoned_building"
"old church"         → preferred: "sacred_space"
"dimly lit corridor" → preferred: "institutional_indoor"
"beach resort"       → preferred: "coastal_water"
```

The full list with descriptions is in `PLACE_TYPES` at `src/lib/audio/bgm-types.ts`:

| Canonical value | Description |
|---|---|
| `underground` | basement, cellar, bunker, cave, tunnel, sewer, vault, mine |
| `sacred_space` | church, chapel, temple, cemetery, graveyard, shrine, crypt, tomb |
| `institutional_indoor` | hospital, school, office, clinic, police, prison, asylum, lab, factory, warehouse |
| `domestic_indoor` | home, house, apartment, bedroom, kitchen, living room, attic |
| `commercial_indoor` | shop, mall, bar, restaurant, market, café, hotel, lobby |
| `abandoned_building` | abandoned, derelict, ruined, decayed, decrepit, vacant |
| `transit_vehicle` | car, train, subway, bus, elevator, vehicle |
| `urban_outdoor` | street, alley, rooftop, plaza, parking, sidewalk, intersection |
| `rural_outdoor` | countryside, field, farm, village, meadow, hill, mountain, cliff |
| `coastal_water` | beach, dock, pier, boat, ship, river, lake, ocean, harbor |
| `forest_wilderness` | forest, woods, jungle, wilderness, swamp, marsh, bog, grove |
| `unknown` | Fallback for anything unmatched |

**If this change is made,** `Place.type` in the frontend could be updated to
`CanonicalPlaceType` (strict union), and `normalizePlaceType()` would become a
passthrough that only guards against `undefined`.

**Likelihood:** Medium effort (prompt change), high impact (better track matching).
Suggested if you observe frequent `unknown` type matches in testing.

### 2. Include `context.places` on the terminal page API response

**Goal:** Ensure the ending/debrief page has place type data for BGM.

**Background:** `page.context` may be partial on the terminal page depending on the
`mapToEnrichedPage` implementation. The BGM engine needs at least one entry in
`page.context.places` to identify the current place type. If the array is empty on
the terminal page, the engine falls back to `'unknown'` (void drone track).

**Check:** Verify the backend includes `context.places` for the terminal page
response. If absent, propagate `StoryState.places` through `mapToEnrichedPage`
the same way it's done for non-terminal pages.

**Likelihood:** Low — this is probably already working. Check once during QA.

### 3. (No) Do NOT add a dedicated `soundtrackHint` field

The v1 and v2 roadmaps both considered and rejected a dedicated `soundtrackHint`
AI-generated field. The existing page fields (`place.type`, `mood`, `weather`) are
sufficient. Adding a redundant field wastes AI tokens and creates a maintenance
burden (both prompt versioning and frontend/backend schema updates).

## Testing checklist

| Behavior | What to verify | How |
|---|---|---|
| Place resolution | `normalizePlaceType()` maps real AI strings correctly | Check bgm-store.currentPlaceType in dev console on page navigation |
| Mood tension | Mood changes trigger correct filter/variant transitions | Log `getMoodTensionGroup()` output |
| Ambience matching | Weather selects the right ambience overlay | Check `AmbiencePlayer.currentSrc` |
| Terminal page | BGM doesn't crash when `context.places` is empty | Navigate to last page in a book |
| No regression | Existing typing audio, TTS, and page navigation still work | Full smoke test |

## Summary

| Concern | Backend change needed? |
|---|---|
| `Place.type` as free-form string | No — frontend normalizes |
| `page.context.places` array | No — already exists |
| `page.mood`, `page.weather`, `page.placeId` | No — already exist |
| Constrain AI to canonical types | Optional (recommended for accuracy) |
| `soundtrackHint` field | No (explicitly rejected design) |
| New API endpoint | No |
