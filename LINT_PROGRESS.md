# Lint Fix Progress

## Current: 663 issues (453 errors, 210 warnings) across 64 files

## Strategy
Fix files by error density, biggest first. Most issues are `any` → typed conversions.

## Completed (previous sessions)
- packages/boot/src/config.ts (partial)
- plugins/memory/postgres/src/search.ts ✅
- plugins/memory/postgres/src/migrate-v2.ts ✅
- plugins/memory/postgres/src/migrate.ts ✅
- plugins/memory/postgres/src/expand.ts ✅
- plugins/memory/postgres/src/compactor.ts ✅
- plugins/memory/postgres/src/adapter.ts (partial - 1 left)
- plugins/memory/postgres/src/tools.ts (partial - 2 left)

## Current Working Order (biggest first)
1. plugins/channels/voice-discord/src/plugin.ts (67)
2. plugins/tools/mcp-client/src/index.ts (55)
3. plugins/channels/voice-discord/src/voice-session.ts (52)
4. plugins/providers/google/src/index.ts (40)
5. packages/cli/src/commands/doctor.ts (34)
6. plugins/channels/voice-discord/src/xai-client.ts (30)
7. packages/core/src/domain/loop.ts (25)
8. plugins/channels/telegram/src/index.ts (25)
9. plugins/tools/web-search/src/index.ts (21)
10. packages/cli/src/commands/provider.ts (20)
11. packages/core/src/domain/subagent.ts (20)
12. plugins/channels/discord/src/index.ts (20)
13-64. ... 52 files with < 16 issues each

## Deploy Plan
After lint clean: deploy to CT100, CT101, CT102, CT103
