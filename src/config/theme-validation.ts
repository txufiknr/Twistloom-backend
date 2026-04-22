/**
 * Theme Validation Configuration Constants
 * 
 * Contains blacklist words, suspicious patterns, and validation rules
 * for theme input validation. These constants align with frontend
 * specifications to ensure consistent content filtering.
 * 
 * References:
 * - Frontend: src/lib/config/form.ts (THEME_BLACKLIST, THEME_SUSPICIOUS_PATTERNS)
 * - Spec: docs/THEME_VALIDATION_GUIDE.md
 */

/**
 * Blacklist words for inappropriate content
 * 
 * Categories:
 * - Sexual content
 * - Hate speech
 * - Drugs
 * - Religious sensitive names
 * - Public figures
 * 
 * Note: Combined from frontend (src/lib/config/form.ts) and backend for comprehensive coverage
 */
export const THEME_BLACKLIST: readonly string[] = [
  // Sexual content
  'porn',
  'pornography',
  'sexually explicit',
  'nsfw',
  'erotic',
  'rape',
  'incest',
  'bestiality',
  'pedophilia',
  'sexual assault',
  'nude',
  'naked',
  'orgasm',
  'fetish',
  'bondage',
  
  // Hate speech
  'hate speech',
  'racist',
  'nazi',
  'white supremacist',
  'antisemitic',
  'homophobic',
  'transphobic',
  'kkk',
  
  // Drugs
  'drug abuse',
  'overdose',
  'heroin',
  'cocaine',
  'meth',
  'crack',
  'lsd',
  
  // Religious figures (sensitive)
  'muhammad',
  'prophet muhammad',
  'jesus christ',
  'buddha',
  'vishnu',
  'shiva',
  'krishna',
  'allah',
  'god',
  'yahweh',
  'jehovah',
  'moses',
  'abraham',
  'isaac',
  'jacob',
  'joseph',
  'mary',
  'virgin mary',
  'pope',
  'dalai lama',
  
  // Public figures and political leaders
  'joe biden',
  'donald trump',
  'barack obama',
  'george w. bush',
  'bill clinton',
  'george h.w. bush',
  'ronald reagan',
  'jimmy carter',
  'richard nixon',
  'john f. kennedy',
  'franklin d. roosevelt',
  'vladimir putin',
  'xi jinping',
  'kim jong un',
  'emmanuel macron',
  'olaf scholz',
  'rishisunak',
  'justin trudeau',
  'jair bolsonaro',
  'nelson mandela',
  'mahatma gandhi',
  'winston churchill',
  'queen elizabeth',
  'king charles',
  'prince william',
  'prince harry',
] as const;

/**
 * Suspicious patterns for security threats
 * 
 * Categories:
 * - SQL injection
 * - HTML/JavaScript injection
 * - Code execution
 * - Shell commands
 * - Base64 encoded content
 * - Dangerous URL schemes
 * 
 * Note: Combined from frontend (src/lib/config/form.ts) and backend for comprehensive coverage
 */
export const THEME_SUSPICIOUS_PATTERNS: readonly RegExp[] = [
  // SQL injection patterns (comprehensive)
  /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|EXEC|EXECUTE|ALTER|CREATE|TRUNCATE)\b.*\b(FROM|INTO|TABLE|WHERE|DATABASE)\b)/i,
  /(--|;|\/\*|\*\/|xp_|sp_)/,
  /(\bOR\b.*=.*=|\bAND\b.*=.*=)/i,
  /SELECT\s+.*\s+FROM/i,
  /DROP\s+TABLE/i,
  /UNION\s+SELECT/i,
  /INSERT\s+INTO/i,
  /UPDATE\s+.*\s+SET/i,
  /DELETE\s+FROM/i,
  /;\s*--/,
  
  // HTML/JavaScript injection (comprehensive)
  /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
  /<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi,
  /<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi,
  /<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi,
  /<script[^>]*>/i,
  /<\/script>/i,
  /<iframe[^>]*>/i,
  /javascript:/i,
  /on\w+\s*=/i,
  
  // Code execution patterns (comprehensive)
  /\beval\s*\(/i,
  /\bexec\s*\(/i,
  /\bsystem\s*\(/i,
  /\bpopen\s*\(/i,
  /\bshell_exec\s*\(/i,
  /\bdocument\.write\s*\(/i,
  /\binnerHTML\s*=/i,
  /`[^`]*`/, // Backticks for command substitution
  
  // Shell command patterns (comprehensive)
  /(rm\s+-rf|chmod|chown|sudo|su\s+-)/,
  /(\|&&|\|\||;)/,
  /rm\s+-rf/i,
  /sudo\s+/i,
  /chmod\s+/i,
  /\|\s*rm/i,
  
  // URL schemes that could be dangerous
  /(data:|vbscript:|file:)/i,
  /data:\s*text\/html/i,
  /vbscript:/i,
  /file:/i,
] as const;

/**
 * POV instruction patterns (invalid - only 1st person allowed)
 * 
 * Twistloom strictly generates 1st person POV stories.
 * Any explicit non-1st person POV instruction must be rejected.
 * 
 * Invalid POV keywords:
 * - third person
 * - second person
 * - omniscient
 * - objective
 * - multiple perspectives
 * - outside observer
 * - bird's eye view
 * - narrate from outside
 */
export const INVALID_POV_PATTERNS: readonly RegExp[] = [
  /third\s+person/i,
  /second\s+person/i,
  /omniscient/i,
  /objective\s+point\s+of\s+view/i,
  /multiple\s+perspectives/i,
  /outside\s+observer/i,
  /bird['']?s\s+eye\s+view/i,
  /narrate\s+from\s+outside/i,
  /tell\s+(it|this)\s+as\s+if\s+observing/i,
  /switch\s+between\s+different\s+POVs/i,
] as const;

/**
 * Invalid theme patterns (gibberish, non-story content)
 * 
 * Patterns for detecting inputs that are not valid story themes:
 * - Gibberish or random text
 * - Single words with no context
 * - Non-story content (hello world, test, etc.)
 * - Questions instead of themes
 * - Commands/instructions
 * - Too short/insufficient detail
 * - Completely unrelated phrases
 * - Repetitive characters
 * - URLs, email addresses, phone numbers
 * - Code snippets or technical jargon unrelated to stories
 */
export const INVALID_THEME_PATTERNS: readonly RegExp[] = [
  // Gibberish (repeated characters)
  /(.)\1{4,}/, // 5+ repeated characters
  
  // Single word with no context (too short)
  /^(?!.*\s).{1,15}$/, // Single word < 16 chars
  
  // Questions instead of themes
  /^(how|what|why|when|where|who)\s+(do|does|did|is|are|was|were)\s+/i,
  
  // Commands/instructions
  /^(generate|create|make|write)\s+(something|it|a story)\s*$/i,
  
  // Test strings
  /^(test|hello world|asdf|xyz|abc)\s*$/i,
  
  // Email addresses
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  
  // Phone numbers
  /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/,
  
  // URLs
  /https?:\/\/[^\s]+/,
] as const;

/**
 * Minimum theme length (characters)
 * 
 * Themes shorter than this are considered invalid due to insufficient detail.
 */
export const MIN_THEME_LENGTH = 10;

/**
 * Maximum theme length (characters)
 * 
 * Themes longer than this are rejected to prevent abuse and ensure
 * AI processing efficiency.
 * 
 * Note: Matches frontend THEME_MAX_LENGTH (3000) for consistency
 */
export const MAX_THEME_LENGTH = 3000;

/** Maximum theme length in theme generator (sometimes AI can exceeds the limit instruction, so this give some safe buffer) */
export const MAX_THEME_LENGTH_PROMPT = 2500;
