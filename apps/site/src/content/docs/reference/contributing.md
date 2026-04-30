---
title: Contributing
sidebar:
  order: 4
description: How to contribute to RivetOS
---


**Last updated:** April 2026

Thanks for your interest in contributing! This guide covers development setup, the Nx workflow, code style, and PR guidelines.

## Prerequisites

- **Node.js ≥ 24** — [download](https://nodejs.org)
- **npm** (comes with Node)
- **Git**

## Getting Started

1. **Fork** the repo on GitHub
2. **Clone** your fork:
   ```bash
   git clone https://github.com/<your-username>/rivetOS.git
   cd rivetOS
   ```
3. **Install dependencies** (automatically builds all packages):
   ```bash
   npm install
   ```
4. **Verify everything works:**
   ```bash
   npm run ci    # runs lint + build + test across all 22 packages
   ```
5. **Create a branch** from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```

## Working with Nx

RivetOS uses [Nx](https://nx.dev) to orchestrate the monorepo. Nx understands the dependency graph between the 22 packages and provides caching, parallel execution, and affected-only runs.

### Everyday commands

```bash
# ── Full pipeline (what CI runs) ─────────────────────────
npm run ci                              # lint + build + test all packages

# ── Individual targets across all packages ───────────────
npm run lint                            # ESLint all packages
npm run build                           # Rebuild all packages (also runs automatically on npm install)
npm test                                # Vitest all packages
npm run typecheck                       # tsc --noEmit all packages

# ── Single package ───────────────────────────────────────
npx nx run core:test                    # Test @rivetos/core only
npx nx run channel-telegram:lint        # Lint the Telegram channel plugin
npx nx run provider-anthropic:build     # Build the Anthropic provider
npx nx run tool-shell:test              # Test the shell tool plugin

# ── Only what you changed ────────────────────────────────
npx nx affected -t test                 # Test packages affected by your changes
npx nx affected -t lint build test      # Full pipeline, affected only

# ── @rivetos/nx generators ───────────────────────────────
npx nx g @rivetos/nx:plugin             # Scaffold a new channel/provider/tool plugin
npx nx g @rivetos/nx:pr                 # Interactive PR wizard with quality gates
```

### Package names for `nx run`

Core packages use their directory name. Plugins use the directory name without the category prefix:

| Package | Nx project name | `nx run` example |
|---------|----------------|------------------|
| `packages/types` | `types` | `npx nx run types:build` |
| `packages/core` | `core` | `npx nx run core:test` |
| `packages/boot` | `boot` | `npx nx run boot:build` |
| `packages/cli` | `cli` | `npx nx run cli:build` |
| `plugins/channels/telegram` | `channel-telegram` | `npx nx run channel-telegram:lint` |
| `plugins/channels/discord` | `channel-discord` | `npx nx run channel-discord:test` |
| `plugins/providers/anthropic` | `provider-anthropic` | `npx nx run provider-anthropic:build` |
| `plugins/providers/google` | `provider-google` | `npx nx run provider-google:lint` |
| `plugins/providers/xai` | `provider-xai` | `npx nx run provider-xai:test` |
| `plugins/providers/ollama` | `provider-ollama` | `npx nx run provider-ollama:build` |
| `plugins/providers/llama-server` | `@rivetos/provider-llama-server` | `npx nx run provider-llama-server:lint` |
| `plugins/memory/postgres` | `memory-postgres` | `npx nx run memory-postgres:build` |
| `plugins/tools/shell` | `tool-shell` | `npx nx run tool-shell:test` |
| `plugins/tools/file` | `tool-file` | `npx nx run tool-file:test` |
| `plugins/tools/search` | `tool-search` | `npx nx run tool-search:lint` |
| `plugins/tools/web-search` | `tool-web-search` | `npx nx run tool-web-search:build` |
| `plugins/tools/interaction` | `tool-interaction` | `npx nx run tool-interaction:test` |
| `plugins/tools/mcp-client` | `tool-mcp-client` | `npx nx run tool-mcp-client:build` |
| `plugins/tools/coding-pipeline` | `tool-coding-pipeline` | `npx nx run tool-coding-pipeline:lint` |
| `packages/nx-plugin` | `@rivetos/nx` | `npx nx run @rivetos/nx:test` |

> **Tip:** Run `npx nx show projects` to list all project names, or `npx nx show project <name>` to see available targets for a specific project.

### Exploring the dependency graph

```bash
npx nx graph              # Opens an interactive graph in your browser
```

This shows how packages depend on each other. Useful for understanding what a change in `@rivetos/types` will affect downstream.

### Caching

Nx caches lint, build, test, and typecheck results based on file inputs. If you run the same target twice without changing files, the second run replays from cache instantly.

```bash
npx nx reset              # Clear the local cache (if builds seem stale)
```

CI also persists `.nx/cache` between runs via GitHub Actions cache, so only changed packages rebuild on PRs.

### Targets reference

These are defined in `nx.json` and available on every package:

| Target | Command | Depends on | Cached |
|--------|---------|------------|--------|
| `lint` | `eslint src/` | — | ✅ |
| `build` | `tsc -p tsconfig.json` | `^build` (deps build first) | ✅ |
| `test` | `vitest run` | — | ✅ |
| `typecheck` | `tsc --noEmit -p tsconfig.json` | `^typecheck` | ✅ |

The `^` prefix means "run this target on dependencies first." So `nx run boot:build` will first build `types` and `core` (its dependencies), then build `boot`.

## Conventional Commits

All commits must follow [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix   | Use for                        |
|----------|--------------------------------|
| `feat:`  | New features                   |
| `fix:`   | Bug fixes                      |
| `docs:`  | Documentation changes          |
| `test:`  | Adding or updating tests       |
| `chore:` | Tooling, CI, dependency updates|
| `refactor:` | Code changes that don't fix bugs or add features |

Scope is optional but encouraged for plugin work:

```
feat(channel-telegram): add inline keyboard support
fix(provider-anthropic): handle 529 overloaded responses
docs: update Nx commands in CONTRIBUTING.md
test(core): add agent loop abort tests
chore: update Nx to 22.7
refactor(core): extract TurnHandler from runtime
```

## Code Style

- **TypeScript** — strict mode, no `any` unless unavoidable
- **ESLint** — flat config in `eslint.config.mjs`, shared across all packages
- **No default exports** — use named exports everywhere
- **Interfaces over types** for plugin contracts (defined in `@rivetos/types`)
- **No barrel re-exports** in plugins — keep dependency graphs clean

Run the linter before committing:

```bash
npm run lint                            # All packages
npx nx run core:lint                    # Just core
npx nx affected -t lint                 # Only changed packages
```

## Architecture Rules

RivetOS follows a strict layered architecture:

```
Types → Domain → Runtime → Boot
```

**The most important rule:** Plugins depend on `@rivetos/types` only. Never on `@rivetos/core`, never on other plugins, never on boot.

- `packages/types` — Interfaces and contracts. Zero dependencies.
- `packages/core/src/domain` — Pure domain logic. Depends on types only.
- `packages/core/src/runtime/` — Application layer. Thin compositor with focused modules:
  - `runtime.ts` — registration, routing, lifecycle
  - `turn-handler.ts` — single message turn processing
  - `media.ts` — attachment resolution and multimodal content
  - `streaming.ts` — stream events → channel delivery
  - `sessions.ts` — session lifecycle and history
  - `commands.ts` — slash command processing
- `packages/boot/` — Composition root. The only layer that knows concrete plugin types. Uses registrars to wire everything.
- `packages/cli/` — Command-line interface. Imports from `@rivetos/boot`.
- `plugins/*` — Implement interfaces from `@rivetos/types`. No cross-plugin imports.

**Platform-specific concerns stay in plugins.** Message splitting, typing indicators, API format differences — these belong in the channel or provider plugin, not in the runtime.

## Adding a New Plugin

The recommended way to add a plugin is with the `@rivetos/nx` generator:

```bash
npx nx g @rivetos/nx:plugin
```

This will interactively prompt for plugin type, name, and description, then scaffold the entire package with:
- `package.json` (scoped `@rivetos/<type>-<name>`, depends on `@rivetos/types`)
- `tsconfig.json` (extends root `tsconfig.base.json`)
- `src/index.ts` (interface stub implementing `Channel`, `Provider`, or `Tool`)
- `src/index.test.ts` (skeleton test file)
- `eslint.config.mjs` (inherits shared config)

You can also pass options directly:

```bash
npx nx g @rivetos/nx:plugin --type=channel --name=slack --description="Slack workspace integration"
npx nx g @rivetos/nx:plugin --type=provider --name=mistral --description="Mistral AI models"
npx nx g @rivetos/nx:plugin --type=tool --name=database --description="SQL query tool"
```

After scaffolding:

1. **Implement** the interface in `src/index.ts` — the stub has TODO comments for each method.
2. **Register** the plugin in `packages/boot/` via a registrar.
3. **Write tests** — the skeleton test file is ready to fill in.
4. **Verify:**
   ```bash
   npx nx run <project-name>:lint
   npx nx run <project-name>:build
   npx nx run <project-name>:test
   npx nx graph    # confirm it appears with correct dependencies
   ```

<details>
<summary>Manual setup (without generator)</summary>

1. Create the package directory:
   ```bash
   mkdir -p plugins/<category>/<name>
   ```
2. Add a `package.json` with the `@rivetos/` scope, depending on `@rivetos/types` only:
   ```json
   {
     "name": "@rivetos/<category>-<name>",
     "version": "0.0.5",
     "private": true,
     "scripts": {
       "lint": "eslint src/",
       "build": "tsc -p tsconfig.json",
       "test": "vitest run"
     },
     "dependencies": {
       "@rivetos/types": "workspace:*"
     }
   }
   ```
3. Add a `tsconfig.json` extending the root:
   ```json
   {
     "extends": "../../../tsconfig.base.json",
     "compilerOptions": {
       "outDir": "dist",
       "rootDir": "src"
     },
     "include": ["src"]
   }
   ```
4. Implement the relevant interface from `@rivetos/types` (e.g., `Channel`, `Provider`, `Tool`).
5. Register the plugin in `packages/boot/` via a registrar.
6. Verify:
   ```bash
   npx nx run <project-name>:lint
   npx nx run <project-name>:build
   npx nx run <project-name>:test
   npx nx graph    # confirm it appears with correct dependencies
   ```
</details>

## Testing

Tests use **Vitest** and run via Nx. Each package has its own test files (`*.test.ts` or `*.spec.ts`) colocated with source.

```bash
# All tests
npm test

# Single package
npx nx run core:test

# Watch mode (for development)
npx nx run core:test --watch

# Only affected packages
npx nx affected -t test

# With coverage
npx nx run core:test -- --coverage
```

## Creating a Pull Request

The recommended way to create a PR is with the `@rivetos/nx` PR generator:

```bash
npx nx g @rivetos/nx:pr
```

This will:
1. Ask for change type (feat/fix/refactor/chore/docs/plugin/test/perf)
2. Create a branch with conventional naming (e.g., `feat/add-slack-channel`)
3. Detect affected packages from your changes
4. Run `nx affected -t lint build test` as a quality gate (**must pass**)
5. Generate a PR description with affected packages, summary, and checklist
6. Create the PR via `gh pr create` with appropriate labels

You can also pass options directly:

```bash
npx nx g @rivetos/nx:pr --type=feat --description="Add Slack channel" --issue=34
npx nx g @rivetos/nx:pr --dryRun    # preview without creating anything
```

### Manual PR checklist

If you're not using the PR generator, verify before submitting:

- [ ] Branch is based on `main`
- [ ] Commit messages follow conventional commits
- [ ] `npm run ci` passes (lint + build + test)
- [ ] No new lint warnings (`npm run lint` is clean)
- [ ] New features include tests
- [ ] No credentials, API keys, or secrets in code
- [ ] Plugin depends on `@rivetos/types` only (if adding/modifying a plugin)
- [ ] Documentation updated if applicable

**CI runs `nx affected -t lint build test`** on every PR. If your changes break any package's lint, build, or tests, the PR will be blocked.

## Plugin Discovery

RivetOS uses convention-based plugin discovery. Every plugin declares itself in `package.json`:

```json
{
  "name": "@rivetos/provider-mistral",
  "rivetos": {
    "type": "provider",
    "name": "mistral"
  }
}
```

Boot scans `plugins/*/package.json` for the `rivetos` field. Config determines which plugins load. You don't need to edit any registrar files — just add the manifest and reference the plugin in config.

For user plugins outside the monorepo, add their directory to config:
```yaml
runtime:
  plugin_dirs:
    - /path/to/my/plugins
```

## Working with Containers

RivetOS ships as container images built from source.

### Build containers locally

```bash
npx rivetos build
# or
npx nx build container-rivetos
```

The Postgres datahub uses upstream `pgvector/pgvector:pg16` directly — schema is applied by the `migrate` role at stack startup, so there is no custom datahub image to build.

### Run the stack

```bash
# From the repo root:
docker compose -f infra/docker/rivetos/docker-compose.yml up -d
```

Multi-agent fleets are deployed as separate hosts/CTs joined into a mesh — see `docs/mesh.md` — rather than as N agent services in one Compose file.

### Data persistence

Containers are stateless. All data lives on the host:
- `~/.rivetos/config.yaml` — configuration (bind mount, read-only)
- `~/.rivetos/.env` — secrets (bind mount, read-only)
- `rivetos-pgdata` — PostgreSQL (named volume)

See [infra/containers/DATA-PERSISTENCE.md](infra/containers/DATA-PERSISTENCE.md) for details.

## Writing Skills

Skills are markdown documents, not code. Anyone can contribute skills.

```bash
# Scaffold a new skill
npx rivetos skill init my-skill --description="Does something useful"

# Validate it
npx rivetos skill validate my-skill
```

See [docs/SKILLS.md](docs/SKILLS.md) for the full guide.

## Reporting Issues

Use the [bug report](https://github.com/philbert440/rivetOS/issues/new?template=bug_report.md) or [feature request](https://github.com/philbert440/rivetOS/issues/new?template=feature_request.md) templates.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
