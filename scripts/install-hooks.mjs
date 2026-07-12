#!/usr/bin/env node
// `prepare` hook: point git at our committed hooks dir so the pre-commit
// secret scanner runs. Does NOT fail `npm install` when it can't (non-git
// checkout, CI tarball, sandbox) — but WARNS loudly instead of silently
// swallowing, so a developer isn't left unprotected without a signal. CI is
// the backstop regardless.
//
// Note: core.hooksPath replaces the whole hooks dir, so a pre-existing local
// .git/hooks/{commit-msg,pre-push} stops firing. We only ship pre-commit; if
// you rely on other local hooks, move them under scripts/git-hooks/.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

if (!existsSync('.git')) {
  // Installed as a dependency or from a tarball — nothing to wire up. Silent.
  process.exit(0)
}
try {
  execFileSync('git', ['config', 'core.hooksPath', 'scripts/git-hooks'], { stdio: 'ignore' })
  console.log('✓ git hooks installed (core.hooksPath=scripts/git-hooks)')
} catch (e) {
  console.warn(
    '⚠️  could not set core.hooksPath — the pre-commit secret scanner is NOT active locally.\n' +
      `   (${e.message}) Run manually: git config core.hooksPath scripts/git-hooks\n` +
      '   CI still enforces the scan, but local commits are unguarded until you do.',
  )
}
