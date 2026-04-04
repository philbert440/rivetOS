# Lint Fix Progress

## Setup
- [x] ESLint 9 flat config + Prettier installed
- [x] nx lint target configured
- [x] CI updated (typecheck → lint → test, Node 24)

## Current State: 1230 issues (985 errors, 245 warnings) across 60 files

## Strategy
Delegate batches to Grok by package. Fix in order of error density.

## Batch Status
- [ ] **Batch 1: providers** (333 issues) — xai(111), ollama(64), anthropic(63+14), openai-compat(55), google(40)
- [ ] **Batch 2: memory/postgres** (355 issues) — tools(77), search(72), migrate-v2(67), migrate(46), expand(31), compactor(28), adapter(23), embedder(11)
- [ ] **Batch 3: channels** (181 issues) — voice-discord(67+52+30), telegram(25), discord(20), agent(17)
- [ ] **Batch 4: tools plugins** (113 issues) — mcp-client(55), web-search(21), coding-pipeline(11), file(8+6+5+1), search(7+6)
- [ ] **Batch 5: cli** (149 issues) — doctor(34), provider(20), update(15), validate(9), service(8), plugins(7), logs(6), index(5), rest small
- [ ] **Batch 6: boot** (37 issues) — channels(16), memory(7), providers(7), validate(5), rest small
- [ ] **Batch 7: core** (32 issues) — subagent(9), loop(8), safety-hooks(6), hooks(4), heartbeat(3), skills(3), fallback(2), logger(2)

## Rules for Grok
1. Replace `any` with proper types — use `unknown` + type guards
2. For catch blocks: use `(error: unknown)` then narrow with `error instanceof Error`
3. For JSON.parse results: cast to `unknown` first, then narrow
4. For tool args: type as `Record<string, unknown>` and narrow
5. For API responses: define interfaces for the response shapes
6. `no-unnecessary-condition`: remove if truly unnecessary, or fix the type if the check IS necessary
7. `no-empty`: add `// intentionally empty` comment for catch blocks, or handle
8. `require-await`: remove `async` if no await needed, or add proper await
9. `no-floating-promises`: add `void` prefix or `await`
10. `no-unused-vars`: prefix with `_` or delete
11. Keep all existing functionality — these are type-only changes
12. Run `npx eslint <file>` after each fix to verify
