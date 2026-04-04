/**
 * Expander — DAG traversal over the ros_summaries table.
 *
 * Simpler than LCM's expander: parent_id lives directly on ros_summaries
 * (no separate summary_parents join table). Children are found by
 * querying WHERE parent_id = <this>. Source messages are linked via
 * ros_summary_sources.
 *
 * Used by:
 *   - memory_expand tool (drill into summary → children + source messages)
 *   - memory_describe tool (metadata for a single summary)
 *   - memory_expand_query tool (expand context for LLM-powered answers)
 */

import pg from 'pg'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SummaryNode {
  summaryId: string
  conversationId: string | null
  kind: string
  depth: number
  content: string
  messageCount: number
  earliestAt: Date | null
  latestAt: Date | null
  createdAt: Date
  model: string | null
  accessCount: number
}

export interface SourceMessage {
  messageId: string
  role: string
  content: string
  createdAt: Date
}

export interface ExpandResult {
  summary: SummaryNode
  children: SummaryNode[]
  sourceMessages: SourceMessage[]
}

// ---------------------------------------------------------------------------
// Row interfaces
// ---------------------------------------------------------------------------

interface SummaryNodeRow {
  id: string
  conversation_id: string | null
  kind: string
  depth: number
  content: string
  message_count: number
  earliest_at: Date | null
  latest_at: Date | null
  created_at: Date
  model: string | null
  access_count: number | null
}

interface SourceMessageRow {
  id: string
  role: string
  content: string
  created_at: Date
}

// ---------------------------------------------------------------------------
// Expander
// ---------------------------------------------------------------------------

export class Expander {
  private pool: pg.Pool

  constructor(pool: pg.Pool) {
    this.pool = pool
  }

  /**
   * Describe a single summary node — metadata only.
   */
  async describe(summaryId: string): Promise<SummaryNode | null> {
    const result = await this.pool.query<SummaryNodeRow>(
      `SELECT id, conversation_id, kind, depth, content, message_count,
              earliest_at, latest_at, created_at, model, access_count
       FROM ros_summaries
       WHERE id = $1`,
      [summaryId],
    )

    if (result.rows.length === 0) return null
    return this.toNode(result.rows[0])
  }

  /**
   * Expand a summary — direct children and source messages.
   */
  async expand(summaryId: string): Promise<ExpandResult | null> {
    const summary = await this.describe(summaryId)
    if (!summary) return null

    const [children, sourceMessages] = await Promise.all([
      this.getChildren(summaryId),
      this.getSourceMessages(summaryId),
    ])

    return { summary, children, sourceMessages }
  }

  /**
   * Recursively expand to a given depth.
   *
   * Collects all source messages from the entire subtree.
   * Children at each level are preserved in the top-level result.
   */
  async expandDeep(summaryId: string, maxDepth: number = 3): Promise<ExpandResult | null> {
    const result = await this.expand(summaryId)
    if (!result || maxDepth <= 1) return result

    // Recursively expand each child and collect their source messages
    for (const child of result.children) {
      const childExpanded = await this.expandDeep(child.summaryId, maxDepth - 1)
      if (childExpanded) {
        result.sourceMessages.push(...childExpanded.sourceMessages)
      }
    }

    return result
  }

  // -----------------------------------------------------------------------
  // Internal queries
  // -----------------------------------------------------------------------

  /**
   * Get direct children: summaries whose parent_id points to this summary.
   */
  private async getChildren(summaryId: string): Promise<SummaryNode[]> {
    const result = await this.pool.query<SummaryNodeRow>(
      `SELECT id, conversation_id, kind, depth, content, message_count,
              earliest_at, latest_at, created_at, model, access_count
       FROM ros_summaries
       WHERE parent_id = $1
       ORDER BY created_at`,
      [summaryId],
    )

    return result.rows.map((r) => this.toNode(r))
  }

  /**
   * Get source messages linked via ros_summary_sources.
   */
  private async getSourceMessages(summaryId: string): Promise<SourceMessage[]> {
    const result = await this.pool.query<SourceMessageRow>(
      `SELECT m.id, m.role, m.content, m.created_at
       FROM ros_messages m
       JOIN ros_summary_sources ss ON ss.message_id = m.id
       WHERE ss.summary_id = $1
       ORDER BY ss.ordinal`,
      [summaryId],
    )

    return result.rows.map((r) => ({
      messageId: r.id,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
    }))
  }

  // -----------------------------------------------------------------------
  // Row → domain object
  // -----------------------------------------------------------------------

  private toNode(row: SummaryNodeRow): SummaryNode {
    return {
      summaryId: row.id,
      conversationId: row.conversation_id,
      kind: row.kind,
      depth: row.depth,
      content: row.content,
      messageCount: row.message_count,
      earliestAt: row.earliest_at,
      latestAt: row.latest_at,
      createdAt: row.created_at,
      model: row.model,
      accessCount: row.access_count ?? 0,
    }
  }
}
