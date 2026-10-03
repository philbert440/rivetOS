/**
 * memory_tags — one MCP tool over the tag store, for agents and the den's
 * POST /api/memory/tool/memory_tags. Actions mirror the HTTP routes so an
 * agent can review suggestions, accept or reject them, tag a session, and
 * look at the vocabulary without leaving the tool surface.
 */

import type pg from 'pg'
import { formatTag, type Tool } from '@rivetos/types'
import {
  addTag,
  decideTags,
  decideTaxonomy,
  isEntityType,
  isTagState,
  listTags,
  listTaxonomy,
  mergeTaxonomyValue,
  pendingTags,
  tagCounts,
  tagsForSessionKeys,
  upsertTaxonomy,
} from '../tags/store.js'

export const TAGS_ACTIONS = [
  'list',
  'pending',
  'counts',
  'decide',
  'add',
  'lookup',
  'taxonomy',
  'taxonomy_upsert',
  'taxonomy_decide',
  'taxonomy_merge',
] as const

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
}

/** Same cap as POST /api/memory/tags/decide. */
const MAX_DECIDE_IDS = 1000

/** Actions that change tags or the vocabulary. */
export const TAGS_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  'decide',
  'add',
  'taxonomy_upsert',
  'taxonomy_decide',
  'taxonomy_merge',
])

export interface TagsToolOptions {
  decidedBy?: string
  /**
   * Allow the mutating actions. Off by default: agents get a read-only tool,
   * the same way memory_append / memory_ingest_session are not part of the
   * always-on read set. The den's tool route turns it on.
   */
  allowWrite?: boolean
  /**
   * Record every decision as this identity and ignore a caller-supplied
   * `decided_by`. Set for a routed user: they are always recorded as themselves.
   */
  fixedDecider?: string
}

/** What a read-only surface answers to a mutating action. */
export function tagsReadOnlyRefusal(action: string): string {
  return `memory_tags: "${action}" is not available here (read-only surface). Review and edit tags in the hub under Memory → Tags.`
}

export function createTagsTool(pool: pg.Pool, opts: TagsToolOptions = {}): Tool {
  const decidedBy = opts.fixedDecider ?? opts.decidedBy ?? 'mcp'
  const who = (args: Record<string, unknown>): string =>
    opts.fixedDecider ?? str(args.decided_by) ?? decidedBy
  const allowWrite = opts.allowWrite === true
  return {
    name: 'memory_tags',
    description:
      'Read and decide key:value tags on sessions and summaries (session tagging). ' +
      'Actions: list (tags on an entity / by key+value), pending (suggestions awaiting review), ' +
      'counts (accepted usage per tag), decide (accept/reject suggestion ids), add (tag a session ' +
      'yourself; born accepted), lookup (tags for session_keys), taxonomy (vocabulary), ' +
      'taxonomy_upsert / taxonomy_decide / taxonomy_merge (edit the vocabulary). ' +
      (allowWrite
        ? ''
        : 'This surface is READ-ONLY: decide, add and the taxonomy_* edits are refused here. ') +
      'Rejecting keeps the row so the tagger never re-proposes it. Use tag=key:value on ' +
      'memory_search / memory_browse to filter by an accepted tag.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...TAGS_ACTIONS],
          description: 'What to do (default: pending)',
        },
        entity_type: { type: 'string', enum: ['conversation', 'summary'] },
        entity_id: { type: 'string', description: 'Conversation or summary id (list/add)' },
        session_key: {
          type: 'string',
          description: 'add: tag the conversation captured under this session key',
        },
        agent: { type: 'string', description: 'add with session_key: narrow to one agent' },
        key: { type: 'string', description: 'Tag key, e.g. project, topic' },
        value: { type: 'string', description: 'Tag value' },
        tag: { type: 'string', description: 'key:value literal (add)' },
        display: { type: 'string', description: 'Display casing (add / taxonomy_upsert)' },
        state: {
          type: 'string',
          enum: ['suggested', 'accepted', 'rejected'],
          description: 'decide / taxonomy_decide: accepted or rejected. list/taxonomy: filter.',
        },
        ids: { type: 'array', items: { type: 'string' }, description: 'Tag ids (decide)' },
        session_keys: { type: 'array', items: { type: 'string' }, description: 'lookup' },
        entries: {
          type: 'array',
          items: { type: 'object' },
          description: 'taxonomy_decide: [{key, value}]',
        },
        parent_value: { type: 'string', description: 'taxonomy_upsert: nest under this value' },
        aliases: {
          type: 'array',
          items: { type: 'string' },
          description: 'taxonomy_upsert: replaces the alias list ([] clears it; omit to keep it)',
        },
        from: { type: 'string', description: 'taxonomy_merge: value to fold away' },
        into: { type: 'string', description: 'taxonomy_merge: value that survives' },
        reason: { type: 'string' },
        decided_by: { type: 'string', description: 'decide/add: who decided (audit column)' },
        limit: { type: 'number' },
      },
      required: [],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const action = (str(args.action) ?? 'pending') as (typeof TAGS_ACTIONS)[number]
      const limit = typeof args.limit === 'number' ? args.limit : undefined
      if (!allowWrite && TAGS_WRITE_ACTIONS.has(action)) {
        return tagsReadOnlyRefusal(action)
      }
      // A state that is given must be a real one; a typo is not "no filter".
      if (args.state !== undefined && args.state !== null && !isTagState(args.state)) {
        return 'bad state (suggested, accepted or rejected)'
      }
      try {
        switch (action) {
          case 'list': {
            const entityType = args.entity_type
            if (entityType !== undefined && !isEntityType(entityType)) return 'bad entity_type'
            const tags = await listTags(pool, {
              ...(isEntityType(entityType) ? { entityType } : {}),
              entityId: str(args.entity_id),
              key: str(args.key),
              value: str(args.value),
              states: isTagState(args.state) ? [args.state] : undefined,
              limit,
            })
            if (tags.length === 0) return 'No tags.'
            return tags
              .map(
                (t) =>
                  `${t.id}  ${formatTag(t)}  [${t.state}/${t.source}] ${t.entityType}:${t.entityId}`,
              )
              .join('\n')
          }
          case 'pending': {
            const tags = await pendingTags(pool, limit ?? 50)
            if (tags.length === 0) return 'No pending tag suggestions.'
            return (
              `${String(tags.length)} pending (decide with action=decide, ids=[…], state=accepted|rejected):\n` +
              tags
                .map((t) => {
                  const where =
                    t.entityType === 'conversation'
                      ? `session ${t.sessionKey ?? t.entityId}${t.title ? ` "${t.title}"` : ''}`
                      : `summary ${t.entityId.slice(0, 8)} of ${t.sessionKey ?? t.conversationId ?? '?'}`
                  const conf = t.confidence === undefined ? '' : ` (${t.confidence.toFixed(2)})`
                  return `${t.id}  ${formatTag(t)}${conf}  ← ${where}${t.reason ? `\n    ${t.reason}` : ''}`
                })
                .join('\n')
            )
          }
          case 'counts': {
            const counts = await tagCounts(pool, str(args.key), limit ?? 200)
            if (counts.length === 0) return 'No accepted tags yet.'
            return counts.map((c) => `${formatTag(c)}  ${String(c.conversations)}`).join('\n')
          }
          case 'decide': {
            const ids = strs(args.ids)
            const state = args.state
            if (ids.length === 0) return 'ids required'
            if (ids.length > MAX_DECIDE_IDS) return `at most ${String(MAX_DECIDE_IDS)} ids`
            if (state !== 'accepted' && state !== 'rejected')
              return 'state must be accepted or rejected'
            const changed = await decideTags(pool, ids, state, who(args))
            return `${String(changed.length)} tag(s) ${state}.`
          }
          case 'add': {
            if (
              !isEntityType(args.entity_type) ||
              (!str(args.entity_id) && !str(args.session_key))
            ) {
              return 'entity_type and entity_id (or session_key) required'
            }
            const tag = await addTag(
              pool,
              {
                entityType: args.entity_type,
                entityId: str(args.entity_id),
                sessionKey: str(args.session_key),
                agent: str(args.agent),
                tag: str(args.tag),
                key: str(args.key),
                value: str(args.value),
                display: str(args.display),
                reason: str(args.reason),
              },
              who(args),
            )
            return `Added ${formatTag(tag)} to ${tag.entityType} ${tag.entityId} (${tag.id}).`
          }
          case 'lookup': {
            const keys = strs(args.session_keys)
            if (keys.length === 0) return 'session_keys required'
            if (keys.length > 500) return 'at most 500 session_keys'
            const map = await tagsForSessionKeys(pool, keys)
            return keys
              .map((k) => {
                const tags = map.get(k) ?? []
                return `${k}: ${tags.length === 0 ? '(none)' : tags.map((t) => `${formatTag(t)}${t.state === 'suggested' ? '?' : ''}`).join(', ')}`
              })
              .join('\n')
          }
          case 'taxonomy': {
            const entries = await listTaxonomy(pool, {
              key: str(args.key),
              states: isTagState(args.state) ? [args.state] : undefined,
              limit,
            })
            if (entries.length === 0) return 'Empty vocabulary.'
            return entries
              .map(
                (e) =>
                  `${formatTag(e)}${e.parentValue ? ` ⊂ ${e.key}:${e.parentValue}` : ''}  [${e.state}]` +
                  (e.aliases.length > 0 ? `  aliases: ${e.aliases.join(', ')}` : ''),
              )
              .join('\n')
          }
          case 'taxonomy_upsert': {
            if (!str(args.key) || !str(args.value)) return 'key and value required'
            const entry = await upsertTaxonomy(pool, {
              key: args.key as string,
              value: args.value as string,
              display: str(args.display),
              parentValue: args.parent_value === null ? null : str(args.parent_value),
              aliases: Array.isArray(args.aliases) ? strs(args.aliases) : undefined,
              state: isTagState(args.state) ? args.state : undefined,
              reason: str(args.reason),
            })
            return `Vocabulary: ${formatTag(entry)} [${entry.state}]`
          }
          case 'taxonomy_decide': {
            const entries = Array.isArray(args.entries)
              ? args.entries.filter(
                  (e): e is { key: string; value: string } =>
                    typeof e === 'object' &&
                    e !== null &&
                    typeof (e as { key?: unknown }).key === 'string' &&
                    typeof (e as { value?: unknown }).value === 'string',
                )
              : []
            if (entries.length === 0) return 'entries required'
            if (args.state !== 'accepted' && args.state !== 'rejected')
              return 'state must be accepted or rejected'
            return `${String(await decideTaxonomy(pool, entries, args.state))} vocabulary entr(y|ies) ${args.state}.`
          }
          case 'taxonomy_merge': {
            if (!str(args.key) || !str(args.from) || !str(args.into))
              return 'key, from and into required'
            const r = await mergeTaxonomyValue(
              pool,
              args.key as string,
              args.from as string,
              args.into as string,
            )
            return `Merged ${args.key as string}:${args.from as string} into ${args.key as string}:${args.into as string}: ${String(r.moved)} tag(s) moved, ${String(r.dropped)} duplicate(s) dropped.`
          }
          default:
            return `Unknown action "${String(action)}". One of: ${TAGS_ACTIONS.join(', ')}`
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        // Before migration 0019 there are no tag tables: say so, like the
        // HTTP routes do, instead of surfacing a relation error.
        if (/relation "?ros_tag[a-z_]*"? does not exist/i.test(msg)) {
          return TAGS_WRITE_ACTIONS.has(action)
            ? 'memory_tags: session tagging is not installed on this database yet (migration 0019).'
            : 'No tags (session tagging is not installed on this database yet).'
        }
        return `memory_tags failed: ${msg}`
      }
    },
  }
}
