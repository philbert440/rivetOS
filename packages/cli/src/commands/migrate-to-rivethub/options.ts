/** Argument parsing for `rivetos migrate-to-rivethub`. */

import { isAbsolute, resolve } from 'node:path'
import { isSafeArg } from '../../lib/ssh.js'

export interface MigrateOptions {
  /** Print the preflight result and the plan; change nothing. */
  dryRun: boolean
  /** Reverse a migration on this node (or every node with --mesh). */
  rollback: boolean
  /** Walk the mesh over SSH, remotes first, this node last. */
  mesh: boolean
  /** Local `rh` binary to install instead of downloading a release. */
  binary?: string
  /** RivetHub release tag (default: the latest release). */
  version?: string
  /** SSH user for remote nodes (default: rivet). */
  sshUser: string
  help: boolean
}

export type ParseResult = { ok: true; opts: MigrateOptions } | { ok: false; error: string }

/**
 * Parse `migrate-to-rivethub` arguments (everything after the command name).
 * Values that end up in shell strings (`--version`, `--ssh-user`) go through
 * the same allowlist `rivetos update` uses; `--binary` is resolved to an
 * absolute path and must be shell-safe for the same reason.
 */
export function parseMigrateArgs(args: string[], cwd: string = process.cwd()): ParseResult {
  const opts: MigrateOptions = {
    dryRun: false,
    rollback: false,
    mesh: false,
    sshUser: 'rivet',
    help: false,
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const value = (): string | undefined => {
      if (i + 1 >= args.length) return undefined
      const next = args[i + 1]
      if (next.startsWith('--')) return undefined
      i++
      return next
    }
    switch (arg) {
      case '--dry-run':
        opts.dryRun = true
        break
      case '--rollback':
        opts.rollback = true
        break
      case '--mesh':
        opts.mesh = true
        break
      case '--binary': {
        const v = value()
        if (!v) return { ok: false, error: '--binary requires a path to the rh binary' }
        opts.binary = isAbsolute(v) ? v : resolve(cwd, v)
        break
      }
      case '--version':
      case '-v': {
        const v = value()
        if (!v) return { ok: false, error: '--version requires a release tag (e.g. v0.1.0)' }
        opts.version = v
        break
      }
      case '--ssh-user': {
        const v = value()
        if (!v) return { ok: false, error: '--ssh-user requires a user name' }
        opts.sshUser = v
        break
      }
      case '--help':
      case '-h':
        opts.help = true
        break
      default:
        return { ok: false, error: `Unknown option: ${arg}` }
    }
  }

  if (opts.binary && opts.version) {
    return { ok: false, error: '--binary and --version are mutually exclusive' }
  }
  for (const [label, v] of [
    ['--version', opts.version],
    ['--ssh-user', opts.sshUser],
    ['--binary', opts.binary],
  ] as const) {
    if (v !== undefined && !isSafeArg(v)) {
      return {
        ok: false,
        error: `Refusing unsafe ${label} "${v}" — only letters, digits and . _ - / @ : are allowed.`,
      }
    }
  }
  return { ok: true, opts }
}

/** Flags forwarded to a remote node's own `rivetos migrate-to-rivethub`. */
export function forwardedFlags(opts: MigrateOptions, remoteBinary?: string): string[] {
  const flags: string[] = []
  if (opts.dryRun) flags.push('--dry-run')
  if (opts.rollback) flags.push('--rollback')
  if (remoteBinary) flags.push('--binary', remoteBinary)
  else if (opts.version) flags.push('--version', opts.version)
  return flags
}

export const HELP_TEXT = `
  rivetos migrate-to-rivethub — Move this node from the RivetOS (TypeScript)
  runtime to the RivetHub runtime, or roll that back.

  Usage:
    rivetos migrate-to-rivethub [options]

  Options:
    --dry-run          Run the preflight and print the plan; change nothing
    --rollback         Reverse the migration (rivethub.service → rivetos.service)
    --mesh             Migrate every agent node in mesh.json over SSH, then this node
    --binary <path>    Install this local rh binary (rivethub-migrate must sit next
                       to it) instead of downloading a release
    --version <tag>    RivetHub release tag to download (default: latest)
    --ssh-user <user>  SSH user for remote nodes (default: rivet)

  What it does (see docs/migrating-to-rivethub.md):
    1. Preflight: refuses with a reason when the node cannot be migrated safely
    2. Installs rh and rivethub-migrate into ~/.local/bin; rh config validate
    3. Stops and disables rivetos.service (system or user unit)
    4. Backs up ~/.rivetos to ~/rivetos-state-<stamp>.tgz (mode 600)
    5. Memory: rivethub-migrate postgres (Postgres installs), or a PGlite dump
       imported into SQLite (standalone installs)
    6. Moves ~/.rivetos to ~/.rivethub and links ~/.rivetos back (before the start)
    7. Installs, enables and starts rivethub.service in the old unit's scope
    8. Health: rivethub.service active, gateway /healthz, rh status
    A failure or an interrupt (Ctrl-C, SSH drop) from step 3 on puts
    rivetos.service and ~/.rivetos back. Only one run per node at a time.

  Exit codes:
    0  migrated (or already migrated / nothing to roll back)
    1  a step failed (the output names it and how to recover)
    2  refused by the preflight, or bad arguments
`
