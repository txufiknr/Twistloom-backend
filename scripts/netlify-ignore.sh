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
REF_SHA="$(git rev-parse --verify --quiet "${REF}^{commit}" 2>/dev/null)" || exit 1
HEAD_SHA="$(git rev-parse --verify --quiet "HEAD^{commit}" 2>/dev/null)" || exit 1

# If CACHED_COMMIT_REF equals HEAD, this is either the first build of the site,
# a cleared-cache build, or a manual retry of the current commit.
# There is no previous baseline to diff against: build conservatively.
# (Netlify sets CACHED_COMMIT_REF = COMMIT_REF whenever the build runs without
# cache — without this guard `git diff HEAD HEAD` is empty and would cancel
# every build, including builds that touch real code.)
if [ "$REF_SHA" = "$HEAD_SHA" ]; then
  exit 1
fi

# Skip only when every changed file since the last successful deploy is
# documentation: root-level or nested *.md, or anything under docs/.
if git diff --quiet "$REF_SHA" "$HEAD_SHA" -- . \
  ':(exclude)*.md' \
  ':(exclude)**/*.md' \
  ':(exclude)docs/**'; then
  exit 0
fi
exit 1
