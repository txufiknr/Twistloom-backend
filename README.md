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

## 🏗️ Tech Stack

### **Technologies**

| Choice | Version | Why |
|--------|---------|-----|
| 💻 **TypeScript** | 5.9+ | Type safety, modern features, and excellent IDE support |
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

### **Advanced AI Systems**
- **Multi-Provider Support**: Fallback across multiple AI providers for reliability and performance
- **Context Management**: Intelligent story context summarization for coherent narrative progression
- **Type-Safe Responses**: Structured AI output validation with comprehensive error handling
- **Rate Limiting**: Built-in request throttling and caching for optimal performance
- **Prompt Engineering**: Structured prompt engineering with multi-provider fallback strategies

### **Database Architecture**
- **Page-Based States**: Individual story state per page with comprehensive tracking
- **Branching Logic**: Parent-child page relationships with complex narrative structures
- **Character Memory**: Persistent character interactions with relationship development
- **Place Tracking**: Location-based narrative elements with environmental consistency
- **Trauma System**: Psychological stress tracking with dynamic difficulty progression

## 📦 Key Dependencies

### **Core Dependencies**
```json
{
  "express": "^5.2.1",
  "drizzle-orm": "0.45.1", 
  "@neondatabase/serverless": "^1.0.2",
  "cors": "^2.8.6"
}
```

### **AI Provider SDKs**
```json
{
  "@cerebras/cerebras_cloud_sdk": "^1.64.1",
  "@google/genai": "^1.40.0",
  "@mistralai/mistralai": "^2.1.2",
  "cohere-ai": "^7.20.0",
  "groq-sdk": "^0.37.0",
  "openai": "^6.33.0"
}
```

## 🛠️ Development Scripts

### **Development**
```bash
pnpm dev          # Start development server with hot reload
pnpm dev:api       # Start API server only
pnpm typecheck    # Run TypeScript type checking
pnpm lint          # Run ESLint
pnpm lint:fix      # Auto-fix ESLint issues
```

### **Database Management**
```bash
pnpm db:generate   # Generate database migrations
pnpm db:migrate    # Apply database migrations
pnpm db:studio     # Open Drizzle Studio GUI
pnpm db:test       # Test database connection
pnpm db:reset      # Reset database (clear + migrate + seed)
```

### **Production**
```bash
pnpm build         # Build TypeScript to JavaScript
pnpm start         # Start production server
pnpm start:api    # Start production API server
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

## 🏛️ API Architecture

### **Story Management**
- `POST /api/books` - Create new psychological thriller books
- `GET /api/books` - Retrieve user's book library
- `POST /api/books/:id/pages` - Generate new story pages
- `GET /api/books/:id/pages/:pageId` - Retrieve specific pages
- `POST /api/books/:id/sessions` - Manage reading sessions

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

## 🔧 Configuration

### **Story Settings**
- `MAX_WORDS_PER_PAGE`: 60 words per page limit
- `MAX_RELEVANT_CHARACTERS`: 5 active characters limit
- `DEFAULT_BOOK_MAX_PAGES`: 150 pages per book
- `MAX_WORDS_SUMMARIZED_CONTEXT`: 300 words context limit

### **AI Configuration**
- Multi-provider model selection
- Configurable temperature and output limits
- Rate limiting and caching strategies
- Fallback and error handling

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
├── config/          # Configuration files
├── db/              # Database schema and migrations  
├── services/         # Business logic and data access
├── utils/            # Utility functions and AI prompts
├── types/            # TypeScript type definitions
└── routes/            # API endpoint handlers
```

### **Key Modules**
- **Story Engine**: Core branching narrative logic
- **AI Integration**: Multi-provider AI communication
- **Character System**: Dynamic character management
- **Database Layer**: Type-safe data persistence
- **API Layer**: RESTful endpoint implementation

---

**Built with 💀 for interactive psychological thriller storytelling**