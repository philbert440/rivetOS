#!/usr/bin/env node
/**
 * Bootstrap the memory-wiki git repo (phase 3a) — idempotent.
 * Usage: node scripts/wiki-init.mjs [/rivet-shared/wiki]
 * Creates the repo skeleton + README; seed pages come from extraction (3c+).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] ?? '/rivet-shared/wiki'
const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' }).toString()

mkdirSync(join(root, 'topics'), { recursive: true })
if (!existsSync(join(root, '.git'))) {
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' })
  git('config', 'user.name', 'RivetOS Wiki')
  git('config', 'user.email', 'wiki@rivetos.dev')
}
const readme = join(root, 'README.md')
if (!existsSync(readme)) {
  writeFileSync(
    readme,
    [
      '# RivetOS Memory Wiki',
      '',
      'Topic pages distilled from conversation memory by the compaction worker',
      '(single writer: the datahub node). One markdown file per topic under',
      '`topics/<slug>.md`: YAML frontmatter (provenance back to PG UUIDs), a',
      'replaceable `## Current state`, and an append-only dated `## History`.',
      '',
      'Humans may edit freely — the extractor auto-merges: your prior Current',
      'state is archived to History, never silently lost.',
      '',
      'Served by the gateway at `/api/wiki` (and as the landing page on the',
      'datahub node). Design: /rivet-shared/plans/phase-3-memory-wiki-design.md',
      '',
    ].join('\n'),
  )
  git('add', '-A')
  git('commit', '-m', 'wiki: bootstrap repo skeleton')
}
console.log(`wiki repo ready at ${root} (${git('rev-parse', '--short', 'HEAD').trim()})`)
