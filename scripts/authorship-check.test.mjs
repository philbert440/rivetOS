// Run: node --test scripts/authorship-check.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkCommit, extractCoAuthors, parseCommit } from './authorship-check.mjs'

// Test fixtures
const rivetPhilbot = { name: 'Rivet Philbot', email: 'rivetphilbot@gmail.com' }
const rivetAlt = { name: 'Rivet', email: 'rivetphilbot@gmail.com' }
const philip = { name: 'Philip', email: 'philbert440@gmail.com' }
const philipNoreply = { name: 'Philip', email: 'philbert440@users.noreply.github.com' }
const githubWebFlow = { name: 'GitHub', email: 'noreply@github.com' }
const cursorAgent = { name: 'Cursor Agent', email: 'cursoragent@cursor.com' }
const claude = { name: 'Claude', email: 'assistant@anthropic.com' }
const dependabot = { name: 'dependabot[bot]', email: 'dependabot@github.com' }
const randomUser = { name: 'Random User', email: 'random@example.com' }

function makeCommit({ author, committer, coAuthors = [], isMerge = false }) {
  let body = 'commit message\n'
  for (const ca of coAuthors) {
    body += `\nCo-authored-by: ${ca.name} <${ca.email}>`
  }
  return {
    sha: 'abc1234567890',
    author,
    committer,
    parentCount: isMerge ? 2 : 1,
    body,
  }
}

test('accepts Rivet Philbot as author and committer', () => {
  const commit = makeCommit({ author: rivetPhilbot, committer: rivetPhilbot })
  assert.deepEqual(checkCommit(commit), [])
})

test('accepts Rivet (short name) as author and committer', () => {
  const commit = makeCommit({ author: rivetAlt, committer: rivetAlt })
  assert.deepEqual(checkCommit(commit), [])
})

test('accepts Philip as author and committer', () => {
  const commit = makeCommit({ author: philip, committer: philip })
  assert.deepEqual(checkCommit(commit), [])
})

test('accepts Philip with noreply email', () => {
  const commit = makeCommit({ author: philipNoreply, committer: philipNoreply })
  assert.deepEqual(checkCommit(commit), [])
})

test('accepts mixed house identities (Philip author, Rivet committer)', () => {
  const commit = makeCommit({ author: philip, committer: rivetPhilbot })
  assert.deepEqual(checkCommit(commit), [])
})

test('blocks Cursor Agent as author', () => {
  const commit = makeCommit({ author: cursorAgent, committer: rivetPhilbot })
  const issues = checkCommit(commit)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].field, 'author')
  assert.ok(issues[0].reason.includes('blocked pattern'))
})

test('blocks Cursor Agent as committer', () => {
  const commit = makeCommit({ author: rivetPhilbot, committer: cursorAgent })
  const issues = checkCommit(commit)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].field, 'committer')
  assert.ok(issues[0].reason.includes('blocked pattern'))
})

test('blocks Claude / Anthropic', () => {
  const commit = makeCommit({ author: claude, committer: claude })
  const issues = checkCommit(commit)
  assert.ok(issues.length >= 2)
  assert.ok(issues.some((i) => i.field === 'author' && i.reason.includes('blocked pattern')))
  assert.ok(issues.some((i) => i.field === 'committer' && i.reason.includes('blocked pattern')))
})

test('blocks Dependabot', () => {
  const commit = makeCommit({ author: dependabot, committer: dependabot })
  const issues = checkCommit(commit)
  assert.ok(issues.length >= 2)
  assert.ok(issues.some((i) => i.field === 'author' && i.reason.includes('blocked pattern')))
})

test('blocks random non-house identity', () => {
  const commit = makeCommit({ author: randomUser, committer: randomUser })
  const issues = checkCommit(commit)
  assert.equal(issues.length, 2)
  assert.ok(issues.some((i) => i.field === 'author' && i.reason.includes('not a house identity')))
  assert.ok(issues.some((i) => i.field === 'committer' && i.reason.includes('not a house identity')))
})

test('blocks Co-authored-by with Cursor Agent', () => {
  const commit = makeCommit({
    author: rivetPhilbot,
    committer: rivetPhilbot,
    coAuthors: [cursorAgent],
  })
  const issues = checkCommit(commit)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].field, 'Co-authored-by')
  assert.ok(issues[0].reason.includes('blocked pattern'))
})

test('blocks Co-authored-by with random user', () => {
  const commit = makeCommit({
    author: rivetPhilbot,
    committer: rivetPhilbot,
    coAuthors: [randomUser],
  })
  const issues = checkCommit(commit)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].field, 'Co-authored-by')
  assert.ok(issues[0].reason.includes('not a house identity'))
})

test('allows house Co-authored-by', () => {
  const commit = makeCommit({
    author: rivetPhilbot,
    committer: rivetPhilbot,
    coAuthors: [philip],
  })
  assert.deepEqual(checkCommit(commit), [])
})

test('allows GitHub web-flow as committer on merge commit with house author', () => {
  const commit = makeCommit({
    author: philip,
    committer: githubWebFlow,
    isMerge: true,
  })
  assert.deepEqual(checkCommit(commit), [])
})

test('blocks GitHub web-flow as author even on merge commit', () => {
  const commit = makeCommit({
    author: githubWebFlow,
    committer: githubWebFlow,
    isMerge: true,
  })
  const issues = checkCommit(commit)
  assert.ok(issues.length >= 1)
  assert.ok(issues.some((i) => i.field === 'author'))
})

test('blocks GitHub web-flow as committer on non-merge commit', () => {
  const commit = makeCommit({
    author: philip,
    committer: githubWebFlow,
    isMerge: false,
  })
  const issues = checkCommit(commit)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].field, 'committer')
})

test('blocks GitHub web-flow as committer on merge with non-house author', () => {
  const commit = makeCommit({
    author: randomUser,
    committer: githubWebFlow,
    isMerge: true,
  })
  const issues = checkCommit(commit)
  assert.ok(issues.length >= 1)
  // Both author and committer should be blocked
  assert.ok(issues.some((i) => i.field === 'author'))
})

test('extractCoAuthors finds Co-authored-by trailers', () => {
  const body = `commit message

Some description

Co-authored-by: Alice <alice@example.com>
Co-authored-by: Bob Smith <bob@example.com>`

  const coAuthors = extractCoAuthors(body)
  assert.equal(coAuthors.length, 2)
  assert.deepEqual(coAuthors[0], { name: 'Alice', email: 'alice@example.com' })
  assert.deepEqual(coAuthors[1], { name: 'Bob Smith', email: 'bob@example.com' })
})

test('extractCoAuthors handles various whitespace', () => {
  const body = `message
Co-authored-by:   Alice   <  alice@example.com  >  
Co-authored-by:Bob<bob@example.com>`

  const coAuthors = extractCoAuthors(body)
  assert.equal(coAuthors.length, 2)
  assert.equal(coAuthors[0].name, 'Alice')
  assert.equal(coAuthors[0].email, 'alice@example.com')
})

test('case-insensitive matching for blocked patterns', () => {
  const cursorUpper = { name: 'CURSOR Agent', email: 'CURSORAGENT@CURSOR.COM' }
  const commit = makeCommit({ author: cursorUpper, committer: rivetPhilbot })
  const issues = checkCommit(commit)
  assert.ok(issues.some((i) => i.reason.includes('blocked pattern')))
})

test('case-insensitive matching for house identities', () => {
  const rivetUpper = { name: 'RIVET PHILBOT', email: 'RIVETPHILBOT@GMAIL.COM' }
  const commit = makeCommit({ author: rivetUpper, committer: rivetUpper })
  assert.deepEqual(checkCommit(commit), [])
})
