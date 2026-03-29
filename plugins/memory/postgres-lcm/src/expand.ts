/**
 * LCM Expander — DAG traversal over the summary tree.
 *
 * Replicates lcm_expand and lcm_describe functionality.
 * Walks summary_parents downward, then summary_messages for leaf content.
 */

import pg from 'pg';

export interface SummaryNode {
  summaryId: string;
  conversationId: number;
  kind: string;
  depth: number;
  content: string;
  tokenCount: number;
  earliestAt: Date | null;
  latestAt: Date | null;
  descendantCount: number;
  createdAt: Date;
  model: string;
}

export interface ExpandResult {
  summary: SummaryNode;
  children: SummaryNode[];
  sourceMessages: Array<{ messageId: number; role: string; content: string; createdAt: Date }>;
}

export class LcmExpander {
  private pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /**
   * Describe a summary — metadata + lineage.
   */
  async describe(summaryId: string): Promise<SummaryNode | null> {
    const result = await this.pool.query(
      `SELECT summary_id, conversation_id, kind, depth, content, token_count,
              earliest_at, latest_at, descendant_count, created_at, model
       FROM summaries WHERE summary_id = $1`,
      [summaryId],
    );

    if (result.rows.length === 0) return null;
    return this.mapNode(result.rows[0]);
  }

  /**
   * Expand a summary — get children and source messages.
   */
  async expand(summaryId: string, maxDepth: number = 3): Promise<ExpandResult | null> {
    const summary = await this.describe(summaryId);
    if (!summary) return null;

    // Get child summaries
    const children = await this.getChildren(summaryId);

    // Get source messages (leaf nodes)
    const sourceMessages = await this.getSourceMessages(summaryId);

    return { summary, children, sourceMessages };
  }

  /**
   * Recursively expand to a given depth.
   */
  async expandDeep(summaryId: string, maxDepth: number = 3): Promise<ExpandResult | null> {
    const result = await this.expand(summaryId);
    if (!result || maxDepth <= 1) return result;

    // Recursively expand children
    for (const child of result.children) {
      const childExpanded = await this.expandDeep(child.summaryId, maxDepth - 1);
      if (childExpanded) {
        result.sourceMessages.push(...childExpanded.sourceMessages);
      }
    }

    return result;
  }

  /**
   * Get direct children of a summary.
   */
  private async getChildren(summaryId: string): Promise<SummaryNode[]> {
    const result = await this.pool.query(
      `SELECT s.summary_id, s.conversation_id, s.kind, s.depth, s.content, s.token_count,
              s.earliest_at, s.latest_at, s.descendant_count, s.created_at, s.model
       FROM summaries s
       JOIN summary_parents sp ON sp.summary_id = s.summary_id
       WHERE sp.parent_summary_id = $1
       ORDER BY sp.ordinal`,
      [summaryId],
    );

    return result.rows.map(this.mapNode);
  }

  /**
   * Get source messages linked to a summary.
   */
  private async getSourceMessages(
    summaryId: string,
  ): Promise<Array<{ messageId: number; role: string; content: string; createdAt: Date }>> {
    const result = await this.pool.query(
      `SELECT m.message_id, m.role, m.content, m.created_at
       FROM messages m
       JOIN summary_messages sm ON sm.message_id = m.message_id
       WHERE sm.summary_id = $1
       ORDER BY sm.ordinal`,
      [summaryId],
    );

    return result.rows.map((r) => ({
      messageId: r.message_id,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
    }));
  }

  private mapNode(row: any): SummaryNode {
    return {
      summaryId: row.summary_id,
      conversationId: row.conversation_id,
      kind: row.kind,
      depth: row.depth,
      content: row.content,
      tokenCount: row.token_count,
      earliestAt: row.earliest_at,
      latestAt: row.latest_at,
      descendantCount: row.descendant_count,
      createdAt: row.created_at,
      model: row.model,
    };
  }
}
