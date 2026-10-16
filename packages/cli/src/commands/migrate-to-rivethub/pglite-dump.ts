/**
 * Dump the memory tables of an embedded (PGlite) install for RivetHub's
 * one-time SQLite import (`rivethub-migrate sqlite --import-pg-dump`).
 *
 * The importer reads plain `pg_dump --data-only` output: COPY … FROM stdin
 * blocks, the usual SET preamble and the completion footer. PGlite's own
 * pg_dump build (@electric-sql/pglite-tools) always adds `--inserts`, which
 * the importer refuses, so the dump is written here in the same plain format
 * from Postgres's own COPY text output (`COPY … TO '/dev/blob'` on the
 * engine this install already runs). Values are exactly what pg_dump would
 * write; only the envelope is assembled here.
 */

import { chmodSync, writeFileSync } from 'node:fs'
import type { EmbeddedPgQueryResult } from '@rivetos/boot'

/**
 * The tables the importer accepts, in the order pg_dump would emit them for
 * the memory schema. Mirrors RivetHub's ImportTable (memory-sqlite crate)
 * without the SQLite-local jobs/meta/embed-queue tables. Tables missing on an
 * older schema are skipped.
 */
export const MEMORY_DUMP_TABLES = [
  'ros_conversations',
  'ros_messages',
  'ros_summaries',
  'ros_summary_sources',
  'ros_tags',
  'ros_tag_taxonomy',
  'ros_wiki_topics',
  'ros_wiki_provenance',
  'ros_wiki_extractions',
  'ros_wiki_citations',
  'ros_wiki_redirects',
] as const

/** The pg_dump arguments RivetHub prints when it asks for this dump. */
export function pgDumpEquivalentArgs(): string[] {
  return [
    '--data-only',
    '--format=plain',
    '--no-owner',
    '--no-privileges',
    ...MEMORY_DUMP_TABLES.map((t) => `--table=public.${t}`),
  ]
}

export type QueryFn = (sql: string) => Promise<EmbeddedPgQueryResult>

const HEADER = [
  '--',
  '-- PostgreSQL database dump (RivetOS migrate-to-rivethub, memory tables)',
  `-- Equivalent: pg_dump ${pgDumpEquivalentArgs().join(' ')}`,
  '--',
  '',
  'SET statement_timeout = 0;',
  'SET lock_timeout = 0;',
  'SET idle_in_transaction_session_timeout = 0;',
  "SET client_encoding = 'UTF8';",
  'SET standard_conforming_strings = on;',
  "SELECT pg_catalog.set_config('search_path', '', false);",
  'SET check_function_bodies = false;',
  'SET xmloption = content;',
  'SET client_min_messages = warning;',
  'SET row_security = off;',
  '',
]

function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export interface DumpResult {
  text: string
  rows: Record<string, number>
}

/**
 * Build the dump from an owned PGlite session. Runs in one read-only
 * transaction so every table is read from the same snapshot; timestamps are
 * written in UTC and floats with pg_dump's extra_float_digits.
 */
export async function buildMemoryDump(query: QueryFn): Promise<DumpResult> {
  const out: string[] = [...HEADER]
  const rows: Record<string, number> = {}
  await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    await query("SET LOCAL TimeZone = 'UTC'")
    await query("SET LOCAL DateStyle = 'ISO, MDY'")
    await query("SET LOCAL IntervalStyle = 'postgres'")
    await query('SET LOCAL extra_float_digits = 3')
    for (const table of MEMORY_DUMP_TABLES) {
      const cols = await query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ${literal(table)}
            AND is_generated = 'NEVER'
          ORDER BY ordinal_position`,
      )
      const names = cols.rows.map((r) => String(r.column_name))
      if (names.length === 0) continue
      const list = names.map(quoteIdent).join(', ')
      const copied = await query(`COPY public.${table} (${list}) TO '/dev/blob'`)
      const body = copied.blob ? await copied.blob.text() : ''
      const count = body === '' ? 0 : body.split('\n').length - (body.endsWith('\n') ? 1 : 0)
      rows[table] = count
      out.push('--', `-- Data for Name: ${table}; Type: TABLE DATA; Schema: public; Owner: -`, '--')
      out.push('', `COPY public.${table} (${list}) FROM stdin;`)
      out.push(body.endsWith('\n') || body === '' ? `${body}\\.` : `${body}\n\\.`)
      out.push('', '')
    }
  } finally {
    await query('COMMIT')
  }
  out.push('--', '-- PostgreSQL database dump complete', '--', '')
  return { text: out.join('\n'), rows }
}

/**
 * Open the install's PGlite engine (it must not be running — the service is
 * stopped first) and write the memory dump to `outPath` with mode 0600.
 */
export async function dumpPgliteMemory(configPath: string, outPath: string): Promise<DumpResult> {
  const { readEmbeddedConfig, withEmbeddedPg } = await import('../../lib/embedded.js')
  const embedded = readEmbeddedConfig(configPath)
  if (!embedded) throw new Error(`${configPath} has no memory.postgres.embedded block`)
  return withEmbeddedPg(embedded.config, async (handle) => {
    if (!handle.owned || !handle.query) {
      throw new Error(
        'the PGlite engine is owned by another process — stop the RivetOS runtime first',
      )
    }
    const result = await buildMemoryDump(handle.query)
    writeFileSync(outPath, result.text, { mode: 0o600 })
    chmodSync(outPath, 0o600)
    return result
  })
}
