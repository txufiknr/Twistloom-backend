import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * =====================================================================
 * ESLint Flat Config for Muslim Digest Backend (Vercel/Neon Optimized)
 * =====================================================================
 * 
 * 🎯 **Design Philosophy**
 * - Avoid false positives in ingest / db / rss / ai code paths
 * - Enforce strict correctness in HTTP routes & core services
 * - Optimized for NodeNext + ESM + serverless (Vercel/Neon)
 * - Use typed linting only where it provides real value
 * 
 * 🏗️ **Architecture Overview**
 * 1. Global ignores for performance
 * 2. Tooling/config exceptions
 * 3. Base language rules
 * 4. Core TypeScript configuration
 * 5. STRICT ZONE (typed linting ON)
 * 6. RELAXED ZONE (typed linting OFF)
 * 7. Declaration files
 */

export default [
  /**
   * =====================================================================
   * 🚫 1. GLOBAL IGNORES (Performance Optimization)
   * =====================================================================
   * Fast-track: Skip entire directories to improve linting speed
   * Critical for serverless environments where build time matters
   */
  {
    ignores: [
      "**/*.bak.*",       // Backup files
      "dist/**",          // Build output (Vercel deployment)
      "node_modules/**",  // Dependencies
      "drizzle/**",       // Generated SQL & snapshots (auto-generated)
      "tests/**",         // Test files
      "eslint.config.js", // Do NOT lint the linter itself
    ],
  },

  /**
   * =====================================================================
   * ⚙️ 2. TOOLING & CONFIG FILES EXCEPTIONS
   * =====================================================================
   * Special handling for build tools that need relaxed rules
   * These files often use dynamic imports and non-standard patterns
   */
  {
    files: ["drizzle.config.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: false,      // Skip project service for faster linting
        ecmaVersion: 2022,   // Modern JavaScript features
        sourceType: "module", // ESM for Vercel compatibility
      },
    },
    rules: {
      // Disable strict TypeScript rules for configuration files
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  /**
   * =====================================================================
   * 🛠️ 3. NODE.JS TOOLING SCRIPTS
   * =====================================================================
   * Build scripts, deployment scripts, and development utilities
   * These use Node.js globals and common patterns
   */
  {
    files: ["scripts/**/*.js"],
    languageOptions: {
      globals: globals.node, // Enable Node.js global variables (process, __dirname, etc.)
    },
  },

  /**
   * =====================================================================
   * 📜 4. BASE JAVASCRIPT RULES
   * =====================================================================
   * Foundation rules that apply to:
   * - Configuration files
   * - Build scripts  
   * - JavaScript files in tooling
   * 
   * Uses ESLint's recommended JavaScript configuration
   */
  js.configs.recommended,

  /**
   * =====================================================================
   * 📘 5. BASE TYPESCRIPT RULES (Untyped)
   * =====================================================================
   * 
   * ⚠️ **IMPORTANT DESIGN DECISION**
   * We intentionally DO NOT use `recommendedTypeChecked` globally.
   * This avoids massive noise from `no-unsafe-*` rules in:
   * - Database access code
   * - RSS parsing
   * - AI/ML integrations
   * - Cron jobs
   * 
   * Typed linting is enabled selectively in zones below.
   */
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: ["**/*.ts"],
  })),

  /**
   * =====================================================================
   * 🔧 6. CORE TYPESCRIPT CONFIGURATION (NodeNext + ESM)
   * =====================================================================
   * 
   * Applies to ALL `.ts` files unless overridden by later zones.
   * Configured for optimal Vercel/Neon serverless deployment.
   */
  {
    files: ["**/*.ts"],

    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json", // TypeScript project for type-aware linting
        tsconfigRootDir: import.meta.dirname, // Resolve tsconfig relative to this file
        sourceType: "module", // ESM for Vercel compatibility
      },
    },

    rules: {
      /**
       * =================================================================
       * ⚡ ASYNC & SERVERLESS SAFETY
       * =================================================================
       * Prevent common async/await mistakes in serverless functions
       */

      /**
       * Prevent forgotten promises (critical in serverless)
       * Unhandled promises can cause silent failures in Vercel functions
       */
      "@typescript-eslint/no-floating-promises": "error",

      /**
       * Allow intentional fallthrough in switch statements
       * Common pattern for multi-case handling with explicit comments
       */
      "no-fallthrough": "off",

      /**
       * Prefer `import type {}` for type-only imports
       * Improves tree-shaking and avoids runtime side effects
       * Essential for optimal bundle size in serverless
       */
      "@typescript-eslint/consistent-type-imports": "warn",

      /**
       * =================================================================
       * 🎨 ERGONOMICS & DEVELOPER EXPERIENCE
       * =================================================================
       * Rules that improve code quality without being overly restrictive
       */

      /**
       * Warn about unnecessary escape characters in regular expressions
       * Avoids potential confusion and false positives
       */
      "no-useless-escape": "warn",

      /**
       * Allow `_unused` pattern for handlers & middleware
       * Common pattern: (req, _res, _next) => { ... }
       */
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",   // Ignore unused function args starting with _
          varsIgnorePattern: "^_",   // Ignore unused variables starting with _
          caughtErrors: "all",       // Apply to all caught errors
          caughtErrorsIgnorePattern: "^_", // Ignore caught errors starting with _
        },
      ]

    },
  },

  /**
   * =====================================================================
   * 🛡️ 7. STRICT ZONE (Typed Linting ENABLED)
   * =====================================================================
   * 
   * 🎯 **Business Logic Where Correctness > Speed**
   * - Core services (business logic)
   * - Authentication & security-critical code
   * 
   * 🔍 **Typed Rules Enabled ONLY Here**
   * - `no-explicit-any` banned
   * - `no-unsafe-*` rules enforced
   * - Maximum type safety
   * 
   * This zone catches type errors before they reach production.
   */
  {
    files: [
      "src/service/**/*.ts",
    ],

    ...tseslint.configs.recommendedTypeChecked[0],

    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },

    rules: {
      /**
       * Ban `any` type in business logic
       * Forces explicit typing for better reliability
       */
      "@typescript-eslint/no-explicit-any": "error",

      /**
       * Force explicit typing when dealing with unknown data
       * Prevents implicit `any` assignments and operations
       */
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
    },
  },

  /**
   * =====================================================================
   * 🌊 8. RELAXED ZONE (Typed Linting DISABLED)
   * =====================================================================
   * 
   * 🎯 **Pragmatic Code Paths Where Runtime Validation Suffices**
   * - Cron jobs (scheduled tasks)
   * - Database access (Drizzle ORM provides runtime safety)
   * - HTTP routes (API endpoints)
   * - RSS parsing & web scraping (external data sources)
   * - AI & NLP integrations (dynamic content processing)
   * - Utility functions (general helpers)
   * 
   * 💡 **Why Relaxed Here?**
   * - External data sources are inherently untyped
   * - Runtime validation is more practical than compile-time
   * - Avoids false positives that don't improve reliability
   * - Focuses on actual bugs vs type noise
   */
  {
    files: [
      "src/cron/**/*.ts",        // Scheduled tasks
      "src/db/**/*.ts",          // Database operations
      "src/routes/**/*.ts",      // API route handlers
      "src/utils/**/*.ts",       // Utility functions
      "src/service/rss*.ts",     // RSS processing
    ],

    rules: {
      /**
       * Allow `any` and unsafe operations
       * These areas deal with external data where runtime validation is preferred
       */
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",

      /**
       * Ingest pipelines often intentionally fire-and-forget
       * Background tasks where promise rejection is handled elsewhere
       */
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/require-await": "off",

      /**
       * Text + AI code often violates strict template rules
       * Dynamic content processing requires flexible string handling
       */
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-misused-promises": "off",

      /**
       * Text processing utilities need control characters for sanitization
       * Essential for removing problematic characters from external data sources
       */
      "no-control-regex": "off",
    },
  },

  /**
   * =====================================================================
   * 📝 9. DECLARATION FILES (.d.ts)
   * =====================================================================
   * 
   * Type declaration files intentionally behave like `any`
   * They provide type information without strict enforcement
   * 
   * 🎯 **Purpose**
   * - Define types for external libraries
   * - Provide ambient type definitions
   * - Bridge JavaScript modules to TypeScript
   */
  {
    files: ["**/*.d.ts"],
    rules: {
      // Allow `any` and unsafe operations in declaration files
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
];
