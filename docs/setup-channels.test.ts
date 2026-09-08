/**
 * Guards the published laptop install story: one-liner on prod, GitHub is not
 * the supported pin, mesh share is the in-app update feed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const read = (name: string): string => readFileSync(join(dir, name), 'utf8')

const ONE_LINER = 'curl -fsSL https://get.rivethub.io/local.sh | bash'

describe('setup docs channels', () => {
  it('GETTING-STARTED leads with the published one-liner and does not pin GitHub Releases as the install path', () => {
    const text = read('GETTING-STARTED.md')
    assert.match(text, /Laptop \(supported\)/)
    assert.ok(text.includes(ONE_LINER), 'missing local.sh one-liner')
    assert.ok(
      !/pin a tag from \[GitHub Releases\]/i.test(text),
      'GETTING-STARTED still tells readers to pin GitHub Releases',
    )
    assert.match(text, /\/rivet-shared\/builds\/rivethub\//)
    assert.match(text, /production server/)
  })

  it('LOCAL-MODE, RELEASES, and HUB-SETUP name prod stable vs mesh-share nightly', () => {
    const local = read('LOCAL-MODE.md')
    const releases = read('RELEASES.md')
    const hub = read('HUB-SETUP.md')
    for (const [name, text] of [
      ['LOCAL-MODE', local],
      ['RELEASES', releases],
      ['HUB-SETUP', hub],
    ] as const) {
      assert.ok(text.includes(ONE_LINER), `${name} missing one-liner`)
      assert.match(text, /\/rivet-shared\/builds\/rivethub\//, `${name} missing mesh share`)
    }
    assert.match(releases, /## Channels/)
    assert.match(releases, /\*\*Stable\*\*/)
    assert.match(releases, /\*\*Dev \/ nightly\*\*/)
    assert.ok(
      releases.includes('GitHub Releases are not the supported install path'),
      'RELEASES must say GitHub Releases are not the install path',
    )
  })
})
