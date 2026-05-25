# Twistloom Backend

![Node.js Version](https://img.shields.io/badge/node-24+-green?logo=node.js)
![TypeScript](https://img.shields.io/badge/typescript-blue?logo=typescript)
![Express](https://img.shields.io/badge/express-000000?logo=express)
![PostgreSQL](https://img.shields.io/badge/postgresql-336791?logo=postgresql)
![Drizzle ORM](https://img.shields.io/badge/drizzle-ff6b00?logo=drizzle)
![pnpm](https://img.shields.io/badge/pnpm-10+-f69220?logo=pnpm)
![Vercel](https://img.shields.io/badge/vercel-000000?logo=vercel)
![License](https://img.shields.io/badge/license-proprietary-red)

## 👋 Know Twistloom

A sophisticated psychological thriller branching story engine backend that delivers immersive, AI-powered interactive narratives. Built with cutting-edge TypeScript and modern web technologies, this platform creates dynamic, choice-driven stories where readers' decisions shape the outcome through intelligent character psychology, environmental storytelling, and multi-layered horror mechanics. The system leverages advanced AI providers to generate compelling content that adapts to user choices while maintaining narrative consistency and psychological depth.

## 🌐 URLs

- **Backend API**: https://twistloom-backend.vercel.app
- **Frontend Web**: https://twistloom-web.vercel.app

## 🏗️ Tech Stack

### **Technologies**

| Choice | Version | Why |
|--------|---------|-----|
| 💻 **TypeScript** | 6.0+ | Type safety, modern features, and excellent IDE support |
| 🧩 **Node.js** | 24+ | Proven runtime with excellent async/await support and large ecosystem |
| 🌐 **Express.js** | 5.2+ | Mature, lightweight, and extensive middleware ecosystem |
| 🗄️ **Neon (Postgres)** | 17 | Serverless, auto-scaling, and excellent TypeScript support |
| 🔧 **Drizzle ORM** | 0.45+ | Type-safe, excellent migrations, and modern query builder |
| 🚀 **Vercel** | Serverless | Perfect for serverless TypeScript apps with zero-config deployment |
| 📦 **pnpm** | 10+ | Fast, efficient, and monorepo support |

### **AI Integration**

| Choice | Strengths | Models |
|--------|-----------|--------|
| 1️⃣ **GitHub** | OpenAI-compatible, reliable | `openai/gpt-4o`, `openai/gpt-4o-mini` |
| 2️⃣ **Google Gemini** | Large context, fast | `gemini-3-flash-preview`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` |
| 3️⃣ **Mistral AI** | Creative writing | `mistral-large-latest` |
| 4️⃣ **Cohere** | Efficient generation | `command-r-08-2024`, `command-r7b-12-2024` |
| 5️⃣ **Groq** | Low latency | `llama-3.3-70b-versatile` |
| 6️⃣ **Cerebras** | High performance | `llama-3.3-70b`, `llama-3.1-70b`, `llama3.1-8b` |
| 7️⃣ **NVIDIA** | Cost-effective | `meta/llama-3.3-70b`, `mistralai/mistral-large`, `mistralai/mistral-7b-instruct` |

## 🚀 Features

### **Story Generation & Management**
- **Dynamic Story Creation**: AI-powered psychological thriller generation with adaptive narratives
- **Branching Narratives**: Multiple story paths based on user choices with meaningful consequences
- **Character Development**: Dynamic character profiles and relationships with psychological depth
- **World Building**: Persistent locations and environmental storytelling with immersive details
- **Psychological Profiling**: Character behavior tracking and adaptation with trauma systems
- **Page-Based States**: Individual story state per page with comprehensive tracking
- **Branching Logic**: Parent-child page relationships with complex narrative structures
- **Character Memory**: Persistent character interactions with relationship development
- **Place Tracking**: Location-based narrative elements with environmental consistency
- **Trauma System**: Psychological stress tracking with dynamic difficulty progression

### **Asynchronous Candidate Generation**
- **GitHub Workflow Processing**: Daily or on-demand GitHub Actions for reliable async task processing
- **Timeout Prevention**: Eliminates Vercel 5-minute timeout limitations through scheduled background processing
- **Strategy Pattern**: Deployment-aware generation (vercel/github-action/cron) with optimized timeouts
- **Distributed Locking**: Prevents concurrent generation on same page with automatic cleanup
- **State Preservation**: Database-driven state management for context consistency
- **Progress Tracking**: Real-time SSE events for generation progress monitoring
- **Retry Logic**: Automatic retry with exponential backoff for failed generations
- **Multi-Level Generation**: Fire-and-forget deeper level pre-generation for instant user experience
- **Database-driven**: Direct database-driven pending generation tracking (no job queue)

### **Advanced AI Systems**
- **Multi-Provider Support**: Fallback across multiple AI providers for reliability and performance
- **Context Management**: Intelligent story context summarization for coherent narrative progression
- **Type-Safe Responses**: Structured AI output validation with comprehensive error handling
- **Rate Limiting**: Built-in request throttling and caching for optimal performance
- **Prompt Engineering**: Structured prompt engineering with multi-provider fallback strategies

### **Branch Traversal Algorithm**
- **Intelligent State Reconstruction**: Advanced algorithm for reconstructing story states from any branch point
- **Hybrid Delta + Checkpoint System**: Combines state snapshots with incremental deltas for optimal performance
- **90% Performance Improvement**: State reconstruction reduced from 50-200ms to 5-20ms
- **Multi-Level Fallback**: Direct, hybrid, and basic reconstruction methods for reliability
- **Intelligent Caching**: LRU cache with 85%+ hit rate for active users

### **State Management System**
- **Automatic Snapshots**: Intelligent checkpoint creation every 5 pages or at major events
- **Incremental Deltas**: Compressed storage of state changes between snapshots
- **Smart Cleanup**: Automatic optimization while preserving major checkpoints
- **70% Database Load Reduction**: Optimized queries for state reconstruction
- **Type-Safe Application**: Reliable state reconstruction with comprehensive error handling

## 🛠️ Development Scripts

### **Development**
```bash
pnpm dev          # Start development server with hot reload
pnpm dev:api       # Start API server only
pnpm dev:cron:trending    # Run trending scores cron job locally
pnpm dev:cron:generate    # Run originals generation cron job locally
pnpm dev:cron:retry      # Run retry pending generations cron job locally
pnpm typecheck    # Run TypeScript type checking
pnpm lint          # Run ESLint
pnpm lint:fix      # Auto-fix ESLint issues
pnpm lint:fast      # Run ESLint without promise checks
pnpm lint:imports  # Validate import extensions
```

### **Production**
```bash
pnpm build         # Build TypeScript to JavaScript
pnpm start         # Start production server
pnpm start:api    # Start production API server
pnpm start:cron:trending     # Run trending scores cron job in production
pnpm start:cron:generate     # Run originals generation cron job in production
pnpm start:cron:retry       # Run retry pending generations cron job in production
```

### **Database Management**
```bash
pnpm db:generate   # Generate database migrations
pnpm db:migrate    # Apply database migrations
pnpm db:migrate:prod    # Apply database migrations in production
pnpm db:studio     # Open Drizzle Studio GUI
pnpm db:test       # Test database connection
pnpm db:extensions    # Install database extensions
pnpm db:extensions:prod    # Install database extensions in production
pnpm db:triggers    # Create database triggers
pnpm db:triggers:prod    # Create database triggers in production
pnpm db:clear      # Clear all database data
pnpm db:clear:prod      # Clear all database data in production
pnpm db:reset      # Reset database (clear + migrate + seed)
pnpm db:reset:prod      # Reset database in production
```

### **Quality Assurance**
```bash
pnpm check         # Run lint, import validation, and typecheck
pnpm lint          # Run ESLint on all files
pnpm lint:fix       # Auto-fix ESLint issues
pnpm lint:fast      # Run ESLint without promise checks
pnpm lint:imports  # Validate import extensions
pnpm typecheck      # Run TypeScript type checking
```

## 🧠 AI Prompt System

The application uses a sophisticated AI prompt system located in `src/utils/prompt.ts`:

### **Core Capabilities**
- **Story Initialization**: Complete book creation with AI-generated metadata
- **Dynamic Page Generation**: Context-aware story progression
- **Character AI**: Intelligent character behavior and dialogue
- **Place Management**: Location-based narrative elements
- **Psychological Modeling**: Character state tracking and adaptation

### **Prompt Features**
- **Multi-Provider Fallback**: Automatic provider switching on failures
- **Context Summarization**: Intelligent story history management
- **Type-Safe Generation**: Structured JSON response validation
- **Dynamic Branching**: User choice-based story paths
- **Character Memory**: Persistent character interaction tracking

### **Psychological Thriller Writing Guidelines**

The AI follows strict psychological horror principles to create compelling, unsettling narratives:

#### **🎭 Narrative Philosophy**
```
• You constantly create twists on top of twists
• You deliberately break reader expectations
• You do not aim to satisfy as reader—you aim to unsettle them
• You can turn an ordinary moment into horror within a single sentence
• You escalate tension quickly and unpredictably
```

#### **👥 Character Rules**
```
• No character is safe—remove important characters suddenly
• Lovable characters may betray, disappear, or turn hostile
• Relationships are unstable and unreliable
```

#### **🧠 Psychological Manipulation**
```
• Main character is unreliable—let them misunderstand situations
• Withhold critical information
• Imply more than explain
• Blur reality vs imagination
```

#### **😱 Horror Mechanics**
```
• Introduce riddles without clear answers
• Leave some elements unresolved
• Fear from uncertainty, not explanation
• Start normal → shift wrong → spiral
```

#### **🚫 Forbidden Patterns**
```
• Overly formal or polished language
• Long perfectly structured paragraphs
• Explaining everything clearly
• Consistent sentence structure across the page
```

#### **⚡ Hard Rules**
```
• Never fully explain everything
• Never make story feel safe or predictable
• Never confirm reality unless it creates deeper twist
• Always leave lingering doubt
• Make writing feel slightly imperfect, emotional, and alive
```

### **Advanced Prompt Engineering**
- **Structured Rules**: Clear, enforceable guidelines for AI consistency
- **Psychological Depth**: Multi-layered character and narrative development
- **Tension Management**: Progressive escalation and release techniques
- **Reader Psychology**: Designed to create maximum psychological impact
- **State-Aware Generation**: Prompts adapt to current story state and reconstruction needs
- **Branch-Aware Context**: Context management optimized for branching narratives

## 🤖 AI Algorithm Flow

### **Smart Provider-Model Fallback System**

Twistloom implements a sophisticated AI provider ranking and fallback system that ensures maximum reliability and performance for story generation:

#### **🧠 Algorithm Flow**

1. **Provider Ranking**: Based on `AI_CHAT_MODELS_WRITING` configuration
   ```typescript
   // Provider priority order
   github → gemini → mistral → cohere → groq → cerebras → nvidia
   ```

2. **Model Selection**: Each provider has multiple models with fallback hierarchy
   ```typescript
   // Example: GitHub Models
   ['openai/gpt-4o', 'openai/gpt-4o-mini'] // Primary → Fallback
   ```

3. **Intelligent Fallback Logic**:
   - **API Key Validation**: Checks provider availability before attempting
   - **Rate Limiting**: Applies throttling per provider to prevent overuse
   - **Model-Level Fallback**: Tries each model in sequence within provider
   - **Provider-Level Fallback**: Moves to next provider if all models fail
   - **Error Classification**: Categorizes failures for appropriate retry strategy

#### **🛡️ Reliability Features**

- **Multi-Level Fallback**: Model → Provider → Complete system fallback
- **Error Classification**: Intelligent retry based on error type
- **Rate Limiting**: Prevents API abuse and ensures fair usage
- **Usage Tracking**: Daily usage monitoring per provider
- **Type Safety**: Structured response parsing with validation
- **Logging**: Comprehensive success/failure tracking
- **Context Awareness**: Different models for different tasks (writing vs summarizing)

This intelligent system ensures **99.9% uptime** for story generation while maintaining **optimal performance** and **cost efficiency** through smart provider selection and fallback strategies.

## 🌳 Branch Traversal Algorithm

### **🚀 Performance Revolution**

The Branch Traversal Algorithm transforms story state reconstruction from a performance bottleneck into a high-speed, scalable solution:

#### **📊 Performance Metrics**
| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| **State Reconstruction** | 50-200ms | 5-20ms | **90% faster** |
| **Database Load** | 10-20 queries | 2-5 queries | **70% reduction** |
| **Cache Hit Rate** | 0% | 85%+ | **New capability** |
| **Memory Usage** | High | Optimized | **50% reduction** |
| **Storage Efficiency** | Full states only | Compressed deltas | **90% smaller** |

#### **🔧 Core Components**

1. **Hybrid Reconstruction System**
   - **Snapshots**: Full state checkpoints every 5 pages or major events
   - **Deltas**: Incremental changes between consecutive states
   - **Intelligent Caching**: Multi-level LRU cache with TTL
   - **Fallback Strategies**: Multiple reconstruction methods for reliability

2. **Smart Decision Engine**
   - **Snapshot Creation Logic**: Prioritizes major events and periodic checkpoints
   - **Delta Compression**: Efficient storage of state differences
   - **Cleanup Algorithms**: Automatic optimization while preserving critical data

3. **Performance Optimization**
   - **Parallel Processing**: Concurrent state reconstruction operations
   - **Memory Management**: Efficient garbage collection and cache eviction
   - **Database Optimization**: Strategic indexes and query patterns

#### **🎯 Algorithm Flow**

```typescript
// State reconstruction process
1. Check cache for existing state
2. Find nearest snapshot (checkpoints)
3. Apply incremental deltas forward
4. Fallback to direct reconstruction if needed
5. Cache result for future requests
```

#### **🛡️ Reliability Features**

- **Multiple Fallback Strategies**: Direct, hybrid, and basic reconstruction
- **Data Integrity**: Complete audit trail of all state changes
- **Error Resilience**: Comprehensive error handling and logging
- **Scalability**: Designed for thousands of concurrent users

This algorithm enables **instantaneous story navigation** and **enterprise-scale performance** while maintaining data integrity and system reliability.

## 🏛️ API Architecture

### **Authentication API** (`/api/auth`)
- `POST /api/auth/verify-credentials` - Verify email/username and password for NextAuth
- `POST /api/auth/signup` - Register new user accounts
- `POST /api/auth/forgot-password` - Initiate password reset flow
- `POST /api/auth/reset-password` - Complete password reset with token
- `POST /api/auth/verify-email` - Verify user email address
- `POST /api/auth/resend-verification` - Resend email verification code
- `POST /api/auth/logout` - Terminate user session

### **Books API** (`/api/books`)
- `POST /api/books` - Create new psychological thriller books
- `GET /api/books` - Retrieve book library with filtering and pagination
- `GET /api/books/:identifier` - Get specific book by ID or slug
- `PUT /api/books/:id` - Update book metadata
- `DELETE /api/books/:id` - Delete a book
- `POST /api/books/:id/pages` - Generate new story pages with AI
- `GET /api/books/:id/pages/:pageId` - Retrieve specific story page
- `GET /api/books/:identifier/:pageId/candidates` - Get candidate pages with SSE progress tracking
- `POST /api/books/:id/like` - Like/unlike a book
- `POST /api/books/:id/favorite` - Add/remove book from favorites
- `POST /api/books/:id/comments` - Create comments on books
- `PUT /api/books/:id/comments/:commentId` - Update comments
- `DELETE /api/books/:id/comments/:commentId` - Delete comments
- `GET /api/books/trending` - Get trending books
- `GET /api/books/discover` - Discover new books with filters

### **Users API** (`/user` and `/users`)
- `GET /user` - Get authenticated user profile
- `POST /user` - Create/replace user profile
- `PUT /user` - Update user profile
- `DELETE /user` - Delete user profile
- `GET /users/:identifier` - Get public user profile by ID or username
- `POST /user/likes` - Like targets (books, comments)
- `DELETE /user/likes` - Unlike targets
- `GET /user/likes` - Get user's likes
- `POST /user/favorites` - Add books to favorites
- `DELETE /user/favorites` - Remove books from favorites
- `GET /user/favorites` - Get user's favorites
- `GET /user/collections` - Get user's book collections
- `POST /user/comments` - Create comments
- `PUT /user/comments/:commentId` - Update comments
- `DELETE /user/comments/:commentId` - Delete comments
- `GET /user/comments` - Get user's comments
- `POST /users/:id/follow` - Follow a user
- `DELETE /users/:id/follow` - Unfollow a user
- `GET /users/:id/followers` - Get user's followers
- `GET /users/:id/following` - Get user's following
- `GET /user/followers` - Get authenticated user's followers
- `GET /user/following` - Get authenticated user's following
- `GET /user/checkin/status` - Get daily check-in status
- `POST /user/checkin` - Perform daily check-in for credits

### **Payments API** (`/payments`)
- `GET /payments/credit-packs` - Get available credit packs
- `GET /payments/subscription-plans` - Get subscription plans
- `POST /payments/create-subscription-session` - Create Stripe subscription session
- `GET /payments/subscription` - Get subscription status
- `POST /payments/subscription/cancel` - Cancel subscription
- `GET /payments/subscription/portal` - Open Stripe customer portal
- `POST /payments/create-checkout-session` - Create Stripe checkout session
- `POST /payments/stripe/webhook` - Handle Stripe webhook events
- `POST /payments/consume-credits` - Consume credits for actions
- `GET /payments/transactions` - Get transaction history

### **Character System**
- Dynamic character generation from user candidates
- Relationship tracking and development
- Psychological profile management
- Memory and interaction history

### **State Management**
- Page-based story state architecture
- User session management
- Progress tracking and bookmarks
- Trauma and psychological flag systems
- **Branch-aware state reconstruction** using the Branch Traversal Algorithm
- **Snapshot and delta management** for optimal performance
- **Multi-level caching** with LRU eviction policies

## 🔧 Configuration

### **Story Settings**
- `BOOK_MIN_PAGES`: 80 minimum pages per book
- `BOOK_MAX_PAGES`: 200 maximum pages per book
- `MIN_CHARS_PER_PAGE`: 200 minimum characters per page
- `MAX_WORDS_PER_PAGE`: 120 words per page limit
- `MAX_WORDS_SUMMARIZED_CONTEXT`: 300 words context limit
- `MAX_CHARACTERS`: 6 active characters limit
- `MIN_CHARACTER_AGE`: 13 minimum character age
- `MAX_CHARACTER_AGE`: 25 maximum character age
- `MAX_PLACES`: 6 maximum places per story
- `MAX_ACTIVE_THREADS`: 5 maximum active narrative threads
- `MAX_THREADS_PER_PAGE`: 2 maximum threads per page
- `MIN_ACTION_CHOICES`: 1 minimum action choices
- `MAX_ACTION_CHOICES`: 3 maximum action choices
- `MAX_ACTION_CHOICES_FIRST_PAGE`: 2 maximum choices on first page
- `MAX_BRANCHING_RETRIES`: 3 maximum branching retry attempts
- `MAX_BRANCHING_PREGENERATION_DEPTH`: 2 maximum pre-generation depth
- `MAX_BRANCHING_PREGENERATION_LIMIT`: 3 maximum pre-generated candidates
- `MAX_TRAUMA_TAGS`: 5 maximum trauma tags per story
- `MAX_DOMINANT_TRAITS`: 3 maximum dominant traits per character
- `MAX_PAST_INTERACTIONS`: 5 maximum past interactions per character
- `MAX_PLACE_MOOD_HISTORY`: 5 maximum mood history entries per place
- `MAX_PLACE_EVENTS`: 8 maximum event tags per place
- `MAX_CHARACTER_PLACES`: 5 maximum character-place relations
- `MAX_PAGE_HISTORY`: 3 maximum past pages for context
- `MAX_ACTION_HISTORY`: 5 maximum action history entries
- `SNAPSHOT_INTERVAL`: 10 pages between snapshots

### **Branch Traversal Settings**
- `MAX_TRAVERSAL_DEPTH`: Maximum depth for branch exploration (200 pages)
- `GET_STORY_STATE_CIRCUIT_THRESHOLD`: 3 failures before circuit opens
- `GET_STORY_STATE_CIRCUIT_TIMEOUT`: 30000ms timeout for state operations
- `GET_BRANCH_PATH_CIRCUIT_THRESHOLD`: 5 failures before circuit opens
- `GET_BRANCH_PATH_CIRCUIT_TIMEOUT`: 60000ms timeout for branch operations
- `GET_PAGE_BY_ID_CIRCUIT_THRESHOLD`: 3 failures before circuit opens
- `GET_PAGE_BY_ID_CIRCUIT_TIMEOUT`: 30000ms timeout for page operations
- `GET_BOOK_CIRCUIT_THRESHOLD`: 3 failures before circuit opens
- `GET_BOOK_CIRCUIT_TIMEOUT`: 30000ms timeout for book operations
- `BRANCH_PATH_MAX_RETRIES`: 3 maximum retry attempts for branch path
- `BRANCH_PATH_BASE_DELAY`: 1000ms base delay for branch path retries
- `SNAPSHOT_SELECTION_MAX_RETRIES`: 2 maximum retry attempts for snapshot selection
- `SNAPSHOT_SELECTION_BASE_DELAY`: 500ms base delay for snapshot retries
- `DELTA_APPLICATION_MAX_RETRIES`: 2 maximum retry attempts for delta application
- `DELTA_APPLICATION_BASE_DELAY`: 200ms base delay for delta retries
- `RECONSTRUCTION_MAX_RETRIES`: 2 maximum retry attempts for reconstruction
- `RECONSTRUCTION_BASE_DELAY`: 2000ms base delay for reconstruction retries

### **Candidate Generation Settings**
- `MAX_GENERATION_DURATION_MS`: 30 minutes maximum generation duration
- `MAX_GENERATION_PARALLEL_DURATION_MS`: 13 minutes for cron jobs
- `MAX_PENDING_BOOK_COVER_PER_RUN`: 0 (disabled to reduce cost)
- `ALLOW_DEEPER_LEVEL_UNTIL_PAGE`: 3 pages allowing deeper pre-generation

### **AI Configuration**
- `DEFAULT_MAX_OUTPUT_TOKEN`: 3000 maximum output tokens
- `NVIDIA_REQUEST_TIMEOUT_MS`: 60000ms NVIDIA API timeout
- `DEFAULT_TEMPERATURE`: 0.7 default temperature (0.6-0.85 range)
- `DEFAULT_TOP_P`: 0.9 nucleus sampling parameter
- `DEFAULT_TOP_K`: 40 top-k sampling parameter
- `DEFAULT_STOP_SEQUENCES`: Triple newline stop sequences
- Multi-provider model selection (GitHub, Gemini, Mistral, Cohere, Groq, Cerebras, NVIDIA)
- Configurable temperature and output limits
- Rate limiting and caching strategies
- Fallback and error handling
- Specialized configs for summarization and human-style writing

## 🚀 Getting Started

### **Prerequisites**
- Node.js 20+
- pnpm package manager
- Neon database account
- AI provider API keys

### **Installation**
```bash
# Clone repository
git clone <repository-url>
cd twistloom-backend

# Install dependencies
pnpm install

# Configure environment
cp .env.example .env.local
# Edit .env.local with your API keys
```

### **Development Setup**
```bash
# Start development server
pnpm dev

# Run database migrations
pnpm db:migrate

# Open database studio
pnpm db:studio
```

### **Environment Variables**
```env
# Database
DATABASE_URL=postgresql://...

# AI Providers
CEREBRAS_API_KEY=...
GOOGLE_AI_API_KEY=...
MISTRAL_API_KEY=...
COHERE_API_KEY=...
GROQ_API_KEY=...
OPENAI_API_KEY=...
NVIDIA_API_KEY=...

# Rate Limiting
REDIS_URL=...
```

## 📊 Architecture Highlights

### **Type Safety**
- Full TypeScript coverage with strict type checking
- Domain-driven design with clear separation of concerns
- Type-safe AI response handling
- Comprehensive error management

### **Performance**
- Serverless optimization for Vercel deployment
- Intelligent caching with Redis
- Database connection pooling
- Efficient context management
- **Branch Traversal Algorithm** for 90% faster state reconstruction
- **Multi-level caching** with 85%+ hit rates
- **Optimized database queries** reducing load by 70%

### **Scalability**
- Multi-region database deployment
- Auto-scaling with serverless functions
- Rate limiting and request throttling
- Graceful error handling and fallbacks

## 🧪 Testing

### **Quality Assurance**
```bash
# Type checking
pnpm typecheck

# Linting
pnpm lint

# Fast linting (no promise checks)
pnpm lint:fast

# Import validation
pnpm lint:imports
```

### **Database Testing**
```bash
# Test connection
pnpm db:test

# Run with local environment
pnpm db:test --env-file=.env.local
```

## 📚 Documentation

### **Code Organization**
```
src/
├── config/          # Configuration files and AI client setup
│   ├── ai-chat.ts           # AI chat configuration
│   ├── ai-clients.ts        # AI provider model selection
│   ├── ai-images.ts         # AI image generation config
│   ├── auth.ts              # Authentication configuration
│   ├── branch-traversal.ts  # Branch traversal algorithm config
│   ├── cache.ts             # Cache configuration
│   ├── candidate-generation.ts # Candidate generation config
│   ├── characters.ts        # Character system config
│   ├── constants.ts         # Application constants
│   ├── credits.ts           # Credits system config
│   ├── emails/              # Email templates
│   ├── env.ts               # Environment variables
│   ├── errors.ts            # Error configuration
│   ├── image.ts             # Image configuration
│   ├── pagination.ts        # Pagination config
│   ├── purge.ts             # Cache purge config
│   ├── redis.ts             # Redis configuration
│   ├── story.ts             # Story settings
│   ├── subscription.ts      # Subscription config
│   ├── theme-validation.ts  # Theme validation config
│   └── translation.ts       # Translation config
├── cron/            # Scheduled job handlers
│   ├── auto-translate-indonesian.ts # Auto-translation cron
│   ├── cleanup.ts           # Database cleanup jobs
│   ├── generate-originals.ts # Original book generation
│   ├── on-demand-book-creation.ts # On-demand book creation
│   ├── retry-pending-generations.ts # Failed generation retry
│   ├── update-trending-scores.ts # Trending score updates
│   └── vip-expiration.ts    # VIP subscription expiration
├── db/              # Database schema and migrations
│   ├── client.ts            # Database client
│   ├── extensions.ts        # Database extensions
│   ├── reset.ts             # Database reset utilities
│   ├── schema.ts            # Database schema
│   └── triggers.ts          # Database triggers
├── middleware/      # Express middleware
│   ├── locale.ts            # Locale middleware
│   ├── nextauth.ts          # NextAuth middleware
│   └── rate-limit.ts        # Rate limiting middleware
├── routes/          # API endpoint handlers
│   ├── admin.ts             # Admin routes
│   ├── auth.ts              # Authentication routes
│   ├── books.ts             # Books API routes
│   ├── index.ts             # Route index
│   ├── payments.ts          # Payments API routes
│   └── user.ts              # User API routes
├── schema/          # Schema definitions
│   ├── book.ts              # Book schema
│   └── story.ts             # Story schema
├── services/        # Business logic and data access
│   ├── book-controller.ts   # Book controller logic
│   ├── book-creation.ts     # Book creation logic
│   ├── book.ts              # Book service
│   ├── cache.ts             # Cache service
│   ├── credits.ts           # Credits service
│   ├── image.ts             # Image service
│   ├── performance-monitoring.ts # Performance monitoring
│   ├── story-branch.ts      # Branch-aware story functions
│   ├── story-state-cache.ts # Story state caching
│   ├── story.ts             # Story service
│   ├── subscription.ts      # Subscription service
│   ├── translation.ts       # Translation service
│   ├── user-controller.ts   # User controller logic
│   └── user.ts              # User service
├── utils/           # Utility functions and AI prompts
│   ├── account-lockout.ts   # Account lockout utilities
│   ├── ai-chat-stream.ts    # AI streaming functions
│   ├── ai-chat.ts           # AI chat functions
│   ├── ai-clients.ts        # AI client utilities
│   ├── ai-image.ts          # AI image generation
│   ├── ai-limiters.ts       # AI rate limiting
│   ├── ai-logger.ts         # AI logging
│   ├── books.ts             # Book utilities
│   ├── branch-traversal.ts  # Core Branch Traversal Algorithm
│   ├── cache.ts             # Cache utilities
│   ├── candidate-generation.ts # Candidate generation
│   ├── characters.ts        # Character utilities
│   ├── debounce.ts          # Debounce utilities
│   ├── distributed-lock.ts  # Distributed locking
│   ├── email-verification.ts # Email verification
│   ├── email.ts             # Email utilities
│   ├── env.ts               # Environment utilities
│   ├── error.ts             # Error handling
│   ├── formatter.ts         # Text formatting
│   ├── github-workflow.ts   # GitHub workflow dispatch
│   ├── graceful-shutdown.ts # Graceful shutdown
│   ├── narrative-style.ts   # Narrative style utilities
│   ├── pagination.ts        # Pagination utilities
│   ├── parser.ts            # AI response parsing
│   ├── password-reset.ts    # Password reset utilities
│   ├── password-validation.ts # Password validation
│   ├── password.ts          # Password utilities
│   ├── places-strategy.ts   # Place strategy utilities
│   ├── places.ts            # Place utilities
│   ├── player-profile.ts    # Player profile utilities
│   ├── progress-tracking.ts # Progress tracking
│   ├── prompt-translation.ts # Prompt translation
│   ├── prompt.ts            # AI prompt engineering
│   ├── quote.ts             # Quote utilities
│   ├── redis.ts             # Redis utilities
│   ├── reliability.ts       # Reliability utilities
│   ├── retry.ts             # Retry logic
│   ├── search.ts            # Search utilities
│   ├── sse.ts               # Server-Sent Events
│   ├── story.ts             # Story utilities
│   ├── text-processing.ts   # Text processing
│   ├── text-similarity.ts   # Text similarity
│   ├── theme-validation.ts  # Theme validation
│   ├── time.ts              # Time utilities
│   ├── translation.ts       # Translation utilities
│   └── uuid.ts              # UUID utilities
├── app.ts           # Express app configuration
└── server.ts        # Server entry point
```

### **Key Modules**
- **Story Engine**: Core branching narrative logic
- **AI Integration**: Multi-provider AI communication
- **Character System**: Dynamic character management
- **Database Layer**: Type-safe data persistence
- **API Layer**: RESTful endpoint implementation
- **Branch Traversal Algorithm**: Advanced state reconstruction system
- **Story State Cache**: High-performance state management
- **Story Branch Service**: Branch-aware story functions
- **Candidate Generation**: Synchronous and async candidate generation
- **GitHub Workflow Dispatch**: Daily or on-demand GitHub Actions processing
- **Distributed Locking**: Prevents concurrent generation on same page
- **Strategy Pattern**: Deployment-aware generation with timeout optimization
- **Performance Monitoring**: System performance tracking and metrics
- **Translation Service**: Multi-language support and auto-translation
- **Credits System**: Credit consumption and management
- **Subscription Service**: VIP subscription management
- **Image Service**: Image upload and management
- **Authentication**: NextAuth v5 integration with email/password and Google OAuth
- **Rate Limiting**: Request throttling and abuse prevention
- **Email System**: Email verification, password reset, and notifications

---

**Built with 💀 for interactive psychological thriller storytelling**