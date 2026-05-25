# Story Theme Caching Roadmap

## Overview

This roadmap outlines the implementation of a comprehensive caching system for AI-generated story themes to reduce AI generation costs while maintaining the streaming user experience. The solution balances cost optimization with content freshness and user experience.

## Current State Analysis

### Existing Implementation

**Endpoint:** `GET /api/books/prompt`

**Current Flow:**
1. User requests a story theme via SSE
2. Every request triggers AI generation via `generateBookCreationPromptStream()`
3. AI generates story theme with streaming response
4. Response includes: story theme, main character details, tone, and elements

**Current Issues:**
- Every API hit triggers AI generation (high cost)
- No caching mechanism exists
- Identical prompts may be generated multiple times
- No way to leverage previously generated content

**Example Output Format:**
```
A psychological thriller about a disgraced investigative journalist who returns to her childhood hometown to uncover the truth behind a series of mysterious disappearances at an abandoned asylum, only to discover that the facility's dark experiments never truly ended and someone is watching her every move from the shadows.
MC: Elena Rodriguez, Female, 31, Former award-winning journalist with a sharp wit and haunted past, driven by redemption and an obsessive need for truth
Tone: Dark, suspenseful, psychological horror with elements of conspiracy and paranoia
Elements: Atmospheric dread, unreliable narrators, hidden agendas, psychological manipulation, isolation, and the blurring line between reality and delusion
```

## Proposed Solution

### Architecture Overview

```
┌─────────────────┐
│  User Request   │
│  GET /prompt    │
└────────┬────────┘
         │
         ▼
┌─────────────────────────┐
│  Check Cache Strategy   │
│  - Cache size threshold │
│  - User history check   │
└────────┬────────────────┘
         │
         ├─► Cache Hit ──────────────────────┐
         │                                    │
         ▼                                    │
┌─────────────────┐                          │
│  Select Random   │                          │
│  Cached Prompt   │                          │
└────────┬────────┘                          │
         │                                    │
         ▼                                    │
┌─────────────────┐                          │
│  Simulate Stream │                          │
│  (Chunk & Delay) │                          │
└────────┬────────┘                          │
         │                                    │
         ▼                                    │
┌─────────────────┐                          │
│  Return SSE      │                          │
│  Stream          │                          │
└─────────────────┘                          │
                                              │
         Cache Miss ───────────────────────────┘
         │
         ▼
┌─────────────────┐
│  Generate via AI│
│  (Real Stream) │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Save to Cache  │
│  (If Valid)     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Return SSE     │
│  Stream         │
└─────────────────┘
```

## Database Schema Design

### New Table: `storyPrompts`

```typescript
export const storyPrompts = pgTable(
  "story_prompts",
  {
    id: id(),
    /** Full generated prompt text (stored atomically as creative free-form text) */
    content: text("content").notNull(),
    /** AI provider used for generation */
    aiProvider: text("ai_provider").$type<AIChatProvider>(),
    /** AI model used for generation */
    aiModel: text("ai_model"),
    /** Quality score (0-1) based on validation */
    qualityScore: real("quality_score").default(1.0),
    /** Number of times this prompt has been served */
    usageCount: integer("usage_count").notNull().default(0),
    /** Number of unique users who have seen this prompt */
    uniqueUserCount: integer("unique_user_count").notNull().default(0),
    /** Whether this prompt is currently active for serving */
    isActive: boolean("is_active").notNull().default(true),
    /** Expiration date for freshness rotation */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Last served timestamp */
    lastServedAt: timestamp("last_served_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    // Index for active prompts
    index("story_prompts_active_idx").on(t.isActive).where(sql`${t.isActive} = true`),
    // Index for expiration cleanup
    index("story_prompts_expires_idx").on(t.expiresAt).where(sql`${t.expiresAt} IS NOT NULL`),
    // Index for quality-based selection
    index("story_prompts_quality_idx").on(t.qualityScore.desc()),
    // Index for usage tracking
    index("story_prompts_usage_idx").on(t.usageCount.desc()),
    // Index for freshness (last served)
    index("story_prompts_last_served_idx").on(t.lastServedAt),
    // GIN index for content search (pg_trgm)
    index("story_prompts_content_gin_idx").using("gin", sql`content gin_trgm_ops`),
  ]
);
```

### New Table: `userPromptHistory`

```typescript
export const userPromptHistory = pgTable(
  "user_prompt_history",
  {
    id: id(),
    userId: userId().references(() => users.userId, { onDelete: "cascade" }),
    promptId: uuid("prompt_id").notNull().references(() => storyPrompts.id, { onDelete: "cascade" }),
    /** Timestamp when user viewed this prompt */
    viewedAt: timestamp("viewed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Whether user used this prompt to create a book */
    usedForBook: boolean("used_for_book").notNull().default(false),
    /** Book ID if user created a book from this prompt */
    bookId: uuid("book_id").references(() => books.id, { onDelete: "set null" }),
    createdAt,
  },
  (t) => [
    // Unique constraint to prevent duplicate views
    unique("user_prompt_history_user_prompt_unique").on(t.userId, t.promptId),
    // Index for user's prompt history
    index("user_prompt_history_user_idx").on(t.userId, t.viewedAt.desc()),
    // Index for prompt popularity
    index("user_prompt_history_prompt_idx").on(t.promptId),
    // Index for conversion tracking
    index("user_prompt_history_used_idx").on(t.usedForBook),
  ]
);
```

## Caching Strategy

### Phase 1: Hybrid Mode (Initial)

**Trigger Conditions:**
- Cache size < 100 prompts: Always generate via AI
- Cache size >= 100 prompts: 70% cache hit, 30% AI generation

**Selection Logic:**
```typescript
const CACHE_THRESHOLD = 100;
const CACHE_HIT_RATE = 0.7;

const shouldUseCache = async () => {
  const cacheCount = await getActivePromptCount();
  if (cacheCount < CACHE_THRESHOLD) return false;
  
  const random = Math.random();
  return random < CACHE_HIT_RATE;
};
```

### Phase 2: Cache-Only Mode (Mature)

**Trigger Conditions:**
- Cache size >= 500 prompts
- Average quality score >= 0.8
- Weekly AI generation maintains freshness

**Selection Logic:**
- 95% cache hit, 5% AI generation (for freshness)
- Weekly cron generates 10-20 new prompts
- Retire old prompts based on usage and quality

### User-Specific Freshness

**Problem:** Users shouldn't see the same prompt twice

**Solution:**
```typescript
const getFreshPromptForUser = async (userId: string) => {
  // Get prompts user has already seen
  const viewedPromptIds = await getUserViewedPromptIds(userId);
  
  // Select from active prompts excluding viewed ones
  const freshPrompt = await dbRead
    .select()
    .from(storyPrompts)
    .where(
      and(
        eq(storyPrompts.isActive, true),
        sql`${storyPrompts.id} NOT IN ${viewedPromptIds}`
      )
    )
    .orderBy(sql`RANDOM()`)
    .limit(1);
  
  // If no fresh prompts available, fallback to least recently viewed
  if (!freshPrompt.length) {
    return getLeastRecentlyViewedPrompt(userId);
  }
  
  return freshPrompt[0];
};
```

## Streaming Simulation

### Challenge: Maintain AI-like streaming from cached content

**Solution:** Chunk cached content with artificial delays

```typescript
/**
 * Simulates SSE streaming from cached prompt content
 * 
 * @param content - Full prompt content to stream
 * @param chunkSize - Number of characters per chunk (default: 10)
 * @param delayMs - Delay between chunks in ms (default: 50)
 * @returns ReadableStream of SSE-formatted chunks
 */
export async function streamCachedPrompt(
  content: string,
  chunkSize: number = 10,
  delayMs: number = 50
): Promise<ReadableStream<Uint8Array>> {
  const chunks: string[] = [];
  
  for (let i = 0; i < content.length; i += chunkSize) {
    chunks.push(content.slice(i, i + chunkSize));
  }
  
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      
      for (const chunk of chunks) {
        // Simulate AI typing delay
        await new Promise(resolve => setTimeout(resolve, delayMs));
        
        const sseEvent = `event: chunk\ndata: ${JSON.stringify({
          type: 'chunk',
          content: chunk,
          done: false
        })}\n\n`;
        
        controller.enqueue(encoder.encode(sseEvent));
      }
      
      // Send end event
      const endEvent = `event: end\ndata: ${JSON.stringify({
        type: 'end',
        provider: 'cache',
        model: 'cached-prompt'
      })}\n\n`;
      
      controller.enqueue(encoder.encode(endEvent));
      controller.close();
    }
  });
  
  return stream;
}
```

### Adaptive Chunking

**Variable chunk sizes for more natural feel:**
```typescript
const getAdaptiveChunkSize = (position: number, totalLength: number): number => {
  // Smaller chunks at start (simulating AI thinking)
  if (position < totalLength * 0.1) return 5;
  // Larger chunks in middle (flow state)
  if (position < totalLength * 0.8) return 15;
  // Smaller chunks at end (finishing touches)
  return 8;
};
```

## Freshness Mechanisms

### 1. Expiration-Based Rotation

**Strategy:**
- New prompts expire in 90 days
- High-quality prompts (score >= 0.9) expire in 180 days
- Low-quality prompts (score < 0.7) expire in 30 days

**Implementation:**
```typescript
const calculateExpiration = (qualityScore: number): Date => {
  const now = new Date();
  let days = 90;
  
  if (qualityScore >= 0.9) days = 180;
  else if (qualityScore < 0.7) days = 30;
  
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
};
```

### 2. Usage-Based Rotation

**Strategy:**
- Retire prompts served > 100 times
- Prioritize newer prompts for selection
- Weight selection by inverse usage count

**Implementation:**
```typescript
const selectPromptByUsageWeight = async () => {
  const prompts = await dbRead
    .select()
    .from(storyPrompts)
    .where(eq(storyPrompts.isActive, true));
  
  // Calculate weights (inverse of usage)
  const weights = prompts.map(p => 1 / (p.usageCount + 1));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  
  // Weighted random selection
  let random = Math.random() * totalWeight;
  for (let i = 0; i < prompts.length; i++) {
    random -= weights[i];
    if (random <= 0) return prompts[i];
  }
  
  return prompts[prompts.length - 1];
};
```

### 3. Quality-Based Prioritization

**Quality Metrics:**
- Length validation (100-500 characters)
- Structure validation (contains MC, tone, elements)
- Duplicate detection (similarity to existing prompts)
- User conversion rate (used for book creation)

**Implementation:**
```typescript
const validatePromptQuality = (content: string): number => {
  let score = 1.0;
  
  // Length check
  if (content.length < 100 || content.length > 500) score -= 0.2;
  
  // Structure check
  if (!content.includes('MC:') || !content.includes('Tone:')) score -= 0.3;
  
  // Duplicate check (would need similarity algorithm)
  // const isDuplicate = await checkForDuplicates(content);
  // if (isDuplicate) score -= 0.5;
  
  return Math.max(0, score);
};
```

## Cron Job Implementation

### Weekly Prompt Generation

**Schedule:** Every Sunday at 2:00 AM UTC

**Configuration:**
```typescript
const PROMPT_GENERATION_CONFIG = {
  schedule: '0 2 * * 0', // Cron expression
  batchSize: 10, // Number of prompts to generate per run
  targetCacheSize: 500, // Target number of active prompts
  minQualityScore: 0.7, // Minimum quality to keep
};
```

**Implementation:**
```typescript
/**
 * Cron job: Generate new story prompts weekly
 * 
 * Process:
 * 1. Check current cache size
 * 2. If below target, generate new prompts via AI
 * 3. Validate and save high-quality prompts
 * 4. Retire expired or low-quality prompts
 * 5. Update cache statistics
 */
export async function generateWeeklyPrompts() {
  console.log('[generateWeeklyPrompts] Starting weekly prompt generation');
  
  try {
    // Step 1: Check cache size
    const activeCount = await getActivePromptCount();
    const targetSize = PROMPT_GENERATION_CONFIG.targetCacheSize;
    
    if (activeCount >= targetSize) {
      console.log('[generateWeeklyPrompts] Cache size sufficient, skipping generation');
      return;
    }
    
    // Step 2: Calculate how many to generate
    const toGenerate = Math.min(
      PROMPT_GENERATION_CONFIG.batchSize,
      targetSize - activeCount
    );
    
    console.log(`[generateWeeklyPrompts] Generating ${toGenerate} new prompts`);
    
    // Step 3: Generate prompts via AI
    const generatedPrompts: string[] = [];
    for (let i = 0; i < toGenerate; i++) {
      try {
        const stream = await generateBookCreationPromptStream({ logPrompts: true });
        const content = await streamToString(stream);
        generatedPrompts.push(content);
      } catch (error) {
        console.error(`[generateWeeklyPrompts] Failed to generate prompt ${i + 1}:`, error);
      }
    }
    
    // Step 4: Validate and save
    let savedCount = 0;
    for (const content of generatedPrompts) {
      const qualityScore = validatePromptQuality(content);
      
      if (qualityScore >= PROMPT_GENERATION_CONFIG.minQualityScore) {
        const parsed = parsePromptContent(content);
        
        await dbWrite.insert(storyPrompts).values({
          content,
          theme: parsed.theme,
          mcDetails: parsed.mc,
          tone: parsed.tone,
          elements: parsed.elements,
          qualityScore,
          expiresAt: calculateExpiration(qualityScore),
          isActive: true,
        });
        
        savedCount++;
      }
    }
    
    console.log(`[generateWeeklyPrompts] Saved ${savedCount}/${generatedPrompts.length} prompts`);
    
    // Step 5: Retire old prompts
    await retireExpiredPrompts();
    await retireLowQualityPrompts();
    
    // Step 6: Update statistics
    const finalCount = await getActivePromptCount();
    console.log(`[generateWeeklyPrompts] Complete. Active prompts: ${finalCount}`);
    
  } catch (error) {
    console.error('[generateWeeklyPrompts] Error:', error);
    throw error;
  }
}
```

### Cleanup Cron Job

**Schedule:** Daily at 3:00 AM UTC

**Tasks:**
- Deactivate expired prompts
- Deactivate prompts with usage > 100
- Archive old user prompt history (> 90 days)

## Implementation Roadmap

### Phase 1: Database Schema (Week 1) ✅ COMPLETED

**Tasks:**
1. [x] Create `storyPrompts` table in schema.ts
2. [x] Create `userPromptHistory` table in schema.ts
3. [ ] Generate and run database migration (SKIPPED - user will handle)
4. [x] Add indexes for optimal query performance
5. [x] Write TypeScript types for new tables

**Deliverables:**
- [x] Database migration file (user to generate)
- [x] Updated schema.ts
- [x] Type definitions

**Files Created/Modified:**
- `src/db/schema.ts` - Added storyPrompts and userPromptHistory tables

### Phase 2: Core Caching Logic (Week 2) ✅ COMPLETED

**Tasks:**
1. [x] Create `src/services/prompt-cache.ts` service
2. [x] Implement `getActivePromptCount()` function
3. [x] Implement `getFreshPromptForUser()` function
4. [x] Implement `savePromptToCache()` function
5. [x] Implement `validatePromptQuality()` function
6. [x] Implement `calculateExpiration()` function
7. [x] Add user prompt history tracking

**Deliverables:**
- [x] Prompt cache service module
- [ ] Unit tests for cache logic (PENDING)
- [ ] Integration tests (PENDING)

**Files Created:**
- `src/services/prompt-cache.ts` - Core caching logic
- `src/config/prompt-cache.ts` - Configuration

### Phase 3: Streaming Simulation (Week 2-3) ✅ COMPLETED

**Tasks:**
1. [x] Implement `streamCachedPrompt()` function
2. [x] Implement adaptive chunking logic
3. [x] Add variable delay simulation
4. [ ] Test streaming behavior matches AI experience (PENDING - manual testing)
5. [x] Add error handling for streaming failures

**Deliverables:**
- [x] Streaming simulation module
- [ ] Performance benchmarks (PENDING)
- [ ] User experience validation (PENDING)

**Files Created:**
- `src/utils/prompt-stream.ts` - Streaming simulation utilities

### Phase 4: API Integration (Week 3) ✅ COMPLETED

**Tasks:**
1. [x] Update `GET /api/books/prompt` endpoint
2. [x] Implement cache strategy logic (hybrid mode)
3. [x] Add cache hit/miss logging
4. [x] Update SSE event format for cache source
5. [x] Add fallback to AI generation on cache failure
6. [ ] Update API documentation (PENDING)

**Deliverables:**
- [x] Updated endpoint implementation
- [ ] API documentation updates (PENDING)
- [ ] Monitoring dashboards (PENDING)

**Files Modified:**
- `src/routes/books.ts` - Updated GET /api/books/prompt endpoint

### Phase 5: Cron Jobs (Week 4) ✅ COMPLETED

**Tasks:**
1. [x] Create `src/cron/generate-prompts.ts` cron job
2. [x] Implement weekly prompt generation logic
3. [x] Create `src/cron/cleanup-prompts.ts` cron job
4. [x] Implement daily cleanup logic
5. [x] Add cron job configuration
6. [ ] Test cron job execution (PENDING - manual testing)
7. [x] Add error handling and retry logic

**Deliverables:**
- [x] Cron job modules
- [x] Cron configuration
- [ ] Monitoring and alerting (PENDING)

**Files Created:**
- `src/cron/generate-prompts.ts` - Weekly prompt generation
- `src/cron/cleanup-prompts.ts` - Daily cleanup

### Phase 6: Monitoring & Analytics (Week 4-5) ⚠️ PARTIALLY COMPLETED

**Tasks:**
1. [x] Add cache hit rate tracking
2. [ ] Add prompt quality analytics (PENDING)
3. [ ] Add user conversion tracking (PENDING)
4. [ ] Create dashboard for cache statistics (PENDING)
5. [ ] Set up alerts for low cache size (PENDING)
6. [ ] Set up alerts for low quality scores (PENDING)

**Deliverables:**
- [ ] Analytics dashboard (PENDING)
- [ ] Monitoring alerts (PENDING)
- [ ] Performance reports (PENDING)

**Implementation:**
- Added in-memory cache hit rate tracking in `src/services/prompt-cache.ts`
- Functions: `getCacheHitRateStats()`, `resetCacheHitRateTracking()`

### Phase 7: Testing & Optimization (Week 5-6)

**Tasks:**
1. [ ] Load testing with cache enabled
2. [ ] Performance benchmarking (cache vs AI)
3. [ ] User experience testing
4. [ ] A/B testing (cache vs no cache)
5. [ ] Optimize chunk sizes and delays
6. [ ] Optimize database queries
7. [ ] Stress test cache selection logic

**Deliverables:**
- Performance report
- Optimization recommendations
- Test results documentation

### Phase 8: Documentation & Handoff (Week 6)

**Tasks:**
1. [ ] Write technical documentation
2. [ ] Write operations documentation
3. [ ] Create runbook for cache management
4. [ ] Train team on new system
5. [ ] Create rollback plan
6. [ ] Final code review

**Deliverables:**
- Technical documentation
- Operations runbook
- Training materials

## Configuration

### Environment Variables

```env
# Prompt Caching Configuration
PROMPT_CACHE_ENABLED=true
PROMPT_CACHE_THRESHOLD=100
PROMPT_CACHE_HIT_RATE=0.7
PROMPT_CACHE_TARGET_SIZE=500
PROMPT_CACHE_MIN_QUALITY=0.7

# Streaming Simulation
PROMPT_STREAM_CHUNK_SIZE=10
PROMPT_STREAM_DELAY_MS=50

# Expiration (days)
PROMPT_EXPIRE_DEFAULT=90
PROMPT_EXPIRE_HIGH_QUALITY=180
PROMPT_EXPIRE_LOW_QUALITY=30

# Cron Schedules
PROMPT_GENERATION_CRON="0 2 * * 0"
PROMPT_CLEANUP_CRON="0 3 * * *"
```

### Configuration File

```typescript
// src/config/prompt-cache.ts
export const PROMPT_CACHE_CONFIG = {
  enabled: process.env.PROMPT_CACHE_ENABLED === 'true',
  threshold: parseInt(process.env.PROMPT_CACHE_THRESHOLD || '100'),
  hitRate: parseFloat(process.env.PROMPT_CACHE_HIT_RATE || '0.7'),
  targetSize: parseInt(process.env.PROMPT_CACHE_TARGET_SIZE || '500'),
  minQuality: parseFloat(process.env.PROMPT_CACHE_MIN_QUALITY || '0.7'),
  
  streaming: {
    chunkSize: parseInt(process.env.PROMPT_STREAM_CHUNK_SIZE || '10'),
    delayMs: parseInt(process.env.PROMPT_STREAM_DELAY_MS || '50'),
  },
  
  expiration: {
    default: parseInt(process.env.PROMPT_EXPIRE_DEFAULT || '90'),
    highQuality: parseInt(process.env.PROMPT_EXPIRE_HIGH_QUALITY || '180'),
    lowQuality: parseInt(process.env.PROMPT_EXPIRE_LOW_QUALITY || '30'),
  },
  
  cron: {
    generation: process.env.PROMPT_GENERATION_CRON || '0 2 * * 0',
    cleanup: process.env.PROMPT_CLEANUP_CRON || '0 3 * * *',
  },
} as const;
```

## Cost Analysis

### Current Costs (No Cache)

**Assumptions:**
- 1,000 prompt requests per day
- AI cost per prompt: $0.01 (estimated)
- Monthly cost: 1,000 * 30 * $0.01 = $300/month

### With Cache (Hybrid Mode)

**Assumptions:**
- 1,000 prompt requests per day
- 70% cache hit rate (after threshold)
- 30% AI generation
- Monthly AI cost: 1,000 * 30 * 0.3 * $0.01 = $90/month
- **Savings: 70% ($210/month)**

### With Cache (Cache-Only Mode)

**Assumptions:**
- 1,000 prompt requests per day
- 95% cache hit rate
- 5% AI generation (weekly cron)
- Monthly AI cost: 1,000 * 30 * 0.05 * $0.01 = $15/month
- **Savings: 95% ($285/month)**

### Database Costs

**Storage:**
- 500 prompts * 1KB each = 0.5 MB
- User history: 10,000 users * 10 prompts * 100 bytes = 10 MB
- **Total storage: ~10.5 MB (negligible cost)**

**Query Costs:**
- Neon PostgreSQL: Included in base tier
- No significant additional cost

## Risk Mitigation

### Risk 1: Cache Exhaustion

**Scenario:** All cached prompts have been viewed by a user

**Mitigation:**
- Fallback to least recently viewed prompt
- Trigger AI generation if cache size is insufficient
- Increase cache hit rate temporarily

### Risk 2: Quality Degradation

**Scenario:** Low-quality prompts accumulate in cache

**Mitigation:**
- Strict quality validation before saving
- Regular cleanup of low-quality prompts
- User feedback mechanism (report bad prompts)
- Automatic quality scoring based on conversion rate

### Risk 3: Stale Content

**Scenario:** Prompts become outdated or repetitive

**Mitigation:**
- Expiration-based rotation
- Weekly AI generation for fresh content
- Duplicate detection before saving
- User-specific freshness tracking

### Risk 4: Streaming Experience Degradation

**Scenario:** Simulated streaming feels artificial

**Mitigation:**
- Adaptive chunking for natural feel
- Variable delays based on content position
- A/B testing with real users
- Fallback to real AI streaming if complaints

### Risk 5: Database Performance

**Scenario:** Cache queries become slow at scale

**Mitigation:**
- Proper indexing from the start
- Query optimization and monitoring
- Consider read replicas if needed
- Cache query results in memory (Redis)

## Success Metrics

### Technical Metrics

- **Cache Hit Rate:** Target > 70% (hybrid), > 95% (cache-only)
- **Average Response Time:** < 500ms for cache hits
- **Cache Size:** Maintain 500+ active prompts
- **Quality Score:** Average > 0.8
- **Uptime:** 99.9% for cache service

### Business Metrics

- **Cost Reduction:** > 70% reduction in AI costs
- **User Conversion:** No decrease in book creation rate
- **User Satisfaction:** No increase in complaints about prompt quality
- **Freshness:** Users see unique prompts (low repeat rate)

### Monitoring Dashboard

**Key Metrics to Track:**
1. Cache hit rate over time
2. Average prompt quality score
3. Number of active prompts
4. User conversion rate (prompt → book)
5. Average response time
6. AI cost savings
7. User repeat rate (seeing same prompt twice)

## Rollback Plan

### Trigger Conditions

- Cache hit rate < 50% for 7 days
- Average quality score < 0.7
- User complaints increase > 20%
- Conversion rate drops > 10%

### Rollback Steps

1. **Immediate:**
   - Set `PROMPT_CACHE_ENABLED=false`
   - All requests fallback to AI generation
   - Monitor for recovery

2. **Investigation:**
   - Review cache quality metrics
   - Analyze user feedback
   - Check for technical issues

3. **Recovery:**
   - Clear low-quality prompts from cache
   - Adjust quality thresholds
   - Re-enable with conservative settings

4. **Permanent Rollback:**
   - If issues persist, disable permanently
   - Keep cache infrastructure for future improvements
   - Document lessons learned

## Future Enhancements

### Phase 9: Personalization (Future)

**Idea:** Personalize prompts based on user preferences

**Implementation:**
- Track user's preferred genres/themes
- Weight prompt selection by user history
- ML model for personalization
- A/B test personalization effectiveness

### Phase 10: Multi-Language Support (Future)

**Idea:** Cache prompts in multiple languages

**Implementation:**
- Add language column to storyPrompts
- Generate prompts in different languages
- Language-aware selection
- Translation of existing prompts

### Phase 11: Community Curation (Future)

**Idea:** Allow users to rate and curate prompts

**Implementation:**
- Add user rating system
- Community voting on best prompts
- Featured prompts based on ratings
- User-submitted prompts (with moderation)

### Phase 12: Advanced Freshness (Future)

**Idea:** Use trending topics and events for prompt relevance

**Implementation:**
- Integrate with news/trending APIs
- Generate prompts based on current events
- Seasonal prompt variations
- Holiday-themed prompts

## Conclusion

This roadmap provides a comprehensive approach to implementing story theme caching that balances cost optimization with user experience. The phased implementation allows for gradual rollout and risk mitigation, while the monitoring and analytics ensure continuous improvement.

**Key Benefits:**
- 70-95% reduction in AI costs
- Maintained streaming user experience
- Scalable architecture
- Built-in quality controls
- Comprehensive monitoring

**Next Steps:**
1. Review and approve roadmap
2. Begin Phase 1 (Database Schema)
3. Set up monitoring baseline
4. Execute phased implementation
5. Continuously monitor and optimize
