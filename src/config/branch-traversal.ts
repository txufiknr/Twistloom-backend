/**
 * Branch Traversal Configuration
 * 
 * Configurable constants for branch traversal reliability enhancements,
 * retry logic, circuit breaker settings, and performance tuning.
 */

// ============================================================================
// CIRCUIT BREAKER CONFIGURATION
// ============================================================================

/** Number of failures before opening circuit for getStoryState operations */
export const GET_STORY_STATE_CIRCUIT_THRESHOLD = 3;

/** Timeout in milliseconds for getStoryState circuit breaker */
export const GET_STORY_STATE_CIRCUIT_TIMEOUT = 30000;

/** Number of failures before opening circuit for getBranchPath operations */
export const GET_BRANCH_PATH_CIRCUIT_THRESHOLD = 5;

/** Timeout in milliseconds for getBranchPath circuit breaker */
export const GET_BRANCH_PATH_CIRCUIT_TIMEOUT = 60000;

/** Number of failures before opening circuit for getPageById operations */
export const GET_PAGE_BY_ID_CIRCUIT_THRESHOLD = 3;

/** Timeout in milliseconds for getPageById circuit breaker */
export const GET_PAGE_BY_ID_CIRCUIT_TIMEOUT = 30000;

/** Number of failures before opening circuit for getBook operations */
export const GET_BOOK_CIRCUIT_THRESHOLD = 3;

/** Timeout in milliseconds for getBook circuit breaker */
export const GET_BOOK_CIRCUIT_TIMEOUT = 30000;

/** Number of failures before opening circuit for getDelta operations */
export const GET_DELTA_CIRCUIT_THRESHOLD = 5;

/** Timeout in milliseconds for getDelta circuit breaker */
export const GET_DELTA_CIRCUIT_TIMEOUT = 30000;

// ============================================================================
// RETRY CONFIGURATION
// ============================================================================

/** Maximum number of retry attempts for branch path operations */
export const BRANCH_PATH_MAX_RETRIES = 3;

/** Base delay in milliseconds for branch path retry operations */
export const BRANCH_PATH_BASE_DELAY = 1000;

/** Maximum number of retry attempts for snapshot selection operations */
export const SNAPSHOT_SELECTION_MAX_RETRIES = 2;

/** Base delay in milliseconds for snapshot selection retry operations */
export const SNAPSHOT_SELECTION_BASE_DELAY = 500;

/** Maximum number of retry attempts for delta application operations */
export const DELTA_APPLICATION_MAX_RETRIES = 2;

/** Base delay in milliseconds for delta application retry operations */
export const DELTA_APPLICATION_BASE_DELAY = 200;

/** Maximum number of retry attempts for entire reconstruction process */
export const RECONSTRUCTION_MAX_RETRIES = 2;

/** Base delay in milliseconds for entire reconstruction retry operations */
export const RECONSTRUCTION_BASE_DELAY = 2000;

// ============================================================================
// DEFAULT CONFIGURATION
// ============================================================================

/** Default maximum number of retry attempts for operations */
export const DEFAULT_MAX_RETRIES = 3;

/** Default base delay in milliseconds for retry operations */
export const DEFAULT_BASE_DELAY = 1000;

/** Default circuit breaker failure threshold */
export const DEFAULT_CIRCUIT_THRESHOLD = 5;

/** Default circuit breaker timeout in milliseconds */
export const DEFAULT_CIRCUIT_TIMEOUT = 60000;

// ============================================================================
// CIRCUIT BREAKER KEY PREFIXES
// ============================================================================

/** Circuit breaker key prefix for getStoryState operations */
export const GET_STORY_STATE_KEY_PREFIX = 'getStoryState';

/** Circuit breaker key prefix for getBranchPath operations */
export const GET_BRANCH_PATH_KEY_PREFIX = 'getBranchPath';

/** Circuit breaker key prefix for getPageById operations */
export const GET_PAGE_BY_ID_KEY_PREFIX = 'getPageById';

/** Circuit breaker key prefix for getBook operations */
export const GET_BOOK_KEY_PREFIX = 'getBook';

/** Circuit breaker key prefix for getDelta operations */
export const GET_DELTA_KEY_PREFIX = 'getDelta';

/** Circuit breaker key prefix for createDelta operations */
export const CREATE_DELTA_KEY_PREFIX = 'createDelta';

/** Circuit breaker key prefix for getStateSnapshot operations */
export const GET_SNAPSHOT_KEY_PREFIX = 'getStateSnapshot';

/** Circuit breaker key prefix for createStateSnapshot operations */
export const CREATE_SNAPSHOT_KEY_PREFIX = 'createStateSnapshot';

// ============================================================================
// DELTA SERVICE CONFIGURATION
// ============================================================================

/** Number of failures before opening circuit for delta creation operations */
export const CREATE_DELTA_CIRCUIT_THRESHOLD = DEFAULT_CIRCUIT_THRESHOLD;

/** Timeout in milliseconds for delta creation circuit breaker */
export const CREATE_DELTA_CIRCUIT_TIMEOUT = 15000; // Keep shorter timeout for write operations

/** Maximum number of retry attempts for delta operations */
export const DELTA_MAX_RETRIES = DEFAULT_MAX_RETRIES;

/** Base delay in milliseconds for delta retry operations */
export const DELTA_BASE_DELAY = DEFAULT_BASE_DELAY;

// ============================================================================
// SNAPSHOT SERVICE CONFIGURATION
// ============================================================================

/** Number of failures before opening circuit for snapshot retrieval operations */
export const GET_SNAPSHOT_CIRCUIT_THRESHOLD = DEFAULT_CIRCUIT_THRESHOLD;

/** Timeout in milliseconds for snapshot retrieval circuit breaker */
export const GET_SNAPSHOT_CIRCUIT_TIMEOUT = DEFAULT_CIRCUIT_TIMEOUT;

/** Number of failures before opening circuit for snapshot creation operations */
export const CREATE_SNAPSHOT_CIRCUIT_THRESHOLD = DEFAULT_CIRCUIT_THRESHOLD;

/** Timeout in milliseconds for snapshot creation circuit breaker */
export const CREATE_SNAPSHOT_CIRCUIT_TIMEOUT = 20000; // Keep shorter timeout for write operations

/** Maximum number of retry attempts for snapshot operations */
export const SNAPSHOT_MAX_RETRIES = DEFAULT_MAX_RETRIES;

/** Base delay in milliseconds for snapshot retry operations */
export const SNAPSHOT_BASE_DELAY = DEFAULT_BASE_DELAY;
