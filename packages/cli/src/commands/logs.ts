/**
 * rivetos logs
 *
 * Tail runtime logs with filtering. Wraps journalctl for systemd service,
 * falls back to reading a log file if not running as a service.
 *
 * Usage:
 *   rivetos logs                       Show last 50 lines
 *   rivetos logs --follow              Follow (tail -f) mode
 *   rivetos logs --lines 100           Show last N lines
 *   rivetos logs --since "1 hour ago"  Filter by time
 *   rivetos logs --grep "error"        Filter by pattern
 *   rivetos logs --json                Output raw JSON (if structured logging enabled)
 */

import { execSync, spawn } from 'node:child_process'

const SERVICE_NAME = 'rivetos'

interface LogOptions {
  follow: boolean
  lines: number
  since: string | null
  grep: string | null
  json: boolean
}

function parseArgs(): LogOptions {
  const args = process.argv.slice(3)
  const opts: LogOptions = {
    follow: false,
    lines: 50,
    since: null,
    grep: null,
    json: false,
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-f':
      case '--follow':
        opts.follow = true
        break
      case '-n':
      case '--lines':
        opts.lines = parseInt(args[++i], 10) || 50
        break
      case '--since':
        opts.since = args[++i] ?? null
        break
      case '--grep':
      case '-g':
        opts.grep = args[++i] ?? null
        break
      case '--json':
        opts.json = true
        break
      case '--help':
      case '-h':
        showHelp()
        process.exit(0)
        break
      default:
        console.error(`Unknown option: ${args[i]}`)
        showHelp()
        process.exit(1)
    }
  }

  return opts
}

function isRoot(): boolean {
  return process.getuid?.() === 0
}

function serviceExists(): boolean {
  const userFlag = isRoot() ? '' : '--user'
  try {
    const output = execSync(`systemctl ${userFlag} is-enabled ${SERVICE_NAME} 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim()
    return output === 'enabled' || output === 'disabled'
  } catch {
    return false
  }
}

function showHelp(): void {
  console.log(`Usage: rivetos logs [options]

Options:
  -f, --follow           Follow mode (stream new entries)
  -n, --lines <count>    Number of lines to show (default: 50)
  --since <timespec>     Show entries since time (e.g. "1 hour ago", "2025-04-01")
  --grep <pattern>       Filter log lines by pattern
  --json                 Output raw JSON (if structured logging enabled)
  -h, --help             Show this help

Examples:
  rivetos logs                        Last 50 lines
  rivetos logs -f                     Follow new entries
  rivetos logs -n 200                 Last 200 lines
  rivetos logs --since "30 min ago"   Entries from last 30 minutes
  rivetos logs --grep "error"         Only lines matching "error"
  rivetos logs -f --grep "Boot"       Follow, filtering for boot messages
`)
}

export default function logs(): void {
  const opts = parseArgs()

  if (!serviceExists()) {
    console.error('❌ RivetOS service not found in systemd.')
    console.error('')
    console.error('If running interactively, logs go to stdout.')
    console.error('To set up the service: rivetos service init')
    process.exit(1)
  }

  // Build journalctl command
  const userFlag = isRoot() ? '' : '--user'
  const jctlArgs: string[] = ['journalctl', userFlag, '-u', SERVICE_NAME, '--no-pager'].filter(
    Boolean,
  )

  if (opts.follow) {
    jctlArgs.push('-f')
  } else {
    jctlArgs.push('-n', String(opts.lines))
  }

  if (opts.since) {
    jctlArgs.push('--since', opts.since)
  }

  if (opts.grep) {
    jctlArgs.push('--grep', opts.grep)
  }

  if (opts.json) {
    jctlArgs.push('-o', 'json')
  } else {
    jctlArgs.push('-o', 'short-iso')
  }

  // Use spawn for --follow (streaming), execSync for one-shot
  if (opts.follow) {
    const child = spawn(jctlArgs[0], jctlArgs.slice(1), {
      stdio: 'inherit',
    })

    // Forward SIGINT to child for clean exit
    process.on('SIGINT', () => {
      child.kill('SIGINT')
    })

    child.on('exit', (code) => {
      process.exit(code ?? 0)
    })
  } else {
    try {
      const output = execSync(jctlArgs.join(' '), {
        encoding: 'utf-8',
        timeout: 10000,
        maxBuffer: 1024 * 1024 * 5, // 5MB
      })
      process.stdout.write(output)
    } catch (err: unknown) {
      const errObj = err as { stdout?: string }
      if (errObj.stdout) {
        process.stdout.write(errObj.stdout)
      } else {
        console.error(`Failed to read logs: ${(err as Error).message}`)
        process.exit(1)
      }
    }
  }
}
