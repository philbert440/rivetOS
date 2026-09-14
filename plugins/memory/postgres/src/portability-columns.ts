/**
 * Explicit NDJSON v1 column lists for memory export/import.
 *
 * Derived from schema/migrations/0001–0016. Omit `embedding` (re-embedded on
 * import) and generated columns (`content_tsv`). Each column comments the
 * migration that introduced it.
 */

export const EXPORT_TABLES = [
  'ros_conversations',
  'ros_messages',
  'ros_summaries',
  'ros_summary_sources',
  'ros_wiki_topics',
  'ros_wiki_redirects',
  'ros_wiki_citations',
] as const

export type ExportTable = (typeof EXPORT_TABLES)[number]

/** ros_conversations — 0001_baseline + 0011_conversation_task_id + 0013_owner_user_id */
export const ROS_CONVERSATIONS_COLUMNS = [
  'id', // 0001_baseline
  'session_key', // 0001_baseline
  'agent', // 0001_baseline
  'channel', // 0001_baseline
  'channel_id', // 0001_baseline
  'bot_identity', // 0001_baseline
  'title', // 0001_baseline
  'settings', // 0001_baseline
  'active', // 0001_baseline
  'created_at', // 0001_baseline
  'updated_at', // 0001_baseline
  'task_id', // 0011_conversation_task_id
  'owner_user_id', // 0013_owner_user_id
] as const

/** ros_messages — 0001_baseline + 0013_owner_user_id + 0014_chunks; omit embedding, content_tsv */
export const ROS_MESSAGES_COLUMNS = [
  'id', // 0001_baseline
  'conversation_id', // 0001_baseline
  'agent', // 0001_baseline
  'channel', // 0001_baseline
  'role', // 0001_baseline
  'content', // 0001_baseline
  'tool_name', // 0001_baseline
  'tool_args', // 0001_baseline
  'tool_result', // 0001_baseline
  'metadata', // 0001_baseline
  'access_count', // 0001_baseline
  'last_accessed_at', // 0001_baseline
  'created_at', // 0001_baseline
  'embed_failures', // 0001_baseline
  'embed_error', // 0001_baseline
  'embed_status', // 0001_baseline
  'owner_user_id', // 0013_owner_user_id
  'content_hash', // 0014_chunks
] as const

/** ros_summaries — 0001_baseline; omit embedding, content_tsv */
export const ROS_SUMMARIES_COLUMNS = [
  'id', // 0001_baseline
  'conversation_id', // 0001_baseline
  'parent_id', // 0001_baseline
  'depth', // 0001_baseline
  'content', // 0001_baseline
  'kind', // 0001_baseline
  'message_count', // 0001_baseline
  'earliest_at', // 0001_baseline
  'latest_at', // 0001_baseline
  'model', // 0001_baseline
  'access_count', // 0001_baseline
  'last_accessed_at', // 0001_baseline
  'created_at', // 0001_baseline
  'embed_failures', // 0001_baseline
  'embed_error', // 0001_baseline
  'pipeline_version', // 0001_baseline
  'embed_status', // 0001_baseline
] as const

/** ros_summary_sources — 0001_baseline */
export const ROS_SUMMARY_SOURCES_COLUMNS = [
  'summary_id', // 0001_baseline
  'message_id', // 0001_baseline
  'ordinal', // 0001_baseline
] as const

/** ros_wiki_topics — 0005_wiki + 0007_wiki_article; omit embedding, content_tsv */
export const ROS_WIKI_TOPICS_COLUMNS = [
  'slug', // 0005_wiki
  'title', // 0005_wiki
  'aliases', // 0005_wiki
  'tags', // 0005_wiki
  'entities', // 0005_wiki
  'current_state', // 0005_wiki
  'search_text', // 0005_wiki
  'embed_status', // 0005_wiki
  'embed_failures', // 0005_wiki
  'embed_error', // 0005_wiki
  'history_count', // 0005_wiki
  'git_sha', // 0005_wiki
  'last_verified_at', // 0005_wiki
  'created_at', // 0005_wiki
  'updated_at', // 0005_wiki
  'article', // 0007_wiki_article
  'related', // 0007_wiki_article
] as const

/** ros_wiki_redirects — 0006_wiki_durable_topics */
export const ROS_WIKI_REDIRECTS_COLUMNS = [
  'from_slug', // 0006_wiki_durable_topics
  'to_slug', // 0006_wiki_durable_topics
  'created_at', // 0006_wiki_durable_topics
] as const

/** ros_wiki_citations — 0006_wiki_durable_topics */
export const ROS_WIKI_CITATIONS_COLUMNS = [
  'topic_slug', // 0006_wiki_durable_topics
  'summary_id', // 0006_wiki_durable_topics
  'kind', // 0006_wiki_durable_topics
  'note', // 0006_wiki_durable_topics
  'cited_at', // 0006_wiki_durable_topics
] as const

export const EXPORT_COLUMNS: Record<ExportTable, readonly string[]> = {
  ros_conversations: ROS_CONVERSATIONS_COLUMNS,
  ros_messages: ROS_MESSAGES_COLUMNS,
  ros_summaries: ROS_SUMMARIES_COLUMNS,
  ros_summary_sources: ROS_SUMMARY_SOURCES_COLUMNS,
  ros_wiki_topics: ROS_WIKI_TOPICS_COLUMNS,
  ros_wiki_redirects: ROS_WIKI_REDIRECTS_COLUMNS,
  ros_wiki_citations: ROS_WIKI_CITATIONS_COLUMNS,
}

/**
 * Timestamp column used by `--since` filters on the row itself.
 * Export still computes a dependency closure (see `selectTableSql`): junction
 * rows are included only when both ends are in the dump; wiki is full unless
 * `--since` is set, in which case topics changed since + their citations/redirects.
 */
export const EXPORT_SINCE_COLUMN: Partial<Record<ExportTable, string>> = {
  ros_conversations: 'created_at', // plus updated_at in selectTableSql closure
  ros_messages: 'created_at',
  ros_summaries: 'created_at',
  ros_wiki_topics: 'created_at',
  ros_wiki_redirects: 'created_at',
  ros_wiki_citations: 'cited_at',
}
