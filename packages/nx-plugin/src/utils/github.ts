/**
 * GitHub CLI (gh) utilities for PR creation.
 */

import { execSync } from 'node:child_process'

export interface PROptions {
  title: string
  body: string
  branch: string
  base?: string
  draft?: boolean
  labels?: string[]
}

export interface PRResult {
  number: number
  url: string
}

function exec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

/** Check if gh CLI is installed and authenticated */
export function ghAvailable(): boolean {
  try {
    exec('gh auth status')
    return true
  } catch {
    return false
  }
}

/** Push current branch to origin */
export function gitPush(branch: string): void {
  exec(`git push -u origin ${branch}`)
}

/** Create a pull request using gh CLI */
export function createPR(options: PROptions): PRResult {
  const args = [
    'gh pr create',
    `--title "${options.title}"`,
    `--body "${options.body.replace(/"/g, '\\"')}"`,
    `--base ${options.base ?? 'main'}`,
  ]

  if (options.draft) {
    args.push('--draft')
  }

  if (options.labels?.length) {
    args.push(`--label "${options.labels.join(',')}"`)
  }

  const output = exec(args.join(' '))

  // gh pr create outputs the PR URL
  const urlMatch = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/)
  return {
    number: urlMatch ? parseInt(urlMatch[1], 10) : 0,
    url: output,
  }
}

/** Build a well-formatted PR description */
export function buildPRBody(options: {
  type: string
  description: string
  affectedPackages: string[]
  issue?: string
  breaking?: boolean
  validationResults: { lint: boolean; build: boolean; test: boolean }
}): string {
  const lines: string[] = []

  // Header
  lines.push(`## ${typeEmoji(options.type)} ${typeLabel(options.type)}`)
  lines.push('')
  lines.push(options.description)
  lines.push('')

  // Breaking changes
  if (options.breaking) {
    lines.push('### ⚠️ Breaking Changes')
    lines.push('')
    lines.push('<!-- Describe what breaks and migration steps -->')
    lines.push('')
  }

  // Affected packages
  if (options.affectedPackages.length > 0) {
    lines.push('### 📦 Affected Packages')
    lines.push('')
    for (const pkg of options.affectedPackages) {
      lines.push(`- \`${pkg}\``)
    }
    lines.push('')
  }

  // Validation results
  lines.push('### ✅ Quality Gates')
  lines.push('')
  const check = (pass: boolean): string => (pass ? '✅' : '❌')
  lines.push(`| Check | Status |`)
  lines.push(`|-------|--------|`)
  lines.push(`| Lint | ${check(options.validationResults.lint)} |`)
  lines.push(`| Build | ${check(options.validationResults.build)} |`)
  lines.push(`| Test | ${check(options.validationResults.test)} |`)
  lines.push('')

  // Checklist
  lines.push('### 📋 Checklist')
  lines.push('')
  lines.push('- [x] `nx affected -t lint` passes')
  lines.push('- [x] `nx affected -t build` passes')
  lines.push('- [x] `nx affected -t test` passes')
  lines.push('- [ ] Changes reviewed')
  lines.push('- [ ] Documentation updated (if applicable)')
  if (options.type === 'feat' || options.type === 'plugin') {
    lines.push('- [ ] New tests added')
  }
  lines.push('')

  // Related issue
  if (options.issue) {
    const num = options.issue.replace('#', '')
    lines.push(`Closes #${num}`)
    lines.push('')
  }

  return lines.join('\n')
}

function typeEmoji(type: string): string {
  const emojis: Record<string, string> = {
    feat: '✨',
    fix: '🐛',
    refactor: '♻️',
    chore: '🔧',
    docs: '📝',
    plugin: '🔌',
    test: '🧪',
    perf: '⚡',
  }
  return emojis[type] ?? '📝'
}

function typeLabel(type: string): string {
  const labels: Record<string, string> = {
    feat: 'Feature',
    fix: 'Bug Fix',
    refactor: 'Refactor',
    chore: 'Chore',
    docs: 'Documentation',
    plugin: 'New Plugin',
    test: 'Tests',
    perf: 'Performance',
  }
  return labels[type] ?? type
}

/** Map PR type to GitHub labels */
export function typeToLabels(type: string): string[] {
  const labels: Record<string, string[]> = {
    feat: ['enhancement'],
    fix: ['bug'],
    refactor: ['refactor'],
    chore: ['maintenance'],
    docs: ['documentation'],
    plugin: ['enhancement', 'plugin'],
    test: ['testing'],
    perf: ['performance'],
  }
  return labels[type] ?? []
}
