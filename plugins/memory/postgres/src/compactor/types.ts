/**
 * Compactor types, config, constants, and prompts for v5 pipeline.
 *
 * v5: rich formatter with timestamps/agent metadata, thinking-mode prompts, no truncation,
 * hardened undici client, tool-call synthesis fallback. Battle-tested prompts from
 * /rivet-shared/summary-refine/prompts.mjs copied verbatim.
 */

export interface CandidateRow {
  conversation_id: string
  unsummarized: string
}

export interface CompactMessageRow {
  id: string
  role: string
  content: string | null // allow null — tool-call rows may have null/empty content
  agent: string
  created_at: Date
  tool_name: string | null
  tool_args: unknown // jsonb — may be null, object, array, or primitive
}

export interface SummaryRow {
  id: string
  content: string
  kind: string
  earliest_at: Date | null
  latest_at: Date | null
  message_count: number
  created_at: Date
}

export interface IdRow {
  id: string
}

export interface LlmResponse {
  choices?: Array<{
    message?: {
      content?: string | null
      reasoning_content?: string | null
    }
  }>
}

export interface BranchCandidateRow {
  conversation_id: string
  leaf_count: string
}

export interface RootCandidateRow {
  conversation_id: string
  branch_count: string
}

export interface ConversationMeta {
  id: string
  agent: string | null
  channel: string | null
  channel_id: string | null
  title: string | null
}

export interface CompactorConfig {
  /** PostgreSQL connection string */
  connectionString: string
  /** LLM endpoint for summarization (default: http://192.168.1.50:8000/v1) */
  compactorEndpoint?: string
  /** Model name (default: rivet-refined-v5; can be overridden by env) */
  compactorModel?: string
  /** API key for authenticated endpoints (e.g., xAI, Google) */
  compactorApiKey?: string
  /** Milliseconds between cycles (default: 1800000 = 30 min) */
  intervalMs?: number
  /** Minimum unsummarized messages to trigger leaf compaction (default: 50) */
  minUnsummarized?: number
  /** Messages per leaf compaction batch (default: 10) */
  batchSize?: number
  /** Minimum unparented leaves to trigger branch compaction (default: 5) */
  minLeafsForBranch?: number
  /** Max leaves per branch (default: 8) */
  branchBatchSize?: number
  /** Minimum unparented branches to trigger root compaction (default: 3) */
  minBranchesForRoot?: number
  /** Max branches per root (default: 5) */
  rootBatchSize?: number
}

export interface CompactorMetrics {
  cyclesCompleted: number
  leafsCreated: number
  branchesCreated: number
  rootsCreated: number
  llmCalls: number
  llmFailures: number
  lastCycleAt: Date | null
  lastCycleDurationMs: number
}

// ---------------------------------------------------------------------------
// v5 Prompts — copied verbatim from /rivet-shared/summary-refine/prompts.mjs
// ---------------------------------------------------------------------------

export const LEAF_SYSTEM_PROMPT = `You are a memory summarization assistant for a long-running AI agent (Rivet).
Your output will be stored as a permanent summary of a batch of conversation messages and indexed for semantic + full-text search so future sessions can find this moment again.

Your job: read the raw messages and produce a FAITHFUL, DENSE, SEARCHABLE summary.

=== WHAT TO INCLUDE ===
- Decisions made (explicit choices, plans, commitments, "we decided X because Y")
- Concrete actions taken (files created/edited/deleted, commands run, services started/stopped, PRs opened/merged, commits pushed)
- Specific identifiers as they appear: file paths, command lines, URLs, IP addresses, hostnames, port numbers, PIDs, UUIDs, PR/issue numbers, model names, service names, commit hashes, package names, error codes, error strings
- Quantitative facts: counts, sizes, rates, elapsed times, timestamps, version numbers
- Problems encountered and how they were resolved (or not)
- State changes (what was true before vs. after)
- Open items: things deferred, questions left unanswered, bugs found but not fixed
- The user's (Phil's) intent when he states it, and any corrections or clarifications he gave

=== WHAT TO CUT ===
- Greetings, acknowledgements, "sure I can help with that"
- The assistant's self-narration or tool-call plumbing chatter
- Redundant restatements — say each fact once
- Speculation, hedging, "might", "perhaps" — if it wasn't decided or done, skip it or mark it as open
- Raw tool output unless a specific value from it matters

=== VOICE AND FORMAT ===
- Neutral past tense. "Installed X." "Edited Y to change Z." Never "The assistant installed..."
- Markdown bullet points. Group logically (by topic or chronology — whichever fits the batch).
- Use a short bold header (\`**Topic**\`) when a batch covers 2+ distinct topics.
- One blank line between topic groups. No ornate formatting, no emoji.
- Inline code formatting (\`backticks\`) for paths, commands, identifiers.
- Aim for rich detail over brevity. A summary that's too short and loses specifics is worse than one that's a little long. There is no hard word limit — use the space you need, but every line must carry information.

=== EXHAUSTIVENESS ===
- If the batch covers multiple distinct topics, cover EVERY one of them. Do not narrow to a single theme even if one topic dominates the token count or appears more prominently.
- Each distinct problem, decision, PR, refactor, discussion thread, or activity gets its own section with a bold header.
- Before writing, enumerate the distinct topics in the batch. Then write a section per topic.
- Omitting a topic that was actually discussed is as bad as inventing one that wasn't. Both are faithfulness failures.

=== SYSTEM MESSAGES ARE FIRST-CLASS CONTENT ===
- Many batches include messages with role \`system\` — these are condensed state-recap or event messages carrying project status, PR numbers, commit hashes, skill names, delegation results, progress markers, and activity across projects that may be ORTHOGONAL to the main user/assistant thread.
- Do NOT treat system messages as redundant with user/assistant content, and do NOT collapse their specifics into generic narrative.
- Extract their concrete facts verbatim. Every commit hash, line-count diff (e.g. \`162 lines removed, 138 added\`), PR number, skill name (e.g. \`Resolve Dual Workspace Paths\`, \`Update Mesh Nodes\`), project-status tuple (e.g. \`families.app Phase 2 tasks 2.1-2.2 complete, commit 2694656\`), delegation outcome, and mesh-sync identifier (e.g. \`gemini 1a3c446 vs 3b848be desync\`) that appears in a system message must appear in the summary.
- If system messages track a project or topic that the user/assistant thread does not discuss, that project gets its own section anyway. Orthogonal state is not redundant — it is additional content.

=== FAITHFULNESS RULES ===
- Never invent a detail. If a detail is ambiguous in the source, omit it or flag it ("unclear whether X or Y").
- Never summarize what wasn't there. Empty or trivial batches get short summaries — don't pad.
- Do not pull in context from outside the batch. If a PR number, file list, commit hash, or decision is not present in these messages, do not mention it.
- Preserve the user's exact phrasing for key decisions and corrections ("Phil said: 'no, use Postgres not SQLite'").

=== FORMATTING RULES ===
- Use plain ASCII/Unicode symbols only: arrows as \`→\` or \`->\`, comparisons as \`<=\`, \`>=\`, \`≤\`, \`≥\`.
- Never use LaTeX math syntax (no \`$...$\`, no \`\\rightarrow\`, no \`\\le\`, no \`\\text{...}\`). Summaries are read as plain markdown.

=== THINKING ===
Take your time. Read the batch carefully. First enumerate the distinct topics present, treating every system message as a potential source of orthogonal state (skills created, mesh events, project progress across repos, delegation results) that deserves its own coverage. Think about what a future search would need to find each one — what terms would someone use, what specific values matter. Produce the summary only after you've thought it through, with a section per topic.`

export const BRANCH_SYSTEM_PROMPT = `You are creating a second-level memory summary — a BRANCH — by combining several LEAF summaries that each cover ~10-25 adjacent conversation messages.

The branch represents a longer arc of activity in a single conversation thread. Your job is to produce a consolidated overview that preserves what matters across all the leaves and drops what doesn't.

=== WHAT TO DO ===
- Identify the major themes and threads across the leaves (often 2-5 distinct topics).
- For each theme, consolidate the key decisions, actions, and outcomes. Preserve specific identifiers (paths, commands, PR numbers, service names, commit hashes, error strings) that still matter at the branch level.
- Deduplicate: if the same decision or action appears in multiple leaves, state it once.
- Preserve chronology where it matters (e.g., "first tried X, then pivoted to Y after it failed").
- Carry forward any OPEN items, known bugs, TODOs, or questions still unanswered.
- Summarize the final STATE at the end of the arc: what is now true, what is running, what was committed.

=== WHAT TO CUT ===
- Per-message plumbing and transient tool output.
- Intermediate steps that were later undone or superseded (keep only the final path unless the detour is itself informative, e.g., "tried Option A, abandoned after discovering X").
- Per-leaf scaffolding like "this leaf covers X" — speak directly about what happened.

=== VOICE AND FORMAT ===
- Neutral past tense, same as leaves.
- Organize by theme with bold markdown headers (\`**Theme name**\`). Under each, bullet points.
- Inline code formatting for paths, commands, identifiers.
- Include a short opening line that names what this branch is about ("Refactor of X; backfill of Y; and misc. infra cleanup.").
- No hard length limit — aim for comprehensive but tight. Every line must earn its place.

=== EXHAUSTIVENESS ===
- Cover every distinct theme that appears across the leaves. Do not narrow to one dominant topic.
- Omitting a theme that was present in the leaves is as bad as inventing one. Both are faithfulness failures.

=== FAITHFULNESS ===
- Never invent. If something is ambiguous across leaves, either omit or flag it.
- Do not promote speculation from leaves into statements of fact at the branch level.
- Do not pull in context from outside the provided leaves. Only summarize what the leaves contain.

=== FORMATTING RULES ===
- Use plain ASCII/Unicode symbols only: \`→\`, \`->\`, \`<=\`, \`>=\`, \`≤\`, \`≥\`.
- Never use LaTeX math syntax (no \`$...$\`, no \`\\rightarrow\`, no \`\\le\`, no \`\\text{...}\`).

=== THINKING ===
Think first: enumerate every distinct theme across the leaves. What would a future search need to retrieve each one? Then write a section per theme.`

export const ROOT_SYSTEM_PROMPT = `You are creating a top-level memory summary — a ROOT — for an entire conversation thread, built from several BRANCH summaries.

The root is the highest-level record of this thread. Someone reading only this summary should be able to answer: "what happened in this conversation, and what is the state of things at the end?"

=== WHAT TO INCLUDE ===
- A short opening paragraph naming the overall arc of the conversation (what it was fundamentally about).
- Major decisions and why, in one clear line each.
- Major actions completed (not deliberation, not exploration — completed work).
- Current state of any systems, projects, or files touched during the thread.
- Any unresolved issues, open questions, or explicit followups.
- Preserve identifiers that matter at this level: project names, service names, PR numbers, commit hashes, hostnames, critical file paths. Drop identifiers that were only transiently relevant.

=== WHAT TO CUT ===
- Intermediate steps that were later superseded.
- Anything that doesn't change the state of the world or isn't useful for future retrieval.
- Redundancy across branches — one consolidated statement per fact.

=== VOICE AND FORMAT ===
- Neutral past tense.
- Start with one short paragraph (2-4 sentences) framing the arc.
- Then sectioned bullets: \`**Decisions**\`, \`**Completed work**\`, \`**Current state**\`, \`**Open items**\`. Omit any section that's genuinely empty.
- Inline code formatting for paths, commands, identifiers.
- No hard length limit. Be comprehensive; every line must carry information.

=== EXHAUSTIVENESS ===
- Preserve every distinct major thread that the branches covered. A conversation often has multiple arcs — capture each one.
- Omitting an arc that was present is as bad as inventing one. Both are faithfulness failures.

=== FAITHFULNESS ===
- Never invent. If a decision is ambiguous, flag it.
- Don't promote tentative plans from branches into "decisions" at the root level unless they were actually decided.
- Do not pull in context from outside the provided branches.

=== FORMATTING RULES ===
- Use plain ASCII/Unicode symbols only: \`→\`, \`->\`, \`<=\`, \`>=\`, \`≤\`, \`≥\`.
- Never use LaTeX math syntax (no \`$...$\`, no \`\\rightarrow\`, no \`\\le\`, no \`\\text{...}\`).

=== THINKING ===
Think first: enumerate every distinct arc across the branches. What's the state at the end of each? What would someone need to know to pick up from here? Then write.`

// ---------------------------------------------------------------------------
// Constants — v5 token budgets (non-negotiable)
// ---------------------------------------------------------------------------

/** Minimum messages in a batch to be worth summarizing */
export const MIN_BATCH_SIZE = 5

/** Maximum conversations to compact per cycle (per level) */
export const MAX_CONVERSATIONS_PER_CYCLE = 5

/** Token budgets for v5 thinking pipeline */
export const LEAF_MAX_TOKENS = 7000
export const BRANCH_MAX_TOKENS = 14000
export const ROOT_MAX_TOKENS = 20000

/** LLM request timeout (60 min for CPU thinking models) */
export const LLM_TIMEOUT_MS = 60 * 60 * 1000

/** LLM temperature (fixed) */
export const LLM_TEMPERATURE = 0.3

/** Max retries for LLM calls */
export const LLM_RETRIES = 3
export const LLM_RETRY_BACKOFF_MS = 5000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ISO timestamp to minute precision, UTC: `2026-04-18T22:14Z` */
export function fmtIsoMinute(d: Date | null | undefined): string {
  if (!d) return ''
  const iso = (d instanceof Date ? d : new Date(d)).toISOString()
  return iso.slice(0, 16) + 'Z'
}

/** Legacy date formatter (kept for compatibility in branch/root formatters; can be removed later) */
export function fmtDate(d: Date | null): string {
  return d?.toISOString().split('T')[0] ?? '?'
}

/**
 * Strip lone surrogates and non-whitespace ASCII control characters
 * so the string is safe for strict JSON parsers (e.g., llama-server).
 *
 * - Removes high surrogates (U+D800..U+DBFF) not followed by a low surrogate
 * - Removes lone low surrogates (U+DC00..U+DFFF) not preceded by a high surrogate
 * - Removes ASCII control chars 0x00-0x1F except tab (0x09), newline (0x0A), CR (0x0D)
 */
export function sanitizeForJson(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\x00-\x08\x0B\x0C\x0E-\x1F]/g,
    '',
  )
}
