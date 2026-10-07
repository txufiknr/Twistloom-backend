#!/usr/bin/env sh
# Netlify build-ignore gate.
# Roadmap: docs/roadmap/NETLIFY_FREE_TIER_OPTIMIZATION_ROADMAP.md (Step 3).
#
# Netlify semantics: exit 0 => SKIP this build, any other exit code => BUILD.
# Conservative by design: if the change set cannot be determined (missing
# env var, missing/unfetched commit, any git error), we build.

set -u

REF="${CACHED_COMMIT_REF:-}"
[ -n "$REF" ] || exit 1
git rev-parse --verify --quiet "${REF}^{commit}" >/dev/null 2>&1 || exit 1

# Skip only when every changed file since the last successful deploy is
# documentation: root-level or nested *.md, or anything under docs/.
if git diff --quiet "$REF" HEAD -- . \
  ':(exclude)*.md' \
  ':(exclude)**/*.md' \
  ':(exclude)docs/**'; then
  exit 0
fi
exit 1
