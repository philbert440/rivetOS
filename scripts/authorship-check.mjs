#!/usr/bin/env node
// Commit authorship guard. Validates that all commits in a range are authored
// and committed by house identities or repository collaborators only — no
// third-party product names (Cursor, Claude, Dependabot) or Co-authored-by
// trailers.
//
// Usage:
//   authorship-check.mjs <base>..<head>   # CI: check a PR's commit range
//   authorship-check.mjs HEAD              # local hook: check the last commit
//
// House identities (exact name + email):
//   - Rivet Philbot <rivetphilbot@gmail.com>
//   - Rivet <rivetphilbot@gmail.com>
//   - Philip <philbert440@gmail.com>
//   - Philip <philbert440@users.noreply.github.com>
//   - philbert440 <philbert440@gmail.com>
//   - philbert440 <philbert440@users.noreply.github.com>
//
// Repository collaborators (matched by email): xreed88, tomthornton
//   Add one by appending { login, emails } to COLLABORATORS below.
//
// Blocked: Cursor, Cursor Agent, cursoragent@cursor.com, Claude, Anthropic,
//          Dependabot, Renovate, or any other product name / third-party account.
//
// Exception: GitHub web-flow <noreply@github.com> as committer when the author
//            is already an allowed identity (squash-merge or merge button). NOT
//            allowed as author.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// House identities (exact name + email; only these)
const HOUSE = [
  { name: 'Rivet Philbot', email: 'rivetphilbot@gmail.com' },
  { name: 'Rivet', email: 'rivetphilbot@gmail.com' },
  { name: 'Philip', email: 'philbert440@gmail.com' },
  { name: 'Philip', email: 'philbert440@users.noreply.github.com' },
  { name: 'philbert440', email: 'philbert440@gmail.com' },
  { name: 'philbert440', email: 'philbert440@users.noreply.github.com' },
]

// Repository collaborators, matched on email only (case-insensitive), under any
// display name. A blocked pattern in the name or email still rejects them.
// Add a collaborator by appending { login, emails } here.
const COLLABORATORS = [
  {
    login: 'xreed88',
    emails: [
      'xreed88@gmail.com',
      '779983+xreed88@users.noreply.github.com',
      'xreed88@users.noreply.github.com',
    ],
  },
  {
    login: 'tomthornton',
    emails: [
      '40962668+tomthornton@users.noreply.github.com',
      'tomthornton@users.noreply.github.com',
      // TODO: add his commit email here when known.
    ],
  },
]

// GitHub web-flow committer (allowed as committer when author is allowed)
const GITHUB_WEBFLOW = { name: 'GitHub', email: 'noreply@github.com' }

// Blocked patterns (case-insensitive substrings in name or email)
const BLOCKED_PATTERNS = [
  'cursor',
  'claude',
  'anthropic',
  'dependabot',
  'renovate',
  'cursoragent@cursor.com',
]

/** Normalize an identity to lowercase for comparison */
const normalize = (identity) => ({
  name: (identity.name || '').toLowerCase().trim(),
  email: (identity.email || '').toLowerCase().trim(),
})

/** Check if an identity matches a house identity */
function isHouseIdentity(identity) {
  const n = normalize(identity)
  return HOUSE.some((h) => {
    const nh = normalize(h)
    return n.name === nh.name && n.email === nh.email
  })
}

/** Check if an identity matches a repository collaborator (email only) */
function isCollaboratorIdentity(identity) {
  const n = normalize(identity)
  return COLLABORATORS.some((c) => c.emails.some((email) => email.toLowerCase() === n.email))
}

/** Check if an identity is the GitHub web-flow committer */
function isGitHubWebFlow(identity) {
  const n = normalize(identity)
  const wf = normalize(GITHUB_WEBFLOW)
  return n.name === wf.name && n.email === wf.email
}

/** Check if an identity contains a blocked pattern */
function hasBlockedPattern(identity) {
  const n = normalize(identity)
  const combined = `${n.name} ${n.email}`
  return BLOCKED_PATTERNS.some((p) => combined.includes(p.toLowerCase()))
}

/** Check if an identity is allowed: house, or a collaborator without a blocked pattern */
function isAllowedIdentity(identity) {
  return isHouseIdentity(identity) || (isCollaboratorIdentity(identity) && !hasBlockedPattern(identity))
}

/** Extract Co-authored-by trailers from commit body */
export function extractCoAuthors(body) {
  const coAuthors = []
  // Match: Co-authored-by: Name <email@example.com>
  const re = /^Co-authored-by:\s*(.+?)\s*<(.+?)>\s*$/gim
  let m
  while ((m = re.exec(body))) {
    coAuthors.push({ name: m[1].trim(), email: m[2].trim() })
  }
  return coAuthors
}

/** Check a single commit for authorship violations */
export function checkCommit(commit) {
  const issues = []

  // Check author
  if (!isAllowedIdentity(commit.author)) {
    if (hasBlockedPattern(commit.author)) {
      issues.push({
        field: 'author',
        identity: commit.author,
        reason: 'blocked pattern (Cursor/Claude/Dependabot/etc.)',
      })
    } else {
      issues.push({
        field: 'author',
        identity: commit.author,
        reason: 'not an allowed identity',
      })
    }
  }

  // Check committer
  const authorIsAllowed = isAllowedIdentity(commit.author)

  if (!isAllowedIdentity(commit.committer)) {
    // Exception: GitHub web-flow as committer when author is already allowed
    // (squash-merge and merge-button both commit as GitHub, any parent count)
    if (authorIsAllowed && isGitHubWebFlow(commit.committer)) {
      // Allowed
    } else if (hasBlockedPattern(commit.committer)) {
      issues.push({
        field: 'committer',
        identity: commit.committer,
        reason: 'blocked pattern (Cursor/Claude/Dependabot/etc.)',
      })
    } else {
      issues.push({
        field: 'committer',
        identity: commit.committer,
        reason: 'not an allowed identity',
      })
    }
  }

  // Check Co-authored-by trailers
  const coAuthors = extractCoAuthors(commit.body)
  for (const coAuthor of coAuthors) {
    if (!isAllowedIdentity(coAuthor)) {
      if (hasBlockedPattern(coAuthor)) {
        issues.push({
          field: 'Co-authored-by',
          identity: coAuthor,
          reason: 'blocked pattern (Cursor/Claude/Dependabot/etc.)',
        })
      } else {
        issues.push({
          field: 'Co-authored-by',
          identity: coAuthor,
          reason: 'not an allowed identity',
        })
      }
    }
  }

  return issues
}

/** Get commits in a git range */
export function getCommits(range) {
  // Format: sha|%an|%ae|%cn|%ce|%P (count parents)|%B (body)
  // %P gives parent SHAs separated by space; we count them for merge detection
  const format = '%H|%an|%ae|%cn|%ce|%P|%B'
  const delimiter = '---COMMIT-END---'
  const fullFormat = `${format}${delimiter}`

  // Build git log arguments
  const args = ['log', `--format=${fullFormat}`]
  
  // Split range on spaces to handle both "base..head" and "-n 1 HEAD" formats
  const rangeParts = range.split(/\s+/)
  args.push(...rangeParts)

  let output
  try {
    output = execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (e) {
    throw new Error(`git log failed: ${e.message}`)
  }

  const commits = []
  const blocks = output.split(delimiter).filter(Boolean)

  for (const block of blocks) {
    const lines = block.trim().split('\n')
    if (lines.length === 0) continue

    const headerLine = lines[0]
    const parts = headerLine.split('|')
    if (parts.length < 6) continue

    const sha = parts[0]
    const parentShas = parts[5].trim().split(/\s+/).filter(Boolean)
    const parentCount = parentShas.length

    // Body is everything after the first line
    const body = lines.slice(1).join('\n')

    const commit = {
      sha,
      author: { name: parts[1], email: parts[2] },
      committer: { name: parts[3], email: parts[4] },
      parentCount,
      body,
    }

    commits.push(commit)
  }

  return commits
}

/** Format an identity for display */
function fmtIdentity(identity) {
  return `${identity.name} <${identity.email}>`
}

/** Check commits and report violations */
export function checkRange(range) {
  const commits = getCommits(range)
  const violations = []

  for (const commit of commits) {
    const issues = checkCommit(commit)
    if (issues.length > 0) {
      violations.push({ commit, issues })
    }
  }

  return violations
}

function main() {
  let range = process.argv[2]
  if (!range) {
    console.error('usage: authorship-check.mjs <base>..<head>  |  authorship-check.mjs HEAD')
    process.exit(2)
  }

  // When checking "HEAD", we want to check only the single most recent commit,
  // not the entire history leading to it. Use -1 to limit to one commit.
  if (range === 'HEAD') {
    range = '-1 HEAD'
  }

  let violations
  try {
    violations = checkRange(range)
  } catch (e) {
    console.error(`❌ authorship-check: ${e.message}`)
    process.exit(1)
  }

  if (violations.length === 0) {
    console.log('✅ authorship-check: all commits have valid house identities')
    process.exit(0)
  }

  // Report violations
  console.error(`\n❌ authorship-check: ${violations.length} commit(s) with invalid identities:\n`)

  for (const { commit, issues } of violations) {
    console.error(`  ${commit.sha.slice(0, 8)}`)
    for (const issue of issues) {
      console.error(`    ${issue.field}: ${fmtIdentity(issue.identity)}`)
      console.error(`      → ${issue.reason}`)
    }
  }

  console.error(
    '\nAllowed identities (house):' +
      '\n  - Rivet Philbot <rivetphilbot@gmail.com>' +
      '\n  - Rivet <rivetphilbot@gmail.com>' +
      '\n  - Philip <philbert440@gmail.com>' +
      '\n  - Philip <philbert440@users.noreply.github.com>' +
      '\n  - philbert440 <philbert440@gmail.com>' +
      '\n  - philbert440 <philbert440@users.noreply.github.com>' +
      '\n\nRepository collaborators (matched by email): xreed88, tomthornton' +
      '\n  Add one by appending { login, emails } to COLLABORATORS in scripts/authorship-check.mjs.' +
      '\n\nBlocked: Cursor, Claude, Anthropic, Dependabot, Renovate, and any Co-authored-by trailers.' +
      '\n\nException: GitHub <noreply@github.com> as committer when the author is an allowed identity (GitHub merge/squash).\n',
  )

  process.exit(1)
}

// Only execute as a CLI; importing the module (tests) must not run main().
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
