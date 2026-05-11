# Candidate Generation Enhancement Roadmap

## Overview

This roadmap outlines the planned enhancements to the candidate generation system, focusing on real-time progress tracking, improved user experience, and better monitoring capabilities. The enhancements will provide per-action progress feedback during candidate generation through Server-Sent Events (SSE).

## Current State Analysis

### ✅ Verified Components
- **`isGeneratingStartedAt` Management**: Timestamp correctly reset to `null` in all completion paths
- **SSE Polling**: Working implementation for waiting on in-progress generation
- **Distributed Locking**: Proper concurrent processing prevention
- **Strategy Pattern**: Deployment-aware generation (vercel/github-action/cron)

### 🎯 Identified Enhancement Opportunity
- **Per-Action Progress**: Currently only tracks overall completion
- **Real-time Feedback**: Users wait blindly during generation
- **Granular Monitoring**: No visibility into individual action status

## Enhancement Phases

### Phase 1: Core Progress Tracking Infrastructure - ✅ **COMPLETED**

**Objective**: Add per-action progress callback system to candidate generation

#### 1.1 Type System Updates - ✅ **IMPLEMENTED**
```typescript
// src/types/candidates.ts
export interface ActionProgressEvent {
  action: string;
  status: 'started' | 'completed' | 'failed';
  completed: number;
  total: number;
  progress: number; // 0-100
  error?: string;
  timestamp: string;
}

export interface GenerateCandidatesInParallelParams {
  // ... existing fields
  onProgress?: (action: Action, status: 'started' | 'completed' | 'failed', 
                result?: PersistedStoryPage, error?: unknown) => void;
}
```

#### 1.2 Generation Function Enhancement - ✅ **IMPLEMENTED**
```typescript
// src/utils/candidate-generation.ts - generateCandidatesInParallel()
async function generateCandidatesInParallel(params: GenerateCandidatesInParallelParams): Promise<CandidateGenerationResult[]> {
  const { onProgress } = params;
  
  const generationPromises = actions.map(async (action, index) => {
    // Notify action start
    onProgress?.(action, 'started');
    
    try {
      const result = await generateCandidatePage({...});
      
      // Notify success
      onProgress?.(action, 'completed', result);
      return { action, success: true, candidatePage: result };
    } catch (error) {
      // Notify failure
      onProgress?.(action, 'failed', undefined, error);
      return { action, success: false, candidatePage: null, error };
    }
  });
  
  const results = await Promise.allSettled(generationPromises);
  // ... existing completion logic
}
```

#### 1.3 Strategy Integration - ✅ **IMPLEMENTED**
```typescript
// src/utils/candidate-generation.ts - ensureCandidatesForPageWithStrategy()
export async function ensureCandidatesForPageWithStrategy(
  userId: string, 
  page: UserStoryPage, 
  currentState?: StoryState | null, 
  currentBook?: Book | null,
  context: CandidateGenerationStrategy = 'vercel',
  options?: {
    onProgress?: (action: Action, status: 'started' | 'completed' | 'failed', 
                  result?: PersistedStoryPage, error?: unknown) => void;
  }
): Promise<UserStoryPage> {
  const { onProgress } = options || {};
  
  const totalActions = userPage.actions.filter(a => 
    !a.destination?.pageId
  ).length;
  
  let completedActions = 0;
  
  const updatedPage = await ensureCandidatesForPageWithStrategy(
    userId, userPage, null, null, 'vercel',
    {
      onProgress: (action, status, result, error) => {
        completedActions++;
        
        const progressEvent = {
          action: action.text,
          status,
          completed: completedActions,
          total: totalActions,
          progress: Math.round((completedActions / totalActions) * 100),
          error: error?.message,
          timestamp: new Date().toISOString()
        };
        
        // Send per-action progress via SSE
        res.write(`event: action_progress\n`);
        res.write(`data: ${JSON.stringify(progressEvent)}\n\n`);
        
        console.log(`[GET /candidates] 📊 Action progress: ${action.text} - ${status} (${completedActions}/${totalActions})`);
      }
    }
  );
  
  // Send final completion event
  res.write(`event: complete\n`);
  res.write(`data: ${JSON.stringify(updatedPage)}\n\n`);
  res.end();
}
```

**Expected Outcomes**:
- Per-action progress tracking capability
- Backward compatibility maintained through optional callbacks
- Enhanced logging for debugging and monitoring

**Timeline**: 1-2 weeks
**Priority**: High (Foundation for all subsequent features)

---

### Phase 2: SSE Integration - ✅ **COMPLETED** for Real-time Updates

**Objective**: Integrate per-action progress with Server-Sent Events for real-time user feedback

#### 2.1 Enhanced SSE Events - ✅ **IMPLEMENTED**
```typescript
// src/routes/books.ts - GET /candidates route enhancement
router.get("/:identifier/:pageId/candidates", guestOrAuthMiddleware, async (req: Request, res: Response) => {
  try {
    // ... existing validation logic
    
    // Check if generation is already in progress
    if (dbPage.isGeneratingStartedAt) {
      // ... existing SSE polling setup
      
      // Enhanced polling with action progress support
      while (attempts < SSE_MAX_ATTEMPTS) {
        // ... existing polling logic
        
        // Check for action progress events in database or cache
        const progressEvents = await getActionProgressEvents(pageId);
        for (const event of progressEvents) {
          res.write(`event: action_progress\n`);
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        
        // ... existing completion check
      }
    } else {
      // Direct generation with progress tracking
      const userPage = await mapToUserStoryPage(dbPage, userId);
      const totalActions = userPage.actions.filter(a => 
        !a.destination?.pageId
      ).length;
      
      let completedActions = 0;
      
      const updatedPage = await ensureCandidatesForPageWithStrategy(
        userId, userPage, null, null, 'vercel',
        {
          onProgress: (action, status, result, error) => {
            completedActions++;
            
            const progressEvent: ActionProgressEvent = {
              action: action.text,
              status,
              completed: completedActions,
              total: totalActions,
              progress: Math.round((completedActions / totalActions) * 100),
              error: error?.message,
              timestamp: new Date().toISOString()
            };
            
            // Send per-action progress via SSE
            res.write(`event: action_progress\n`);
            res.write(`data: ${JSON.stringify(progressEvent)}\n\n`);
            
            console.log(`[GET /candidates] 📊 Action progress: ${action.text} - ${status} (${completedActions}/${totalActions})`);
          }
        }
      );
      
      // Send final completion event
      res.write(`event: complete\n`);
      res.write(`data: ${JSON.stringify(updatedPage)}\n\n`);
      res.end();
    }
  } catch (error) {
    handleApiError(res, "Failed to generate candidates", error);
  }
});
```

#### 2.2 Progress Event Storage - ✅ **COMPLETED (LRUCache Implementation)**

**Decision**: Implemented in-memory LRUCache using existing "lru-cache" package for optimal performance

**Rationale**:
- Redis free tier has memory limitations (25-50MB) that could impact rate limiting
- LRUCache leverages existing package already used in codebase (book.ts)
- Automatic TTL management and LRU eviction handled by library
- Progress events are temporary (5-minute TTL) and don't require persistence
- No additional cost or dependencies
- Easy to migrate to Redis when scaling to multi-server deployments

**Implementation**:
```typescript
// src/utils/progress-tracking.ts
import { LRUCache } from 'lru-cache';

const progressEventCache = new LRUCache<string, ActionProgressEvent[]>({
  max: 100, // Support up to 100 concurrent generations
  ttl: 5 * 60 * 1000, // 5 minutes
});

export async function storeActionProgressEvent(
  pageId: string, 
  event: ActionProgressEvent
): Promise<void> {
  const cacheKey = `progress:${pageId}`;
  const existingEvents = progressEventCache.get(cacheKey) || [];
  progressEventCache.set(cacheKey, [...existingEvents, event]);
}

export async function getActionProgressEvents(
  pageId: string
): Promise<ActionProgressEvent[]> {
  const cacheKey = `progress:${pageId}`;
  const events = progressEventCache.get(cacheKey) || [];
  progressEventCache.delete(cacheKey); // Cleanup after retrieval
  return events;
}
```

**Benefits of LRUCache**:
- ✅ Automatic TTL management (no manual cleanup needed)
- ✅ LRU eviction when cache is full (prevents memory bloat)
- ✅ Consistent with existing codebase patterns (book.ts)
- ✅ Production-tested library with proven reliability
- ✅ Memory-efficient (max 100 concurrent generations)
- ✅ Fast in-memory operations with no network overhead

**Migration Path to Redis** (when needed):
- When scaling to multi-server deployments
- When high concurrent users (>100 simultaneous generations)
- When paid Redis tier with guaranteed memory allocation is available

**Expected Outcomes**:
- ✅ Real-time per-action progress updates via SSE
- ✅ Progress percentage and completion tracking
- ✅ Error visibility for failed actions
- ✅ Enhanced user experience during generation
- ✅ No impact on Redis rate limiting
- ✅ Zero additional cost for free-tier deployment
- ✅ Automatic memory management via LRUCache

**Timeline**: ✅ **COMPLETED**
**Priority**: High (Direct user impact)

**Monitoring Guidance**:
- Monitor memory usage of `progressEventCache` in production
- Track number of concurrent generation requests
- Set up alerts if cache hit rate drops significantly
- Monitor cache eviction rate (LRUCache provides metrics)
- Consider increasing `max` size if concurrent generations exceed 100
- Log cache operations for debugging and performance analysis

---

### Phase 3: Frontend Integration - ✅ **COMPLETED**

**Objective**: Update frontend to handle and display per-action progress events

#### 3.1 Type System Updates - ✅ **IMPLEMENTED**
```typescript
// src/lib/types/api.ts
export interface ActionProgressEvent {
  action: string;
  status: 'started' | 'completed' | 'failed';
  completed: number;
  total: number;
  progress: number; // 0-100
  error?: string;
  timestamp: string;
}
```

#### 3.2 Enhanced SSE Client - ✅ **IMPLEMENTED**
```typescript
// src/lib/services/books-api.ts
generateCandidates(
  identifier: string,
  pageId: string,
  onProgress?: (event: ActionProgressEvent) => void
): Promise<GetCandidatesResponse> {
  // SSE event types per backend API docs
  type CandidatesSSEEvent =
    | { type: 'progress'; status: 'waiting'; message: string }
    | { type: 'action_progress'; action: string; status: 'started' | 'completed' | 'failed'; completed: number; total: number; progress: number; error?: string; timestamp: string }
    | { type: 'complete'; ... }
    | { type: 'timeout'; ... }
    | { type: 'error'; ... };

  const lastEvent = await fetchSSEStream<CandidatesSSEEvent, undefined>(...);
  // Handle action_progress events
  if (event.type === 'action_progress') {
    onProgress?.(event as ActionProgressEvent);
    devConsole.log('[generateCandidates] 📊 Action progress:', event);
  }
}
```

#### 3.3 Progress UI Component - ✅ **IMPLEMENTED**
```typescript
// src/components/reader/CandidateGenerationProgress.tsx
export function CandidateGenerationProgress({
  isGenerating,
  overallProgress,
  actionProgress,
  error,
}: CandidateGenerationProgressProps) {
  // Overall progress bar with percentage
  // Per-action status with icons (✅ ❌ ⏳)
  // Error display for failed actions
  // Dark mode support
}
```

#### 3.4 ReaderPage Integration - ✅ **IMPLEMENTED**
```typescript
// src/app/books/[slug]/[pageId]/ReaderPageClient.tsx
const [isGenerating, setIsGenerating] = useState(false);
const [actionProgress, setActionProgress] = useState<Map<string, ActionProgressEvent>>(new Map());
const [overallProgress, setOverallProgress] = useState<{ completed: number; total: number }>({ completed: 0, total: 0 });
const [generationError, setGenerationError] = useState<string | undefined>();

const candidatesResponse = await booksApi.generateCandidates(
  bookSlug,
  page.id,
  (event: ActionProgressEvent) => {
    setActionProgress(prev => new Map(prev.set(event.action, event)));
    setOverallProgress({ completed: event.completed, total: event.total });
  }
);

// Render progress component
<CandidateGenerationProgress
  isGenerating={isGenerating}
  overallProgress={overallProgress}
  actionProgress={actionProgress}
  error={generationError}
/>
```

**Expected Outcomes**:
- ✅ Real-time progress indicators in UI
- ✅ Per-action status visibility with icons
- ✅ Enhanced user engagement during generation
- ✅ Better error visibility and debugging
- ✅ Dark mode support
- ✅ Clean, minimal UI that fits within reader interface

**Timeline**: ✅ **COMPLETED**
**Priority**: High (User-facing improvements)

**Implementation Details**:
- Added `ActionProgressEvent` type to `src/lib/types/api.ts`
- Updated `BooksApi.generateCandidates()` to accept optional `onProgress` callback
- Added `action_progress` event type handling in SSE stream processing
- Created `CandidateGenerationProgress` component with:
  - Overall progress bar with percentage display
  - Per-action status list with emoji indicators
  - Error display for failed actions
  - Dark mode support via Tailwind classes
- Integrated progress component into `ReaderPageClient` with:
  - State management for generation status, progress, and errors
  - Progress callback integration with `booksApi.generateCandidates()`
  - Conditional rendering based on generation state
- Progress state is reset when generation starts and cleared on completion/error

**Files Modified**:
- `src/lib/types/api.ts` - Added ActionProgressEvent interface
- `src/lib/services/books-api.ts` - Added onProgress callback and action_progress event handling
- `src/components/reader/CandidateGenerationProgress.tsx` - New component for progress display
- `src/app/books/[slug]/[pageId]/ReaderPageClient.tsx` - Integrated progress tracking and UI

---

### Phase 4: Advanced Features & Analytics

**Objective**: Add advanced monitoring, retry mechanisms, and analytics

#### 4.1 Individual Action Retry
```typescript
// src/utils/candidate-generation.ts
export interface RetryableAction {
  action: Action;
  error: unknown;
  retryCount: number;
  maxRetries: number;
}

export async function retryFailedActions(
  userId: string,
  page: UserStoryPage,
  failedActions: RetryableAction[],
  onProgress?: (action: Action, status: 'retrying' | 'completed' | 'failed', result?: PersistedStoryPage, error?: unknown) => void
): Promise<CandidateGenerationResult[]> {
  const retryResults = await Promise.allSettled(
    failedActions.map(({ action, retryCount }) => 
      retryWithBackoffOrNull(
        () => generateCandidatePage({...}),
        {
          maxRetries: MAX_BRANCHING_RETRIES - retryCount,
          baseDelayMs: 2000, // Longer delay for retries
          maxDelayMs: 8000,
          onRetry: (attempt, error) => {
            onProgress?.(action, 'retrying', undefined, error);
          }
        }
      )
    )
  );
  
  return retryResults.map((result, index) => ({
    action: failedActions[index].action,
    success: result.status === 'fulfilled' && result.value !== null,
    candidatePage: result.status === 'fulfilled' ? result.value : null,
    error: result.status === 'rejected' ? result.reason : null
  }));
}
```

#### 4.2 Performance Analytics
```typescript
// src/utils/analytics.ts
export interface GenerationMetrics {
  pageId: string;
  userId: string;
  totalActions: number;
  successfulActions: number;
  failedActions: number;
  averageGenerationTime: number;
  totalGenerationTime: number;
  actionMetrics: ActionMetric[];
  timestamp: string;
}

export interface ActionMetric {
  action: string;
  status: 'completed' | 'failed';
  generationTime: number;
  retryCount: number;
  errorType?: string;
}

export async function recordGenerationMetrics(metrics: GenerationMetrics): Promise<void> {
  // Store in analytics database or logging system
  console.log(`[Analytics] 📊 Generation metrics for page ${metrics.pageId}:`, {
    successRate: (metrics.successfulActions / metrics.totalActions) * 100,
    averageTime: metrics.averageGenerationTime,
    failedCount: metrics.failedActions
  });
}
```

#### 4.3 Enhanced Monitoring Dashboard
```typescript
// src/api/admin/generation-metrics.ts
router.get('/admin/generation-metrics', requireAuth, async (req: Request, res: Response) => {
  try {
    const metrics = await getGenerationMetrics({
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
      userId: req.query.userId as string
    });
    
    res.json({
      summary: {
        totalGenerations: metrics.length,
        averageSuccessRate: calculateAverageSuccessRate(metrics),
        averageGenerationTime: calculateAverageGenerationTime(metrics)
      },
      metrics: metrics.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 100)
    });
  } catch (error) {
    handleApiError(res, "Failed to fetch generation metrics", error);
  }
});
```

**Expected Outcomes**:
- Automatic retry for failed individual actions
- Comprehensive generation analytics
- Performance monitoring and optimization insights
- Admin dashboard for generation health

**Timeline**: 3-4 weeks
**Priority**: Medium (Operational improvements)

---

## Implementation Considerations

### Performance Impact
- **Minimal Overhead**: Callback emissions add <1ms to generation time
- **SSE Efficiency**: Lightweight JSON messages (~100 bytes each)
- **Database Impact**: Optional progress storage uses Redis with TTL

### Backward Compatibility
- **Optional Callbacks**: All new parameters are optional
- **Graceful Degradation**: Existing SSE polling continues to work
- **Progressive Enhancement**: Features can be rolled out incrementally

### Error Handling
- **Callback Safety**: Try-catch around all callback invocations
- **SSE Resilience**: Handle client disconnections gracefully
- **Retry Isolation**: Failed retries don't affect other actions

### Scalability Considerations
- **Memory Usage**: Progress events are short-lived (5-minute TTL)
- **Concurrent Limits**: Distributed locking prevents overload
- **Rate Limiting**: SSE connections limited per user

## Success Metrics

### User Experience Metrics
- **Perceived Performance**: User satisfaction with generation feedback
- **Error Visibility**: Reduced support tickets for generation issues
- **Engagement**: Higher completion rates for story navigation

### Technical Metrics
- **Generation Success Rate**: Target >95% with retry mechanism
- **Average Generation Time**: Maintain <30 seconds per action
- **SSE Connection Stability**: <1% disconnection rate

### Operational Metrics
- **Monitoring Coverage**: 100% of generation events tracked
- **Alert Response Time**: <5 minutes for critical issues
- **Performance Regression**: <5% increase in generation time

## Risk Assessment & Mitigation

### High Risk
- **SSE Connection Overload**: Implement connection limits and monitoring
- **Callback Performance Issues**: Add timeout protection and error boundaries

### Medium Risk
- **Frontend Compatibility**: Test across browsers and devices
- **Database Performance**: Monitor progress storage impact

### Low Risk
- **User Interface Complexity**: Iterative design and user testing
- **Analytics Storage Costs**: Implement data retention policies

## Timeline Summary

| Phase | Duration | Start Date | End Date | Key Deliverables |
|-------|----------|------------|----------|------------------|
| Phase 1 | 1-2 weeks | Week 1 | Week 2 | Progress callback system |
| Phase 2 | 2-3 weeks | Week 3 | Week 5 | SSE integration |
| Phase 3 | 2-3 weeks | Week 6 | Week 8 | Frontend updates |
| Phase 4 | 3-4 weeks | Week 9 | Week 12 | Advanced features |

**Total Timeline**: 12 weeks (3 months)

## Dependencies

### Technical Dependencies
- **Redis**: For progress event storage (optional)
- **SSE Support**: Browser compatibility testing
- **Monitoring Tools**: Analytics dashboard infrastructure

### Team Dependencies
- **Frontend Team**: React component updates
- **Backend Team**: SSE and callback implementation
- **DevOps Team**: Monitoring and alerting setup

## Conclusion

This enhancement roadmap provides a comprehensive approach to improving the candidate generation system with real-time progress tracking. The phased implementation ensures minimal risk while delivering significant user experience improvements.

The key benefits include:
- **Enhanced User Experience**: Real-time feedback during generation
- **Better Monitoring**: Granular visibility into generation performance
- **Improved Reliability**: Automatic retry mechanisms for failed actions
- **Operational Insights**: Comprehensive analytics for optimization

The implementation maintains backward compatibility while providing a foundation for future enhancements in the candidate generation system.
