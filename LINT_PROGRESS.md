# Lint Fix Progress

## Current: 1030 issues (792 errors, 238 warnings) across 70 files

## Strategy
Fix files in order of error density. Most issues are `any` → typed conversions.

## Completed Batches
_(none yet)_

## In Progress
- Working through files from heaviest to lightest

## Remaining Files (by issue count)
77  plugins/memory/postgres/src/tools.ts
72  plugins/memory/postgres/src/search.ts
67  plugins/channels/voice-discord/src/plugin.ts
67  plugins/memory/postgres/src/migrate-v2.ts
55  plugins/tools/mcp-client/src/index.ts
52  plugins/channels/voice-discord/src/voice-session.ts
46  plugins/memory/postgres/src/migrate.ts
40  plugins/providers/google/src/index.ts
34  packages/cli/src/commands/doctor.ts
31  plugins/memory/postgres/src/expand.ts
30  plugins/channels/voice-discord/src/xai-client.ts
28  plugins/memory/postgres/src/compactor.ts
25  packages/core/src/domain/loop.ts
25  plugins/channels/telegram/src/index.ts
23  plugins/memory/postgres/src/adapter.ts
21  plugins/tools/web-search/src/index.ts
20  packages/cli/src/commands/provider.ts
20  packages/core/src/domain/subagent.ts
20  plugins/channels/discord/src/index.ts
17  plugins/channels/agent/src/index.ts
... plus 50 files with < 16 issues each
