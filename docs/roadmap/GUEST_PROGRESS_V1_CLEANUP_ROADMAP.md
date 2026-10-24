# Guest Progress V1 Contract & Cross-Client Cleanup Roadmap

> **Status:** Implementation in working trees — backend and client V1 wiring is in place; final static verification and release checks remain.
> **Date:** 2026-10-23
> **Owner:** Backend, Web, and Flutter maintainers.
> **Scope:** Replace guest reading progress migration compatibility layers with one canonical V1 import contract across backend, web, and Flutter. Backend deployment is paused per owner; verify release and database history before deleting any client-persistent compatibility readers.

---

## 1. Summary Table

| # | Item | Priority | Status |
|---|------|----------|--------|
| 1 | Confirm deployment/release boundary and freeze the V1 contract | `P0` | ✅ Done per owner; backend deployment is paused |
| 2 | Replace backend legacy/V2/V4 paths with one strict V1 endpoint | `P0` | ✅ Implemented in working tree |
| 3 | Keep only bounded V1 idempotency/CAS state and align capability DTO | `P0` | ✅ Implemented in working tree |
| 4 | Remove Flutter legacy migration APIs/models and wire one V1 importer | `P1` | ✅ Implemented in working tree; static verification pending |
| 5 | Replace web’s unversioned automatic migration with the owned V1 importer | `P1` | ◐ V1 intent implemented; legacy local-store ownership remains a documented gap |
| 6 | Add cross-project contract, persistence, and failure-boundary verification | `P1` | ◐ Fixtures aligned; static verification pending; DB checks skipped by request |
| 7 | Synchronize architecture/roadmap docs and remove stale operational claims | `P2` | ✅ Updated |

---

## 2. Problem Statement

### Current State

- The backend has two import endpoints, `POST /books/:identifier/migrate-guest-progress` and `PUT /books/:identifier/adopt-guest-progress`, in `src/routes/books.ts:7611-7697`. Both route handlers dispatch either to a versioned parser or to the legacy adapter based on whether the body contains `version`.
- `src/utils/guest-progress.ts:4-143` accepts a legacy unversioned shape through `parseLegacyGuestProgressImport`, a V2 CAS shape, and a V4 operation-ID shape. The V2/V4 distinction remains in precondition, fingerprint, and acknowledgement logic. The prior V3 receipt protocol is rejected but still documented in comments/tests.
- `src/services/guest-progress.ts:36-177` maintains separate legacy and versioned service paths. They share some helpers, but legacy session policy, V2 compatibility, V4 replay logic, and marker invalidation still increase the number of correctness branches.
- The backend persists the latest import UUID and fingerprint in `user_sessions.last_guest_import_id` and `last_guest_import_hash` (`src/db/schema.ts:1337-1338`, `drizzle/0108_tricky_malice.sql:2-3`). These are bounded idempotency/CAS metadata, not reading-list records or a result-history table; they remain useful in V1.
- The backend session DTO emits `lastGuestImportId` (`src/services/book-controller.ts:159-182`, `:693-752`) but does not currently emit `guestProgressVersion` or an equivalent capability field.
- Web still uses the unversioned payload: `Twistloom-web/src/lib/utils/guest-migration.ts:37-91` gathers mutable sessionStorage/IndexedDB values, and `Twistloom-web/src/lib/services/books-api.ts:1028-1044` posts them to the old route. `AuthProvider` starts this migration after any authenticated login/restore (`Twistloom-web/src/components/providers/AuthProvider.tsx:173-211`). It removes local sources after an HTTP response without requiring a typed V1 acknowledgement proving the session was applied.
- Flutter has the more complete V4 importer in `Twistloom-flutter/lib/shared/journeys/guest_progress_importer.dart:17-400`, with durable operation intent, confirmed-path projection, conflict checks, and guarded activation. It chooses between the two backend endpoints in `Twistloom-flutter/lib/shared/books/books_remote_source.dart:34-47`.
- Flutter also retains legacy DTOs `GuestMigrationPayload` / `GuestMigrationResult` and legacy `migrateGuestProgress` transport wrappers in `Twistloom-flutter/lib/shared/journeys/guest_migration_models.dart:167-257`, `books_repository.dart:410-415`, and `books_remote_source.dart:1229-1260`. The old wire method is not the V4 importer path, but its API/model code and tests remain.
- Flutter’s signup lifecycle still calls `JourneyRepository.migrateGuestSessions` (`Twistloom-flutter/lib/features/auth/auth_controller.dart:518-524`; implementation at `journey_repository.dart:548-600`). It internally delegates to the new importer, but the old migration naming and legacy result type obscure the actual adopt semantics.
- Flutter gates import on `Book.guestProgressVersion >= GuestProgressImport.version` (`Twistloom-flutter/lib/shared/books/book.dart:568-656`, importer `:161` and `:339`), while the backend currently emits no such field. The model defaults it to `0`, so this producer can classify a working V1/V4 backend as unsupported unless another response layer supplies an undocumented value.
- The web already has a separate proposed safety/parity roadmap at `Twistloom-web/docs/roadmap/GUEST_PROGRESS_SAFETY_AND_FLUTTER_PARITY_ROADMAP.md`. It targets V4 and still describes retaining legacy backend compatibility. It must be reconciled with this V1 plan to avoid two competing target contracts.

### Pain Points

1. **There is no single wire contract.** Backend branches among unversioned, V2, and V4 shapes, while web and Flutter call different routes and use different acknowledgement types.
2. **The current clients are not symmetrically safe.** Flutter has durable, immutable replay; web automatically imports on any login/restore from shared mutable local sources and may clear progress after a refusal-shaped success response.
3. **The capability handshake is incomplete.** Flutter checks a field the backend does not currently publish, so supported-version gating is not end-to-end reliable.
4. **Compatibility paths create unnecessary risk before first release.** Supporting unversioned migration and V2 alongside V4 expands validation, CAS, test, and documentation surface without a deployed backend consumer, according to the owner’s deployment status.
5. **Legacy names and wrappers hide which code is canonical.** Flutter’s signup flow is already invoking adoption semantics but remains named as migration; unused old API wrappers and DTOs appear available for future accidental use.
6. **A wire-protocol cleanup must not become a local-data cleanup.** Browser and device guest histories are user data. Retiring network compatibility must not silently delete, reassign, or overwrite a local source or an uncertain pending command.

### Goal

Ship one strict, explicitly acknowledged Guest Progress Import V1 contract consumed by the backend, web, and Flutter, with no unversioned/V2/V4 endpoint or DTO branches and with durable source-preserving client behavior.

---

## 3. Intended Design & Rationale

### Design Alternatives

#### Alternative A: Keep separate migrate/adopt routes, only remove old body parsers

This removes unversioned/V2 parsing but preserves route, method, and boolean policy duplication (`POST` migration versus `PUT` replacement).

**Pros:** Smaller immediate code diff; maps to existing client labels.
**Cons:** Two API surfaces still need parity, lock/access checks can drift, and the endpoint verb implies different write semantics even though both should use the same compare-and-set rule.

#### Alternative B: One canonical import command with an explicit session precondition — Recommended

Use a single authenticated `POST /api/books/:identifier/guest-progress/import` endpoint. Every request has one `importVersion: 1`, a UUID operation ID, bounded canonical page/action references, session cursor/frontier references, and an explicit expected-session precondition. The request always uses the same transactional compare-and-set semantics:

```json
{
  "importVersion": 1,
  "operationId": "<uuid-v7>",
  "pageIds": ["<canonical-page-uuid>"],
  "actions": [
    { "actionedPageId": "<page-uuid>", "nextPageId": "<child-page-uuid>", "actionId": "<canonical-action-id>" }
  ],
  "session": { "pageId": "<current-page-uuid>", "frontierPageId": "<confirmed-frontier-uuid>" },
  "expectedSession": null
}
```

`expectedSession: null` means “apply only if this account has no session for this book.” A non-null expected snapshot means “apply only if the exact account session the user reviewed is still current.” For a pre-existing account session, the client must obtain explicit user consent before sending that snapshot. A pristine first-signup auto-adoption is permitted only when the exact precondition is absent. Both cases call the same endpoint, transaction, canonical validator, and response decoder.

The response has `importVersion: 1`, the same `operationId`, `sessionApplied`, `alreadyApplied`, `actionsImported`, and canonical server session fields. A `409` represents stale session/operation conflict; invalid, incomplete, cross-book, or non-canonical graphs receive a stable validation response. Clients clear no source until they validate this acknowledgement and finish guarded local activation.

**Pros:** One parser, endpoint, DTO, policy, test matrix, and client call path; preserves compare-and-set and safe retry semantics; semantically distinguishes an import command from the older “migration” transport.
**Cons:** Requires coordinated backend/web/Flutter release and careful reconciliation of existing client-persistent intent records.

### Recommended Contract & Rationale

- **Version label:** Use `importVersion: 1` on request and acknowledgement. The first deployed protocol is V1 even though the working implementation evolved through V2/V4 designs. Do not accept `version: 2`, `version: 4`, or a missing discriminator as aliases.
- **One route:** `POST /books/:identifier/guest-progress/import`; remove `/migrate-guest-progress` and `/adopt-guest-progress` handlers instead of keeping forwarding shims.
- **One conditional policy:** Remove `replace`/`allowReplacement` transport booleans. `expectedSession` is the sole server CAS authority; consent is enforced by client flow before creating an expected snapshot.
- **One canonical graph boundary:** Keep the current DB-scoped page lookup, selected-edge validation, action reconstruction, and server-derived ancestry. The server never trusts client text/type/hint/page number/frontier ancestry as authoritative data.
- **Bounded idempotency:** Keep `last_guest_import_id` and `last_guest_import_hash` on the existing `(user_id, book_id)` session owner row. Hash the normalized V1 request and replay the latest operation only when ID and fingerprint match. Do not add V2/V3 adapters, operation history, or an unbounded receipt table.
- **Explicit capability:** Publish `guestProgressImportVersion: 1` in the authenticated book detail/session response and type it in both clients. This closes Flutter’s existing unsupported-by-default gap and lets the import UI fail clearly if a stale backend is reached. There is only one supported contract version; no “>=4” compatibility negotiation remains.
- **Shared client policy:** Both clients preserve the guest source, use an immutable operation payload for uncertain outcomes, require canonical acknowledgement, and apply account-scoped progress only after server success. Auto-adoption is limited to a verified pristine signup with `expectedSession: null`; existing-account sign-in/restore presents a non-mutating offer and sends a non-null precondition only after confirmation.
- **Local compatibility boundary:** Remove obsolete network readers and DTOs. Keep additive local-store readers only where needed to preserve user-created guest data from a shipped build. Quarantine ownerless/ambiguous data; never infer that it belongs to the current account.

### Non-Breaking Guarantees

| Change | What it does NOT change | Why safe |
|--------|-------------------------|----------|
| Replace old import routes with one V1 route | Normal book reading/session endpoints or canonical `user_page_progress` / `user_sessions` ownership | Only import transport changes; ordinary reading remains the source of account progress |
| Remove V2/V4 wire compatibility | Guest journeys already stored locally | Client source remains until V1 confirmation and guarded activation |
| Rename migration/adoption code to import/adoption | Guest onboarding and explicit comparison UX | Rename the transport/domain boundary without reducing consent or recovery guarantees |
| Remove unused legacy DTO methods | Unrelated `BooksRepository` APIs | Remove only guest migration symbols proven unused outside their tests |
| Add the V1 capability field | Existing book/session fields | Additive typed response property; existing clients ignore it |

---

## 4. Feasibility Analysis

| Dimension | Assessment |
|-----------|------------|
| **Effort** | High — approximately 4–7 engineering days across backend, web, and Flutter, plus integration review; estimate assumes existing local-storage layers remain usable |
| **Risk** | Medium — the network protocol can be simplified, but guest progress is user data and web currently has weaker ownership/recovery guarantees than Flutter |
| **Backend changes** | Significant — one endpoint/parser/service, capability DTO, typed acknowledgement/error contract, and one pending migration/schema review |
| **Dependencies** | Confirm backend/migration deployment state; verify web and Flutter release distribution and pending local intent/data exposure; agree final request/ack JSON fixture |
| **Reversibility** | Partially — route/code rollback is easy before deployment; after clients persist V1 intents, removing them requires preserving or reconciling those local records |

---

## 5. Flow Diagram (Mermaid)

```mermaid
sequenceDiagram
    participant Client as Web or Flutter client
    participant Local as Owned local guest history and durable intent
    participant API as Authenticated backend V1 endpoint
    participant DB as PostgreSQL
    Client->>Local: Project bounded canonical journey and snapshot revision
    Client->>API: Read book capability and account session snapshot
    alt No account session
        Client->>Local: Persist immutable V1 command with expectedSession null
    else Existing account session
        Client->>Client: Show comparison and collect explicit replacement consent
        Client->>Local: Persist immutable V1 command with reviewed session precondition
    end
    Local->>API: POST one V1 import command
    API->>DB: Enforce book access, lock session, validate canonical graph, compare precondition
    alt Operation already applied with matching fingerprint
        DB-->>API: Return canonical applied acknowledgement
    else Precondition matches
        API->>DB: Atomically write session, actions, and latest operation marker
        DB-->>API: Commit canonical acknowledgement
    else Stale or invalid request
        DB-->>API: Conflict or validation error; no partial write
    end
    API-->>Local: Typed V1 acknowledgement or actionable failure
    Local->>Local: Verify account, operation, source revision, then activate account copy
    Client->>Local: Retain guest source; allow cleanup only by explicit retention policy
```

---

## 6. Implementation Plan

### Step 1: Confirm release and database boundaries; freeze V1 — ⬜ Planned

**Files:** `docs/architecture/GUEST_PROGRESS_IMPORT_ARCHITECTURE.md`, `../Twistloom-web/docs/roadmap/GUEST_PROGRESS_SAFETY_AND_FLUTTER_PARITY_ROADMAP.md`, Flutter release/build records, deployment and Drizzle migration history.
**Effort:** Low.

Record whether any web/Flutter build containing current guest logic has shipped, whether any build can have a persisted V2/V3/V4 operation, and whether migrations 0108/0109 have been applied to any shared environment. Accept the request/ack JSON, error status/body, capability property, and policy in this roadmap as a cross-project contract fixture. The owner reports backend deployment is paused; treat that as the working assumption, not proof that app-local state or staging databases do not exist.

If no client build shipped, remove protocol compatibility directly. If a client did ship, retain only the local data reader/recovery needed for its persisted guest history or pending operation; do not retain old server endpoints absent a deployed backend caller.

**Non-breaking:** No source or user data is deleted during this inventory.

---

### Step 2: Define strict V1 request, response, errors, and access boundary — ⬜ Planned

**Files:** `src/utils/guest-progress.ts:4-143`, `src/services/guest-progress.ts:14-177`, `src/routes/books.ts:145-146,7611-7697`, `src/services/book-page-access.ts:125`, `src/services/book-controller.ts:159-182,693-752`, `src/types/book.ts:389-394`.
**Effort:** Medium.

Create one parser that requires `importVersion === 1`, UUID operation ID, bounded page/action references, explicit `expectedSession`, and the exact session reference object. Keep access checks before service dispatch, page lookups scoped to the resolved book, canonical action reconstruction, server-derived ancestry, and one transaction. Replace both old route handlers with `POST /:identifier/guest-progress/import`; derive CAS policy only from `expectedSession`, not a route/method/boolean. Return a typed V1 acknowledgement with `actionsImported` and stable conflict/validation error codes. Remove unversioned, V2, V3, and V4 branches and aliases.

**Non-breaking:** Public book access, reader progress APIs, and the underlying session/action tables retain their existing semantics.

---

### Step 3: Retain only required bounded marker state and expose capability — ⬜ Planned

**Files:** `src/db/schema.ts:1337-1338`, `drizzle/0108_tricky_malice.sql:2-3`, `src/services/guest-progress.ts`, `src/services/book-controller.ts:159-182,693-752`, `src/types/book.ts`, matching generated Drizzle snapshot/journal.
**Effort:** Low to Medium.

Keep the latest operation ID plus fingerprint because V1 requires exact retry confirmation and operation-ID reuse detection. Remove marker-clearing branches that exist only to invalidate legacy/unversioned writes; retain invalidation on genuine destructive progress reset if an outstanding import could otherwise be falsely acknowledged. Add `guestProgressImportVersion: 1` to the backend book detail contract where Flutter already obtains the server session snapshot, and document that it is a capability, not a supported-version range.

Review `0108` and every schema migration against deployed database journals before editing history. If no environment has applied the relevant migrations, fold/squash pending changes only under the repository’s migration discipline. If any environment has applied them, preserve migration history and add a normal forward migration; do not rewrite an applied migration.

**Non-breaking:** Keep the marker columns and authenticated session field used by V1; do not create a per-operation history table.

---

### Step 4: Make Flutter use only the V1 import domain and API — ⬜ Planned

**Files:** `Twistloom-flutter/lib/shared/journeys/guest_migration_models.dart:9-257`, `guest_progress_importer.dart:17-400`, `journey_repository.dart:123,548-600`, `features/auth/auth_controller.dart:518-524`, `shared/books/book.dart:568-702`, `shared/books/books_repository.dart:39-47,410-415`, `shared/books/books_remote_source.dart:34-47,1229-1260`, related `test/shared/journeys/*` and auth tests.
**Effort:** Medium.

Rename the V4 DTO to the canonical V1 DTO and make request/ack decoding require `importVersion: 1`. Remove endpoint selection by `replace`; send every immutable command to the one V1 POST with `expectedSession` as the CAS token. Keep the existing strong importer behaviors: durable intent before network I/O, exact retry, account epoch checks, confirmed-path projection, primary acknowledgement validation, and guarded activation. Rename `migrateGuestSessions`/`GuestMigrationResult` to signup adoption terminology; remove the old payload/result DTOs and unused legacy `BooksRepository`/`BooksRemoteSource` method. Remove old V2/V3 journal supersession logic only after Step 1 proves no shipped app requires it. Type and consume the backend’s `guestProgressImportVersion: 1` property; eliminate the mismatched default-zero `guestProgressVersion >= 4` check.

**Non-breaking:** Preserve guest and account journey rows and the explicit comparison offer; no server success is inferred from a local cursor.

---

### Step 5: Replace web’s unversioned migration with the same V1 owner — ⬜ Planned

**Files:** `Twistloom-web/src/components/providers/AuthProvider.tsx:11,173-211`, `src/lib/utils/guest-migration.ts:1-164`, `src/lib/services/books-api.ts:1028-1044`, `src/lib/types/books.ts:136`, `src/lib/offline-db.ts`, reader progress/action writers, guest migration architecture and safety/parity roadmap.
**Effort:** High.

Retire automatic unversioned dispatch and the `{actionsMigrated, sessionMigrated}` response path. Add one browser domain owner that builds the same V1 canonical references, stores an immutable operation before sending, pins expected authenticated principal/account epoch, and validates the exact V1 acknowledgement. Align web authentication policy with Flutter: auto-import only a verified pristine signup against an absent account session; offer explicit compare/replace for existing-account sign-in and restore. Ensure storage distinguishes public guest and account-owned snapshots, records a source revision, and preserves source data across conflict, unknown delivery, local activation failure, and account change. Delete or compact a source only after matching V1 acknowledgement and a source-revision guard. Ownerless old browser records must be quarantined or offered for recovery; never assign them automatically to whichever account is signed in.

**Non-breaking:** Keep current reading usable offline and preserve old local snapshots while the V1 importer is unavailable or refuses the data.

---

### Step 6: Verify one contract across backend, web, and Flutter — ⬜ Planned

**Files:** `tests/*guest-progress*`, `Twistloom-web/tests` and `src/**/*.test.*`, `Twistloom-flutter/test/shared/journeys/*`, contract fixture location chosen in Step 1.
**Effort:** Medium.

Add matching request and acknowledgement fixtures for all three projects. Backend tests must cover strict version rejection, bounds, hidden/restricted book access, cross-book page IDs, non-child edges, forged action metadata, incomplete ancestry, first import, expected-absent race, exact duplicate replay, operation-ID/hash mismatch, stale consent (`409`), and transaction rollback. Client tests must cover exact V1 payload/path, capability=1 acceptance, older capability refusal, malformed/wrong-operation response refusal, lost reply followed by exact replay, account switching, duplicate import intent, source-revision mutation during request, and no destructive cleanup on any non-confirmed outcome. Run unit/static checks in each project; add isolated PostgreSQL tests for lock/CAS and migration behavior before rollout.

**Non-breaking:** Tests use isolated data and do not access or mutate production accounts.

---

### Step 7: Synchronize architecture docs and retire superseded plans — ⬜ Planned

**Files:** `docs/architecture/GUEST_PROGRESS_IMPORT_ARCHITECTURE.md`, `Twistloom-web/docs/architecture/GUEST_READING_PROGRESS_MIGRATION_ARCHITECTURE.md`, `Twistloom-flutter/docs/architecture/GUEST_PROGRESS_MIGRATION_ARCHITECTURE.md`, `Twistloom-web/docs/roadmap/GUEST_PROGRESS_SAFETY_AND_FLUTTER_PARITY_ROADMAP.md`, `Twistloom-flutter/docs/roadmap/done/GUEST_PROGRESS_MIGRATION_ROADMAP.md`, related completed legacy migration roadmaps.
**Effort:** Low.

Update the three architecture docs to use the same V1 route, request/ack schema, capability property, CAS semantics, owner-preserving local lifecycle, and failure codes. Keep completed historical roadmaps as historical records, clearly mark the web V4-parity roadmap superseded by this cross-client V1 roadmap after implementation begins, and remove statements that the V2/V4 or unversioned route is the supported deployed contract. Search all source, tests, comments, API docs, and roadmaps for `migrate-guest-progress`, `adopt-guest-progress`, unversioned payloads, `V2`, `V3`, `V4`, `GuestMigrationPayload`, and old response booleans; remaining mentions must be explicitly historical or test rejection cases.

**Non-breaking:** Retain decision history and completed-project records; archive or annotate them rather than erasing context.

---

## 7. Open Questions

### Q1. Have any web or Flutter builds containing old guest import code shipped? — ⬜ Open

The backend is reported as undeployed. That does not establish whether client binaries or browser local state can contain old pending imports.

- **(A)** No client build shipped — remove all old network DTOs and pending-command adapters directly; preserve locally stored guest journeys.
- **(B)** A client build shipped — keep a narrow local-store reader/recovery path for its persisted guest source or operation until it is safely reconciled; still remove server compatibility if no deployed backend ever accepted it.

**Recommendation:** Check release artifacts and telemetry before Step 4/5. Favor (A) for protocol compatibility if confirmed; never delete guest journey data as part of that choice.

---

### Q2. Should capability be present on the book response? — ✅ Decided

**Decision:** Yes. Expose `guestProgressImportVersion: 1` on the authenticated book detail/session projection Flutter already reads. This corrects the current producer/consumer mismatch and provides a clear unsupported-backend result without retaining older import protocols.

---

## 8. References & File Touch List

### Backend

| File | Change |
|------|--------|
| `src/routes/books.ts:145-146,7611-7697` | Replace two route handlers and legacy/version dispatch with the single V1 endpoint |
| `src/utils/guest-progress.ts:4-143` | Strict V1 request parser, canonical graph/domain helpers, one acknowledgement/CAS model |
| `src/services/guest-progress.ts:14-177` | One import transaction; remove legacy adapter and V2/V4 branching |
| `src/db/schema.ts:1337-1338` | Retain latest-operation markers; document final V1 ownership |
| `drizzle/0108_tricky_malice.sql:2-3` and `drizzle/meta/*` | Verify/simplify only if unapplied everywhere; otherwise preserve migration history |
| `src/services/book-controller.ts:159-182,693-752`, `src/types/book.ts:389-394` | Add typed `guestProgressImportVersion: 1` capability |
| `tests/*guest-progress*` | Cover strict contract, graph validation, CAS, duplicate replay, and route policy |

### Web

| File | Change |
|------|--------|
| `src/components/providers/AuthProvider.tsx:11,173-211` | Remove login/restore auto-migration; invoke shared V1 adoption policy with identity checks |
| `src/lib/utils/guest-migration.ts:1-164` | Replace legacy cache-flattening importer with owned durable V1 import coordinator or retire after equivalent owner is established |
| `src/lib/services/books-api.ts:1028-1044` | Typed V1 endpoint method and acknowledgement; remove old method |
| `src/lib/types/books.ts:136`, `src/lib/types/api/book.ts` | Type the capability and request/ack contract; remove unused marker surface if no longer consumed |
| `src/lib/offline-db.ts` and guest progress writers | Scope guest/account ownership, revisions, durable intent, safe legacy-data quarantine |
| `tests/`, `docs/architecture/GUEST_READING_PROGRESS_MIGRATION_ARCHITECTURE.md` | Contract tests and synchronized architecture |

### Flutter

| File | Change |
|------|--------|
| `lib/shared/journeys/guest_migration_models.dart:9-257` | Rename V4 DTO to V1 and remove unused legacy migration payload/result classes |
| `lib/shared/journeys/guest_progress_importer.dart:17-400` | Use one V1 endpoint/capability; retire V2/V3 journal compatibility after release audit |
| `lib/shared/journeys/journey_repository.dart:123,548-600`, `lib/features/auth/auth_controller.dart:518-524` | Rename migration wrapper/result to adoption semantics and keep pristine-signup rule explicit |
| `lib/shared/books/book.dart:568-702` | Replace `guestProgressVersion >= 4` default-zero gate with typed V1 capability |
| `lib/shared/books/books_repository.dart:39-47,410-415`, `lib/shared/books/books_remote_source.dart:34-47,1229-1260` | Remove legacy transport method and use one typed V1 POST |
| `test/shared/journeys/*`, `test/features/auth/auth_controller_test.dart` | Update contract, importer, and auth-policy tests |

### Existing References to Reconcile

| File | Change |
|------|--------|
| `docs/architecture/GUEST_PROGRESS_IMPORT_ARCHITECTURE.md` | Replace V2/V4 and legacy-adapter narrative with final V1 boundaries |
| `Twistloom-web/docs/architecture/GUEST_READING_PROGRESS_MIGRATION_ARCHITECTURE.md` | Record V1 web producer and corrected source-preservation contract |
| `Twistloom-flutter/docs/architecture/GUEST_PROGRESS_MIGRATION_ARCHITECTURE.md` | Record shared V1 endpoint and capability contract |
| `Twistloom-web/docs/roadmap/GUEST_PROGRESS_SAFETY_AND_FLUTTER_PARITY_ROADMAP.md` | Reconcile or mark superseded; it currently targets V4 and retains backend legacy compatibility |
| `Twistloom-flutter/docs/roadmap/done/GUEST_PROGRESS_MIGRATION_ROADMAP.md`, backend historical guest migration docs | Keep as historical records; distinguish shipped/past scope from final V1 contract |

### Codebase Findings

| ID | Finding | Impact |
|---|---|---|
| G01 | Backend has no `guestProgressVersion`/`guestProgressImportVersion` output, but Flutter gates on `guestProgressVersion` defaulting to zero. | Current Flutter importer can report unsupported even when the import API is available. |
| G02 | Web unversioned importer dispatches after any ready authenticated login/restore and deletes local sources after HTTP success without verifying applied session state. | Shared-browser attribution and false-success data-loss risks remain until replaced. |
| G03 | Flutter’s current importer is V4 and robust, but old migration DTOs, API wrappers, names, and old V2/V3 operation journal handling coexist. | Larger maintenance surface and unclear canonical path. |
| G04 | Existing web safety/parity roadmap targets V4 and explicitly plans to retain backend compatibility. | Competing target contracts unless reconciled with this V1 plan. |

---

## 9. Completion Status

Legend: ✅ Implemented & verified · ⏳ Partial / scoped down · ⬜ Future work · ⏩ Deferred

### Completed

- ✅ Cross-project source trace — backend routes/parser/service, web producer/endpoint/auth lifecycle, Flutter importer/legacy wrappers/auth lifecycle, and architecture/roadmap references were inspected.
- ✅ Target recommendation — one V1 endpoint, strict typed request/ack, expected-session CAS, bounded latest-operation marker, explicit capability, and source-preserving client policy are specified above.

### In Progress

- ⏳ None — this document is a proposal; no source code or existing documentation was changed by this roadmap task.

### Future / Deferred

- ⬜ Confirm client distribution and database migration state before deleting any local reader or editing migration history.
- ⬜ Implement Steps 2–7 across backend, web, and Flutter; run contract and PostgreSQL verification before enabling the flow.
- ⏩ Permanent operation receipt history — intentionally excluded; the latest operation marker is sufficient for bounded retry confirmation.
