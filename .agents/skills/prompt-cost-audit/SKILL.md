---
name: prompt-cost-audit
description: >-
  Audit prompt/context construction for token efficiency, caching opportunities,
  and cost optimization across AI providers.
metadata:
  author: twistloom
  version: "1.0"
---

# Prompt Cost Audit Skill

## Trigger
- Changes to prompt templates or context builders
- Performance investigation of AI generation
- Cost optimization review

## Procedure

1. **Token Usage Analysis**
   - Identify prompt/context builders (`buildCanonicalBlock`, `buildCompanionPageContext`, etc.).
   - Check for unnecessary context inclusion.
   - Verify prompt size hasn't increased without justification.

2. **Caching Check**
   - Verify page-stable serialization is memoized with page-scoped keys.
   - Check `cachedRender` is used for expensive string serialization.
   - Verify cache keys rotate when page is published.

3. **Model Selection Check**
   - Verify smaller models are used for validation tasks.
   - Check provider fallback doesn't always hit expensive providers.
   - Verify cost-aware model selection where applicable.

4. **Report**
   - List findings with file:line references.
   - Estimate token/cost impact of each finding.
   - Provide optimization recommendations.
