/**
 * Memory → Tags: the review loop. Pending suggestions grouped by session
 * (accept / reject per tag, or the whole session at once), accepted tag
 * usage, and the vocabulary with its own suggested entries and a merge
 * form. Everything here is a thin shell over /api/memory/tags.
 */

import { useMemo, useState, type JSX } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RivetGateway } from '@rivetos/gateway-client'
import type { PendingTagWire } from '@rivetos/types'
import { Button } from '../components/ui/button.js'
import { TagChip, TagChips } from '../components/tag-chips.js'
import { groupPendingBySession, tagLabel } from '../lib/session-tags.js'
import { TAG_QUERY_ROOT } from '../lib/use-session-tags.js'
import { relativeTime } from './format.js'

export function TagsView(props: {
  gateway: RivetGateway
  baseUrl: string
  onOpenSession?: (sessionId: string) => void
}): JSX.Element {
  const queryClient = useQueryClient()
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: [TAG_QUERY_ROOT, props.baseUrl] })
  }

  const pending = useQuery({
    queryKey: [TAG_QUERY_ROOT, props.baseUrl, 'pending'],
    queryFn: ({ signal }) => props.gateway.memoryTagsPending(200, signal),
    retry: false,
  })
  const counts = useQuery({
    queryKey: [TAG_QUERY_ROOT, props.baseUrl, 'counts'],
    queryFn: ({ signal }) => props.gateway.memoryTagCounts({ limit: 100 }, signal),
    retry: false,
  })
  const taxonomy = useQuery({
    queryKey: [TAG_QUERY_ROOT, props.baseUrl, 'taxonomy'],
    queryFn: ({ signal }) => props.gateway.memoryTaxonomy({}, signal),
    retry: false,
  })

  const decide = useMutation({
    mutationFn: (input: { ids: string[]; state: 'accepted' | 'rejected' }) =>
      props.gateway.memoryTagsDecide(input),
    onSettled: invalidate,
  })
  const decideTaxonomy = useMutation({
    mutationFn: (input: {
      entries: Array<{ key: string; value: string }>
      state: 'accepted' | 'rejected'
    }) => props.gateway.memoryTaxonomyDecide(input),
    onSettled: invalidate,
  })
  const merge = useMutation({
    mutationFn: (input: { key: string; from: string; into: string }) =>
      props.gateway.memoryTaxonomyMerge(input),
    onSettled: invalidate,
  })

  const groups = useMemo(() => groupPendingBySession(pending.data?.tags ?? []), [pending.data])
  const busy = decide.isPending || decideTaxonomy.isPending || merge.isPending
  const firstError =
    pending.error ??
    counts.error ??
    taxonomy.error ??
    decide.error ??
    decideTaxonomy.error ??
    merge.error

  const [mergeKey, setMergeKey] = useState('topic')
  const [mergeFrom, setMergeFrom] = useState('')
  const [mergeInto, setMergeInto] = useState('')

  const suggestedVocab = (taxonomy.data?.entries ?? []).filter((e) => e.state === 'suggested')
  const acceptedVocab = (taxonomy.data?.entries ?? []).filter((e) => e.state === 'accepted')

  return (
    <div className="pane flex flex-col gap-6">
      {firstError && <div className="banner bad">{firstError.message}</div>}

      <section>
        <div className="mb-2 flex items-center gap-2">
          <h2 className="font-mono text-sm font-semibold text-em">Suggested tags</h2>
          <span className="muted small">
            {pending.isLoading ? 'loading…' : `${String(pending.data?.tags.length ?? 0)} pending`}
          </span>
        </div>
        {pending.data && groups.length === 0 && (
          <div className="empty">
            <strong>Nothing to review</strong>
            The tagger proposes tags after each summary. Accepted tags feed recall and the wiki;
            rejected ones are never proposed again.
          </div>
        )}
        <ul className="flex flex-col gap-3">
          {groups.map((g) => {
            const ids = g.tags.map((t) => t.id)
            return (
              <li key={g.sessionKey} className="rounded border border-line bg-panel p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="min-w-0 truncate font-mono text-[12px] text-ink hover:text-em hover:underline disabled:no-underline"
                    disabled={!props.onOpenSession || !g.openable}
                    onClick={() => {
                      if (g.openable) props.onOpenSession?.(g.sessionKey)
                    }}
                    title={g.sessionKey}
                  >
                    {g.title || g.sessionKey}
                  </button>
                  {g.agent && <span className="muted small">{g.agent}</span>}
                  <span className="muted small">{relativeTime(g.tags[0].createdAt)}</span>
                  <span className="grow" />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => decide.mutate({ ids, state: 'accepted' })}
                  >
                    Accept all
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => decide.mutate({ ids, state: 'rejected' })}
                  >
                    Reject all
                  </Button>
                </div>
                <ul className="flex flex-col gap-1.5">
                  {g.tags.map((t: PendingTagWire) => (
                    <li key={t.id} className="flex flex-wrap items-center gap-2">
                      <TagChip
                        tag={t}
                        size="md"
                        busy={busy}
                        onAccept={(id) => decide.mutate({ ids: [id], state: 'accepted' })}
                        onReject={(id) => decide.mutate({ ids: [id], state: 'rejected' })}
                      />
                      {t.entityType === 'summary' && (
                        <span className="muted small" title={t.excerpt ?? ''}>
                          on a summary
                        </span>
                      )}
                      {typeof t.confidence === 'number' && (
                        <span className="mono small muted">{t.confidence.toFixed(2)}</span>
                      )}
                      {t.reason && <span className="small text-ink-dim">{t.reason}</span>}
                    </li>
                  ))}
                </ul>
              </li>
            )
          })}
        </ul>
      </section>

      <section>
        <h2 className="mb-2 font-mono text-sm font-semibold text-em">In use</h2>
        {counts.data && counts.data.counts.length === 0 && (
          <p className="muted small">No accepted tags yet.</p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {counts.data?.counts.map((c) => (
            <span
              key={`${c.key}:${c.value}`}
              className="inline-flex items-center gap-1 rounded border border-em/40 bg-em/10 px-2 py-0.5 font-mono text-[11px] text-em"
              title={`${String(c.conversations)} session${c.conversations === 1 ? '' : 's'}`}
            >
              {tagLabel({ key: c.key, value: c.value, display: c.display })}
              <span className="text-ink-dim">{c.conversations}</span>
            </span>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center gap-2">
          <h2 className="font-mono text-sm font-semibold text-em">Vocabulary</h2>
          <span className="muted small">
            {acceptedVocab.length} accepted · {suggestedVocab.length} suggested
          </span>
        </div>
        {suggestedVocab.length > 0 && (
          <div className="mb-3 flex flex-col gap-1.5">
            <p className="small text-ink-dim">
              New values the tagger used. Accept to keep them in the vocabulary.
            </p>
            <TagChips
              size="md"
              busy={busy}
              tags={suggestedVocab.map((e) => ({
                id: `${e.key}:${e.value}`,
                key: e.key,
                value: e.value,
                display: e.display,
                state: 'suggested' as const,
                source: e.source,
              }))}
              onAccept={(id) => {
                const [key, ...rest] = id.split(':')
                decideTaxonomy.mutate({
                  entries: [{ key, value: rest.join(':') }],
                  state: 'accepted',
                })
              }}
              onReject={(id) => {
                const [key, ...rest] = id.split(':')
                decideTaxonomy.mutate({
                  entries: [{ key, value: rest.join(':') }],
                  state: 'rejected',
                })
              }}
            />
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {acceptedVocab.map((e) => (
            <span
              key={`${e.key}:${e.value}`}
              className="inline-flex items-center gap-1 rounded border border-line bg-panel-2 px-2 py-0.5 font-mono text-[11px] text-ink"
              title={e.aliases.length > 0 ? `aliases: ${e.aliases.join(', ')}` : undefined}
            >
              {tagLabel(e)}
              {e.parentValue && <span className="text-ink-dim">⊂ {e.parentValue}</span>}
            </span>
          ))}
        </div>
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!mergeKey || !mergeFrom || !mergeInto) return
            merge.mutate(
              { key: mergeKey, from: mergeFrom, into: mergeInto },
              {
                onSuccess: () => {
                  setMergeFrom('')
                  setMergeInto('')
                },
              },
            )
          }}
        >
          <span className="small text-ink-dim">Merge</span>
          <input
            value={mergeKey}
            onChange={(e) => setMergeKey(e.target.value)}
            aria-label="merge key"
            className="w-20 rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[11px] text-ink"
          />
          <input
            value={mergeFrom}
            onChange={(e) => setMergeFrom(e.target.value)}
            placeholder="from value"
            aria-label="merge from"
            className="w-32 rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[11px] text-ink placeholder:text-ink-dim"
          />
          <span className="small text-ink-dim">into</span>
          <input
            value={mergeInto}
            onChange={(e) => setMergeInto(e.target.value)}
            placeholder="into value"
            aria-label="merge into"
            className="w-32 rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[11px] text-ink placeholder:text-ink-dim"
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={busy || !mergeFrom || !mergeInto}
          >
            Merge
          </Button>
          {merge.data && (
            <span className="muted small">
              moved {merge.data.moved}, dropped {merge.data.dropped}
            </span>
          )}
        </form>
      </section>
    </div>
  )
}
