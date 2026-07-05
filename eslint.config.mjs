import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-plugin-prettier/recommended'
import nxPlugin from '@nx/eslint-plugin'
import jsoncParser from 'jsonc-eslint-parser'

// Shared module-boundary constraints — referenced by the global rule and
// the mcp-server override so the override can't silently drop an axis.
// Phase 1 note: the ros_tasks engine should introduce domain:tasks (and mesh
// may deserve its own tag once the gateway lands) — extend both axes here.
const BOUNDARY_DEP_CONSTRAINTS = [
  {
    sourceTag: 'scope:contract',
    onlyDependOnLibsWithTags: ['scope:contract'],
  },
  {
    sourceTag: 'scope:domain',
    onlyDependOnLibsWithTags: ['scope:contract', 'scope:domain'],
  },
  {
    sourceTag: 'scope:adapter',
    onlyDependOnLibsWithTags: ['scope:contract', 'scope:adapter'],
  },
  {
    sourceTag: 'scope:transport',
    onlyDependOnLibsWithTags: [
      'scope:contract',
      'scope:domain',
      'scope:adapter',
      'scope:transport',
    ],
  },
  {
    sourceTag: 'scope:composition',
    onlyDependOnLibsWithTags: [
      'scope:contract',
      'scope:domain',
      'scope:adapter',
      'scope:transport',
      'scope:composition',
      'scope:tooling',
    ],
  },
  {
    sourceTag: 'scope:app',
    onlyDependOnLibsWithTags: [
      'scope:contract',
      'scope:domain',
      'scope:adapter',
      'scope:transport',
      'scope:composition',
      'scope:app',
    ],
  },
  {
    sourceTag: 'scope:tooling',
    onlyDependOnLibsWithTags: ['scope:tooling'],
  },
  // Domain axis (bounded contexts — see plans/agentic-modernization).
  // A domain may reach shared contracts and itself; composition
  // roots (boot/cli) carry no domain tag, so nothing binds them.
  {
    sourceTag: 'domain:shared',
    onlyDependOnLibsWithTags: ['domain:shared'],
  },
  {
    sourceTag: 'domain:memory',
    onlyDependOnLibsWithTags: ['domain:shared', 'domain:memory'],
  },
  {
    sourceTag: 'domain:runtime',
    onlyDependOnLibsWithTags: ['domain:shared', 'domain:runtime'],
  },
  {
    sourceTag: 'domain:interfaces',
    onlyDependOnLibsWithTags: ['domain:shared', 'domain:interfaces'],
  },
]

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
      '**/*.d.ts',
      '**/*.test.ts',
      '**/*.spec.ts',
      'vitest.config.ts',
    ],
  },

  // Base JS rules — scoped to TS so package.json linting doesn't pick up JS rules
  { files: ['**/*.ts', '**/*.tsx'], ...eslint.configs.recommended },

  // TypeScript strict with type checking — scoped so type-aware rules don't run on package.json
  ...tseslint.configs.strictTypeChecked.map((cfg) => ({
    files: ['**/*.ts', '**/*.tsx'],
    ...cfg,
  })),

  // TypeScript settings
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Rule overrides — strict but practical
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // Relax rules that are more noise than signal
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Allow explicit any in specific cases (will tighten over time)
      '@typescript-eslint/no-explicit-any': 'warn',

      // Allow non-null assertions — we use them intentionally
      '@typescript-eslint/no-non-null-assertion': 'off',

      // Restrict enums is too aggressive for our use case
      '@typescript-eslint/no-unnecessary-condition': 'warn',

      // Template literal types — warn, don't error
      '@typescript-eslint/restrict-template-expressions': [
        'warn',
        {
          allowNumber: true,
          allowBoolean: true,
          allowNullish: true,
        },
      ],

      // Allow void in some cases
      '@typescript-eslint/no-confusing-void-expression': 'off',

      // Console is fine for a CLI/server project
      'no-console': 'off',
    },
  },

  // Nx module boundaries — codify the DDD layering
  // scope:contract    → only scope:contract
  // scope:domain      → scope:contract
  // scope:adapter     → scope:contract (plugins don't depend on each other or on domain)
  // scope:transport   → scope:contract, scope:domain, scope:adapter (exposes runtime externally)
  // scope:composition → scope:contract, scope:domain, scope:adapter, scope:transport, scope:tooling
  // scope:app         → everything
  // scope:tooling     → standalone
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { '@nx': nxPlugin },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: false,
          allow: [],
          // Dynamic import is used here for deferred loading in Node, not for
          // browser code-splitting. Don't treat dynamically-imported libs as
          // "lazy-only" — their static imports elsewhere are fine.
          checkDynamicDependenciesExceptions: ['.*'],
          banTransitiveDependencies: true,
          checkNestedExternalImports: true,
          allowCircularSelfDependency: false,
          depConstraints: BOUNDARY_DEP_CONSTRAINTS,
        },
      ],
    },
  },

  // Known cross-domain leak, tolerated ONLY here until the MCP unification
  // follow-up puts memory tools behind a contract: mcp-server re-exposes
  // @rivetos/memory-postgres tools over MCP. Same full rule config as the
  // global block (both axes, all options) — only `allow` differs.
  {
    files: ['plugins/transports/mcp-server/**/*.ts'],
    plugins: { '@nx': nxPlugin },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: false,
          allow: ['@rivetos/memory-postgres'],
          checkDynamicDependenciesExceptions: ['.*'],
          banTransitiveDependencies: true,
          checkNestedExternalImports: true,
          allowCircularSelfDependency: false,
          depConstraints: BOUNDARY_DEP_CONSTRAINTS,
        },
      ],
    },
  },

  // Nx dependency checks — runs against each project's package.json.
  // Catches:
  //   - imports of packages not declared as deps (the missing-dependency class of bug)
  //   - declared deps that are never imported (drift)
  //   - version mismatches between workspace deps and root
  {
    files: ['**/package.json'],
    languageOptions: { parser: jsoncParser },
    plugins: { '@nx': nxPlugin },
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          buildTargets: ['build'],
          checkMissingDependencies: true,
          checkObsoleteDependencies: true,
          checkVersionMismatches: true,
          includeTransitiveDependencies: false,
          // Test deps (vitest etc) live in workspace root, not per-project.
          ignoredFiles: [
            '**/*.test.ts',
            '**/*.spec.ts',
            '**/*.test.tsx',
            '**/*.spec.tsx',
            '**/test/**',
            '**/tests/**',
            '**/__tests__/**',
            '**/vitest.config.ts',
          ],
          // esbuild: build-time bundler used by build scripts (e.g. claude-cli's
          // scripts/bundle-rivet-memory.mjs), never imported by any runtime.
          ignoredDependencies: ['typescript', 'esbuild'],
        },
      ],
    },
  },

  // Per-project dep-check escapes for runtime-only deps (not statically imported).
  // nx-plugin: enquirer + nx are runtime peers of nx generators (called via
  // string-based API by the nx executor, not directly imported).
  {
    files: ['packages/nx-plugin/package.json'],
    languageOptions: { parser: jsoncParser },
    plugins: { '@nx': nxPlugin },
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          buildTargets: ['build'],
          checkMissingDependencies: true,
          checkObsoleteDependencies: true,
          checkVersionMismatches: true,
          includeTransitiveDependencies: false,
          ignoredFiles: ['**/*.test.ts', '**/*.spec.ts'],
          ignoredDependencies: ['typescript', 'enquirer', 'nx'],
        },
      ],
    },
  },

  // aisdk: @ai-sdk/provider + ai are used only via type imports (the package
  // exposes the ProviderAiSdkBridge contract + helper types). Stripped from
  // build output, so dependency-checks can't see the usage. They're declared
  // as deps so consumers (core + provider plugins) get them transitively
  // resolved via the workspace symlinks.
  {
    files: ['packages/aisdk/package.json'],
    languageOptions: { parser: jsoncParser },
    plugins: { '@nx': nxPlugin },
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          buildTargets: ['build'],
          checkMissingDependencies: true,
          checkObsoleteDependencies: true,
          checkVersionMismatches: true,
          includeTransitiveDependencies: false,
          ignoredFiles: ['**/*.test.ts', '**/*.spec.ts'],
          ignoredDependencies: ['typescript', '@ai-sdk/provider', 'ai'],
        },
      ],
    },
  },

  // den-server: node-pty is an optional native dep (needs a C++ toolchain at
  // install time) loaded via a guarded non-literal dynamic import so the
  // build never depends on it being installed — the graph can't see the
  // usage.
  {
    files: ['services/den-server/package.json'],
    languageOptions: { parser: jsoncParser },
    plugins: { '@nx': nxPlugin },
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          buildTargets: ['build'],
          checkMissingDependencies: true,
          checkObsoleteDependencies: true,
          checkVersionMismatches: true,
          includeTransitiveDependencies: false,
          ignoredFiles: ['**/*.test.ts', '**/*.spec.ts'],
          ignoredDependencies: ['typescript', 'node-pty'],
        },
      ],
    },
  },

  // voice-discord: mediaplex + sodium-native + @discordjs/opus are native
  // runtime peers of @discordjs/voice / prism-media — required for opus
  // encode/decode and encryption, never statically imported by us.
  {
    files: ['plugins/channels/voice-discord/package.json'],
    languageOptions: { parser: jsoncParser },
    plugins: { '@nx': nxPlugin },
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          buildTargets: ['build'],
          checkMissingDependencies: true,
          checkObsoleteDependencies: true,
          checkVersionMismatches: true,
          includeTransitiveDependencies: false,
          ignoredFiles: ['**/*.test.ts', '**/*.spec.ts'],
          ignoredDependencies: ['typescript', 'mediaplex', 'sodium-native', '@discordjs/opus'],
        },
      ],
    },
  },

  // Prettier — must be last
  prettier,
)
