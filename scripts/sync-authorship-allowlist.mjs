#!/usr/bin/env node
// Refresh scripts/authorship-allowlist.json collaborators from GitHub:
//   node scripts/sync-authorship-allowlist.mjs
//
// Reads repos/philbert440/rivetOS/collaborators (needs `gh`).
// House identities are left untouched. Extra emails already listed for a
// login are kept. Logins that are no longer collaborators are dropped.
// [bot] / GitHub App accounts are skipped.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const ALLOWLIST_PATH = join(ROOT, 'authorship-allowlist.json')
const REPO = 'philbert440/rivetOS'
const HOUSE_LOGINS = new Set(['philbert440', 'rivetphilbot'])

function noreplyEmails(login, id) {
  return [`${id}+${login}@users.noreply.github.com`, `${login}@users.noreply.github.com`]
}

function fetchCollaborators() {
  const raw = execFileSync(
    'gh',
    ['api', `repos/${REPO}/collaborators`, '--paginate'],
    { encoding: 'utf8' },
  )
  const users = JSON.parse(raw)
  if (!Array.isArray(users)) throw new Error('collaborators API did not return an array')
  return users
}

function fetchPublicEmail(login) {
  try {
    const raw = execFileSync('gh', ['api', `users/${login}`], { encoding: 'utf8' })
    const email = JSON.parse(raw)?.email
    return typeof email === 'string' && email.includes('@') ? email : null
  } catch {
    return null
  }
}

function isBotAccount(user) {
  const login = String(user.login || '')
  return user.type !== 'User' || /\[bot\]/i.test(login)
}

const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'))
if (!Array.isArray(allowlist.house) || !Array.isArray(allowlist.collaborators)) {
  throw new Error(`invalid allowlist: ${ALLOWLIST_PATH}`)
}

const existingByLogin = new Map(
  allowlist.collaborators.map((c) => [c.login.toLowerCase(), c]),
)

const collaborators = []
for (const user of fetchCollaborators()) {
  if (isBotAccount(user)) continue
  if (HOUSE_LOGINS.has(user.login)) continue

  const prev = existingByLogin.get(user.login.toLowerCase())
  const emails = new Set([
    ...(prev?.emails ?? []),
    ...noreplyEmails(user.login, user.id),
  ])
  const publicEmail = fetchPublicEmail(user.login)
  if (publicEmail) emails.add(publicEmail)

  collaborators.push({
    login: user.login,
    id: user.id,
    emails: [...emails].sort((a, b) => a.localeCompare(b)),
  })
}

collaborators.sort((a, b) => a.login.localeCompare(b.login))
allowlist.collaborators = collaborators

writeFileSync(ALLOWLIST_PATH, `${JSON.stringify(allowlist, null, 2)}\n`)
console.log(
  `updated ${ALLOWLIST_PATH}: ${collaborators.map((c) => c.login).join(', ') || '(none)'}`,
)
