# GitHub Copilot Instructions — Twistloom Backend

## Working style

- Inspect related types, services, configuration, and callers before modifying code.
- Prefer the smallest change that correctly solves the requested problem.
- Follow existing repository patterns before introducing a new abstraction.
- Do not add a dependency when the existing stack or standard platform APIs can solve the problem cleanly.
- Do not perform unrelated refactors while implementing a targeted change.

## Runtime and tooling

- Use Bun as the local runtime and package manager.
- Use `bun` commands, not `npm`, `yarn`, or `pnpm`.
- Production deployment currently runs on Vercel's Node.js runtime; do not assume Bun-only APIs are available in production code.
- Prefer Web Platform APIs where practical because the codebase intentionally remains runtime-portable.

## TypeScript

- Preserve strict TypeScript safety.
- Avoid `any` unless there is no reasonable typed alternative.
- Prefer existing domain types over duplicating structural types.
- Do not weaken types merely to silence compiler errors.
- Preserve exhaustive handling of enums and discriminated unions where applicable.

## Imports

- All local imports MUST include explicit `.js` extensions (e.g. `import { db } from '../db/client.js';`).
- This adheres to ESM module resolution and is enforced by `bun lint:imports`.

## Validation

After modifying code, run the relevant repository checks.

Prefer:

- `bun check`
- `bun typecheck`
- targeted tests/checks when available

Fix issues caused by the change. Do not hide failures by disabling lint or TypeScript rules.

## Documentation

Update comments or documentation when behavior, contracts, configuration, or architecture materially changes.
Do not add comments that merely restate obvious code.

## Development Commands

> **PowerShell Command Separator**
> Use `;` as command separator in PowerShell to chain commands:
> ```powershell
> cd "d:\Projects\Twistloom\Twistloom-backend"; bun run check
> ```

### Development Scripts
```bash
bun dev                         # Start dev server with hot reload
bun dev:api                     # Start API server only
bun dev:cron:trending           # Run trending score calculation locally
bun dev:cron:candidate          # Run candidate generation cron locally
bun dev:cron:translate          # Run translation cron locally
```

### Quality & Type Checking
```bash
bun typecheck                   # Run TypeScript compiler check
bun lint                        # Run ESLint
bun lint:fix                    # Auto-fix linting issues
bun lint:imports                # Verify all imports have .js extensions
bun check                       # Run lint + lint:imports + typecheck in sequence
```

### Database Scripts (Manual Developer Execution Only)
```bash
bun db:test                     # Test Neon connection
bun db:studio                   # Open Drizzle Studio UI
bun db:migrate                  # Apply pending migrations (Dev)
bun db:triggers                 # Apply Postgres triggers
```

## Architectural Context

For architectural invariants, established patterns, and domain-specific rules, see [`AGENTS.md`](../AGENTS.md).
