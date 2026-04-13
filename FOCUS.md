# FOCUS.md — Active Work

## What We're Doing

families.app Phase 2: Multi-Tenant Core — building multi-tenancy into tompkins.app.

## Project Info
**AGENT.md:** `/root/tompkins-app/AGENT.md`
**Planning docs:** `/opt/rivetos/workspace/shared/FamiliesApp/REFACTORING.md`

## Phase 1: Foundation Cleanup ✅ Complete (2026-04-13)

## Phase 2: Multi-Tenant Core — Tasks

- [ ] 2.1 Family + FamilyMembership Models (Prisma schema, roles, seed data)
- [ ] 2.2 Add `familyId` to All Content Models (nullable → backfill → required)
- [ ] 2.3 Family Context Middleware (`getFamilyContext()`, API routes, services)
- [ ] 2.4 Family Switcher UI (sidebar dropdown, session switching)
- [ ] 2.5 Onboarding Flow (sign up → create family → invite → tree → memories)
- [ ] 2.6 Invitation System (email invites, magic links, accept/decline)

## Current Step
Testing delegation (Grok, Rivet-Local) before starting Phase 2 tasks via delegation.

## Approach
Using RivetOS delegation (Grok/Sonnet/Haiku/Rivet-Local) to execute code changes. Opus orchestrates.

## Blockers
- PR #51 (xAI freshConversation fix) needs merge + runtime restart before Grok delegation works
