# Contributing to RivetOS

Thanks for your interest in contributing! This guide will help you get started.

## Prerequisites

- **Node.js 22+** — [download](https://nodejs.org)
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

Examples:
```
feat: add Discord channel plugin
fix: handle SSE reconnect on provider timeout
docs: add memory plugin architecture guide
test: add provider streaming tests
chore: update Nx to 22.7
```

## Testing

Run the full test suite before submitting:

```bash
npm test
```

Tests use Node's built-in test runner (`node:test`). No external test framework required.

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
- `packages/core/src/runtime.ts` — Application layer. Composes domain + plugins.
- `src/boot.ts` — Composition root. The only file that knows concrete plugin types.
- `plugins/*` — Implement interfaces from `@rivetos/types`. No cross-plugin imports.

## PR Checklist

Before submitting a pull request, verify:

- [ ] Branch is based on `main`
- [ ] Commit messages follow conventional commits
- [ ] `npm test` passes
- [ ] New features include tests
- [ ] No credentials, API keys, or secrets in code
- [ ] Plugin depends on `@rivetos/types` only (if adding/modifying a plugin)
- [ ] Documentation updated if applicable

## Reporting Issues

Use the [bug report](https://github.com/philbert440/rivetOS/issues/new?template=bug_report.md) or [feature request](https://github.com/philbert440/rivetOS/issues/new?template=feature_request.md) templates.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
