# Contributing to RivetOS

**Last updated:** April 2026

Thanks for your interest in contributing! This guide will help you get started.

## Prerequisites

- **Node.js 24+** — [download](https://nodejs.org)
- **npm** (comes with Node)
- **Git**

## Getting Started

1. **Fork** the repo on GitHub
2. **Clone** your fork:
   ```bash
   git clone https://github.com/<your-username>/rivetOS.git
   cd rivetOS
   ```
3. **Install dependencies:**
   ```bash
   npm install
   ```
4. **Create a branch** from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```

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

Examples:
```
feat: add Discord channel plugin
fix: handle SSE reconnect on provider timeout
docs: add memory plugin architecture guide
test: add provider streaming tests
chore: update Nx to 22.7
refactor: extract TurnHandler from runtime
```

## Testing

Run the full test suite before submitting:

```bash
npm test
```

Tests use **Vitest** and run via Nx:

```bash
# Run all tests
npx nx run-many -t test

# Run tests for a specific package
npx nx run core:test

# Run tests for affected packages only
npx nx affected -t test
```

### Type Checking

Every package must typecheck clean:

```bash
# Typecheck all 21 packages
npx nx run-many -t typecheck

# Typecheck affected packages only
npx nx affected -t typecheck
```

**Do not introduce new type errors.** The `typecheck` target runs `tsc --noEmit` on every package independently. If your changes break typecheck, CI will catch it.

## Code Style

- **TypeScript** — strict mode, no `any` unless unavoidable
- **No default exports** — use named exports
- **Interfaces over types** for plugin contracts (defined in `@rivetos/types`)
- **No barrel re-exports** in plugins — keep dependency graphs clean

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

## PR Checklist

Before submitting a pull request, verify:

- [ ] Branch is based on `main`
- [ ] Commit messages follow conventional commits
- [ ] `npx nx run-many -t test` passes
- [ ] `npx nx run-many -t typecheck` passes
- [ ] New features include tests
- [ ] No credentials, API keys, or secrets in code
- [ ] Plugin depends on `@rivetos/types` only (if adding/modifying a plugin)
- [ ] Documentation updated if applicable

## Reporting Issues

Use the [bug report](https://github.com/philbert440/rivetOS/issues/new?template=bug_report.md) or [feature request](https://github.com/philbert440/rivetOS/issues/new?template=feature_request.md) templates.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
