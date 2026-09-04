/**
 * Presentational model for the Memory wiki hub / topic chrome.
 *
 * Wide layout stays the existing aside + panels. Narrow (phone) stacks a
 * one-row title+search header, chip views, and compact topic rows.
 * Pure helpers so the layout rules can fail a unit test on revert.
 */

import { stalenessLabel } from './wiki-base.js'

export type HubView = 'main' | 'all' | 'recent' | 'gaps'

export type WikiShellMode = 'aside' | 'stacked'
export type TocMode = 'panel' | 'disclosure'
export type TopicRowDensity = 'full' | 'compact'

export interface HubViewTab {
  id: HubView
  /** Desktop wiki-aside label — pixel-identical to the pre-narrow chrome. */
  label: string
  /** Narrow chip label. */
  shortLabel: string
}

export interface TopicRowModel {
  title: string
  slug: string
  href: string
  excerpt: string
  staleness: ReturnType<typeof stalenessLabel>
}

/** Main / all / recent / gaps — order is the wiki nav contract. */
export function hubViewTabs(total?: number): HubViewTab[] {
  return [
    { id: 'main', label: 'Main page', shortLabel: 'Main' },
    {
      id: 'all',
      label: total !== undefined ? `All topics (${String(total)})` : 'All topics',
      shortLabel: 'All',
    },
    { id: 'recent', label: 'Recent changes', shortLabel: 'Recent' },
    { id: 'gaps', label: 'Gaps', shortLabel: 'Gaps' },
  ]
}

/** Title + staleness (+ excerpt) for a tappable hub row → `/memory/$slug`. */
export function topicRowModel(t: {
  title: string
  slug: string
  updatedAt?: string
  excerpt?: string
}): TopicRowModel {
  return {
    title: t.title,
    slug: t.slug,
    href: `/memory/${t.slug}`,
    excerpt: t.excerpt || t.slug,
    staleness: stalenessLabel(t.updatedAt),
  }
}

/** Aside wiki nav on wide; stacked title+search+chips on narrow. */
export function wikiShellMode(narrow: boolean): WikiShellMode {
  return narrow ? 'stacked' : 'aside'
}

/** Side/in-flow Contents panel on wide; collapsible disclosure on narrow. */
export function tocMode(narrow: boolean): TocMode {
  return narrow ? 'disclosure' : 'panel'
}

/** Full row (title, badge, excerpt) on wide; title+staleness only on narrow. */
export function topicRowDensity(narrow: boolean): TopicRowDensity {
  return narrow ? 'compact' : 'full'
}
