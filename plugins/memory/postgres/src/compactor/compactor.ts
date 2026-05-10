/**
 * Compactor formatters — exact spec from pr-spec.md §1.2.
 *
 * The actual compaction worker lives at `services/compaction-worker/` (graphile-worker
 * service). This file only retains the prompt-formatting functions that the worker
 * imports from `@rivetos/memory-postgres`.
 */

import {
  fmtIsoMinute,
  sanitizeForJson,
  type CompactMessageRow,
  type ConversationMeta,
  type SummaryRow,
} from './types.js'

export function formatLeafPrompt(conv: ConversationMeta, msgs: CompactMessageRow[]): string {
  const span = msgs.length
    ? `${fmtIsoMinute(msgs[0].created_at)} → ${fmtIsoMinute(msgs[msgs.length - 1].created_at)}`
    : ''
  const preamble = [
    `[conversation]`,
    `  id:        ${conv.id}`,
    `  agent:     ${conv.agent ?? 'unknown'}`,
    `  channel:   ${conv.channel ?? 'unknown'}${conv.channel_id ? ` (${conv.channel_id})` : ''}`,
    conv.title ? `  title:     ${conv.title}` : null,
    `  span:      ${span}`,
    `  messages:  ${msgs.length} in this batch`,
  ]
    .filter(Boolean)
    .join('\n')

  const body = msgs
    .map((m, i) => {
      const idx = String(i + 1).padStart(2, '0')
      const when = fmtIsoMinute(m.created_at)
      const role = m.role || 'unknown'
      const agent = m.agent ? `${m.agent}/` : ''

      let content = m.content ?? ''
      if (!content && m.tool_name) {
        // Bounded excerpt of tool_args — fallback only. Tool-call messages
        // should normally have natural-language `content` written by the
        // tool-synth pipeline; we only hit this branch when synthesis
        // hasn't run yet or failed. Cap at 2000 chars because raw JSON
        // blobs (shell stdout, diff payloads, large embeddings) have low
        // per-char information density and would otherwise dominate the
        // leaf-prompt budget.
        const args = m.tool_args ? JSON.stringify(m.tool_args).slice(0, 2000) : ''
        content = `(tool call) ${m.tool_name}${args ? ' ' + args : ''}`
      }

      const sep = i < msgs.length - 1 ? '\n\n---\n\n' : ''
      return `[#${idx} ${when} ${agent}${role}]\n${sanitizeForJson(content)}${sep}`
    })
    .join('')

  return `${preamble}\n\n---\n\n${body}`
}

export function formatBranchPrompt(conv: ConversationMeta, leaves: SummaryRow[]): string {
  const span = leaves.length
    ? `${fmtIsoMinute(leaves[0].earliest_at ?? leaves[0].created_at)} → ${fmtIsoMinute(
        leaves[leaves.length - 1].latest_at ?? leaves[leaves.length - 1].created_at,
      )}`
    : ''
  const preamble = [
    `[conversation]`,
    `  id:        ${conv.id}`,
    `  agent:     ${conv.agent ?? 'unknown'}`,
    `  channel:   ${conv.channel ?? 'unknown'}${conv.channel_id ? ` (${conv.channel_id})` : ''}`,
    conv.title ? `  title:     ${conv.title}` : null,
    `  leaves:    ${leaves.length} in this branch`,
    `  span:      ${span}`,
  ]
    .filter(Boolean)
    .join('\n')

  const body = leaves
    .map((s, i) => {
      const idx = String(i + 1).padStart(2, '0')
      const from = fmtIsoMinute(s.earliest_at ?? s.created_at)
      const to = fmtIsoMinute(s.latest_at ?? s.created_at)
      const msgs = s.message_count
      const sep = i < leaves.length - 1 ? '\n\n---\n\n' : ''
      return `[Leaf #${idx} ${from} → ${to} | ${msgs} msgs]\n${sanitizeForJson(s.content)}${sep}`
    })
    .join('')

  return `${preamble}\n\n---\n\n${body}`
}

export function formatRootPrompt(conv: ConversationMeta, branches: SummaryRow[]): string {
  const span = branches.length
    ? `${fmtIsoMinute(branches[0].earliest_at ?? branches[0].created_at)} → ${fmtIsoMinute(
        branches[branches.length - 1].latest_at ?? branches[branches.length - 1].created_at,
      )}`
    : ''
  const preamble = [
    `[conversation]`,
    `  id:        ${conv.id}`,
    `  agent:     ${conv.agent ?? 'unknown'}`,
    `  channel:   ${conv.channel ?? 'unknown'}${conv.channel_id ? ` (${conv.channel_id})` : ''}`,
    conv.title ? `  title:     ${conv.title}` : null,
    `  branches:  ${branches.length} in this root`,
    `  span:      ${span}`,
  ]
    .filter(Boolean)
    .join('\n')

  const body = branches
    .map((s, i) => {
      const idx = String(i + 1).padStart(2, '0')
      const from = fmtIsoMinute(s.earliest_at ?? s.created_at)
      const to = fmtIsoMinute(s.latest_at ?? s.created_at)
      const msgs = s.message_count
      const sep = i < branches.length - 1 ? '\n\n---\n\n' : ''
      return `[Branch #${idx} ${from} → ${to} | ${msgs} msgs]\n${sanitizeForJson(s.content)}${sep}`
    })
    .join('')

  return `${preamble}\n\n---\n\n${body}`
}
