// Run: node --test scripts/authorship-check.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { checkCommit, extractCoAuthors } from './authorship-check.mjs'

// Test fixtures
const house = {
  rivetPhilbot: { name: 'Rivet Philbot', email: 'rivetphilbot@gmail.com' },
  rivet: { name: 'Rivet', email: 'rivetphilbot@gmail.com' },
  philip: { name: 'Philip', email: 'philbert440@gmail.com' },
  philipNoreply: { name: 'Philip', email: 'philbert440@users.noreply.github.com' },
  philbert440: { name: 'philbert440', email: 'philbert440@gmail.com' },
  philbert440Noreply: { name: 'philbert440', email: 'philbert440@users.noreply.github.com' },
}
const githubWebFlow = { name: 'GitHub', email: 'noreply@github.com' }
const xreed88 = { name: 'xreed88', email: 'xreed88@gmail.com' }
const cursorAgent = { name: 'Cursor Agent', email: 'cursoragent@cursor.com' }
const claude = { name: 'Claude', email: 'assistant@anthropic.com' }
const dependabot = { name: 'dependabot[bot]', email: 'dependabot@github.com' }
const renovate = { name: 'Renovate Bot', email: 'renovate@example.com' }
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

test('accepts every HOUSE identity as author and committer', () => {
  const cases = [
    ['Rivet Philbot', house.rivetPhilbot],
    ['Rivet', house.rivet],
    ['Philip <philbert440@gmail.com>', house.philip],
    ['Philip <philbert440@users.noreply.github.com>', house.philipNoreply],
    ['philbert440 <philbert440@gmail.com>', house.philbert440],
    ['philbert440 <philbert440@users.noreply.github.com>', house.philbert440Noreply],
  ]
  for (const [label, identity] of cases) {
    assert.deepEqual(
      checkCommit(makeCommit({ author: identity, committer: identity })),
      [],
      `house identity accepted as author and committer: ${label}`,
    )
  }

  // Mixed pair: one house author, a different house committer.
  assert.deepEqual(
    checkCommit(makeCommit({ author: house.philip, committer: house.rivetPhilbot })),
    [],
    'mixed house pair accepted (Philip author, Rivet Philbot committer)',
  )
})

test('house matching is case-insensitive but requires the exact name', () => {
  const upper = { name: 'RIVET PHILBOT', email: 'RIVETPHILBOT@GMAIL.COM' }
  assert.deepEqual(
    checkCommit(makeCommit({ author: upper, committer: upper })),
    [],
    'house matching is case-insensitive',
  )

  const wrongName = { name: 'Someone Else', email: 'rivetphilbot@gmail.com' }
  const issues = checkCommit(makeCommit({ author: wrongName, committer: house.rivetPhilbot }))
  assert.ok(
    issues.some((i) => i.field === 'author' && i.reason.includes('not an allowed identity')),
    'a house email with the wrong name is rejected',
  )
})

test('rejects blocked product identities with the blocked-pattern reason', () => {
  const cases = [
    ['Cursor Agent', cursorAgent],
    ['Cursor Agent (uppercase)', { name: 'CURSOR AGENT', email: 'CURSORAGENT@CURSOR.COM' }],
    ['Claude / Anthropic', claude],
    ['Claude / Anthropic (uppercase)', { name: 'CLAUDE', email: 'ASSISTANT@ANTHROPIC.COM' }],
    ['Dependabot', dependabot],
    ['Dependabot (uppercase)', { name: 'DEPENDABOT[BOT]', email: 'DEPENDABOT@GITHUB.COM' }],
    ['Renovate', renovate],
    ['Renovate (uppercase)', { name: 'RENOVATE BOT', email: 'RENOVATE@EXAMPLE.COM' }],
  ]
  for (const [label, blocked] of cases) {
    const asAuthor = checkCommit(makeCommit({ author: blocked, committer: house.rivetPhilbot }))
    assert.ok(
      asAuthor.some((i) => i.field === 'author' && i.reason.includes('blocked pattern')),
      `blocked as author: ${label}`,
    )
    const asCommitter = checkCommit(makeCommit({ author: house.rivetPhilbot, committer: blocked }))
    assert.ok(
      asCommitter.some((i) => i.field === 'committer' && i.reason.includes('blocked pattern')),
      `blocked as committer: ${label}`,
    )
  }
})

test('rejects an unknown person with the not-allowed reason', () => {
  const issues = checkCommit(makeCommit({ author: randomUser, committer: randomUser }))
  assert.equal(issues.length, 2, 'unknown author and committer each produce one issue')
  assert.ok(issues.some((i) => i.field === 'author' && i.reason.includes('not an allowed identity')))
  assert.ok(
    issues.some((i) => i.field === 'committer' && i.reason.includes('not an allowed identity')),
  )
})

test('allows GitHub web-flow only as committer behind an allowed author', () => {
  assert.deepEqual(
    checkCommit(makeCommit({ author: house.philip, committer: githubWebFlow })),
    [],
    'web-flow committer is fine behind a house author',
  )
  assert.deepEqual(
    checkCommit(makeCommit({ author: xreed88, committer: githubWebFlow })),
    [],
    'web-flow committer is fine behind a collaborator author',
  )

  const badAuthor = checkCommit(makeCommit({ author: randomUser, committer: githubWebFlow }))
  assert.ok(
    badAuthor.some((i) => i.field === 'committer' && i.reason.includes('not an allowed identity')),
    'web-flow committer is rejected when the author is not allowed',
  )

  const asAuthor = checkCommit(makeCommit({ author: githubWebFlow, committer: house.philip }))
  assert.ok(
    asAuthor.some((i) => i.field === 'author' && i.reason.includes('not an allowed identity')),
    'web-flow is never allowed as author',
  )
})

test('checks Co-authored-by trailers', () => {
  const houseTrailer = makeCommit({
    author: house.rivetPhilbot,
    committer: house.rivetPhilbot,
    coAuthors: [house.philip],
  })
  assert.deepEqual(checkCommit(houseTrailer), [], 'house trailer is allowed')

  const collaboratorTrailer = makeCommit({
    author: house.rivetPhilbot,
    committer: house.rivetPhilbot,
    coAuthors: [xreed88],
  })
  assert.deepEqual(checkCommit(collaboratorTrailer), [], 'collaborator trailer is allowed')

  const blockedTrailer = makeCommit({
    author: house.rivetPhilbot,
    committer: house.rivetPhilbot,
    coAuthors: [cursorAgent],
  })
  assert.ok(
    checkCommit(blockedTrailer).some(
      (i) => i.field === 'Co-authored-by' && i.reason.includes('blocked pattern'),
    ),
    'blocked product trailer is rejected with the blocked-pattern reason',
  )

  const unknownTrailer = makeCommit({
    author: house.rivetPhilbot,
    committer: house.rivetPhilbot,
    coAuthors: [randomUser],
  })
  assert.ok(
    checkCommit(unknownTrailer).some(
      (i) => i.field === 'Co-authored-by' && i.reason.includes('not an allowed identity'),
    ),
    'unknown person trailer is rejected',
  )

  const multipleTrailers = makeCommit({
    author: house.rivetPhilbot,
    committer: house.rivetPhilbot,
    coAuthors: [house.philip, xreed88, cursorAgent, randomUser],
  })
  const badTrailers = checkCommit(multipleTrailers).filter((i) => i.field === 'Co-authored-by')
  assert.equal(badTrailers.length, 2, 'multiple trailers produce one issue per bad trailer')
})

test('extractCoAuthors parses trailers, tolerates whitespace/case, ignores other lines', () => {
  const body = [
    'commit message',
    '',
    'Co-authored-by: Alice <alice@example.com>',
    'co-authored-by:   Bob Smith   <  bob@example.com  >  ',
    'CO-AUTHORED-BY: Carol<carol@example.com>',
    'Not a trailer: Co-authored-by: Mallory <mallory@example.com>',
    'Co-authored-by: missing brackets',
  ].join('\n')

  const coAuthors = extractCoAuthors(body)
  assert.equal(coAuthors.length, 3, 'only the three real trailers are parsed')
  assert.deepEqual(coAuthors[0], { name: 'Alice', email: 'alice@example.com' })
  assert.deepEqual(coAuthors[1], { name: 'Bob Smith', email: 'bob@example.com' })
  assert.deepEqual(coAuthors[2], { name: 'Carol', email: 'carol@example.com' })
})

test('accepts repository collaborators by email with any display name', () => {
  const collaboratorEmails = [
    ['xreed88', 'xreed88@gmail.com'],
    ['xreed88', '779983+xreed88@users.noreply.github.com'],
    ['xreed88', 'xreed88@users.noreply.github.com'],
    ['tomthornton', '40962668+tomthornton@users.noreply.github.com'],
    ['tomthornton', 'tomthornton@users.noreply.github.com'],
  ]
  for (const [login, email] of collaboratorEmails) {
    const identity = { name: 'Arbitrary Display Name', email }
    assert.deepEqual(
      checkCommit(makeCommit({ author: identity, committer: identity })),
      [],
      `collaborator ${login} accepted on ${email} under any display name`,
    )
  }

  const cased = { name: 'MiXeD CaSe', email: 'XREED88@GMAIL.COM' }
  assert.deepEqual(
    checkCommit(makeCommit({ author: cased, committer: cased })),
    [],
    'collaborator email matches case-insensitively',
  )

  const blockedName = { name: 'Cursor Agent', email: 'xreed88@gmail.com' }
  assert.ok(
    checkCommit(makeCommit({ author: blockedName, committer: blockedName })).some(
      (i) => i.field === 'author' && i.reason.includes('blocked pattern'),
    ),
    'a blocked-pattern name on a collaborator email is still rejected',
  )

  for (const email of [
    'xreed88@example.com',
    'xreed88@gmail.com.evil.example',
    'xreed88+x@gmail.com',
  ]) {
    const lookalike = { name: 'xreed88', email }
    assert.ok(
      checkCommit(makeCommit({ author: lookalike, committer: lookalike })).some(
        (i) => i.field === 'author' && i.reason.includes('not an allowed identity'),
      ),
      `look-alike email is rejected: ${email}`,
    )
  }
})

test('CLI guard: importing the module does not run main()', () => {
  const moduleUrl = new URL('./authorship-check.mjs', import.meta.url).href
  const stdout = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)})`],
    { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } },
  )
  assert.equal(stdout.trim(), '', 'importing the module produces no CLI output')
})
