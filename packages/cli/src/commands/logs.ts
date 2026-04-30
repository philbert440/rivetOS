/**
 * rivetos logs
 *
 * Tail runtime logs. Works across deployment types:
 *   - Docker: wraps `docker compose logs`
 *   - Systemd: wraps `journalctl`
 *   - Bare metal: reads log file or says "check stdout"
 *
 * Usage:
 *   rivetos logs                       Follow all agents
 *   rivetos logs opus                  Follow specific agent
 *   rivetos logs --level error         Filter by severity
 *   rivetos logs --since 1h            Last hour
 *   rivetos logs --lines 100           Last N lines (non-follow)
 *   rivetos logs --no-follow           Show recent, don't tail
 *   rivetos logs --json                Raw JSON output
 */

import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface LogOptions {
  agent: string | null
  follow: boolean
  lines: number
  since: string | null
  level: string | null
  json: boolean
  grep: string | null
}

function parseArgs(): LogOptions {
  const args = process.argv.slice(3)
  const opts: LogOptions = {
    agent: null,
    follow: true,
    lines: 50,
    since: null,
    level: null,
    json: false,
    grep: null,
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--no-follow':
        opts.follow = false
        break
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
      case '--level':
        opts.level = args[++i] ?? null
        break
      case '--json':
        opts.json = true
        break
      case '--grep':
      case '-g':
        opts.grep = args[++i] ?? null
        break
      case '--help':
      case '-h':
        showHelp()
        process.exit(0)
        break
      default:
        // First positional arg is agent name
        if (!args[i].startsWith('-') && !opts.agent) {
          opts.agent = args[i]
        } else {
          console.error(`Unknown option: ${args[i]}`)
          showHelp()
          process.exit(1)
        }
    }
  }

  return opts
}

// ---------------------------------------------------------------------------
// Deployment Detection
// ---------------------------------------------------------------------------

type DeploymentType = 'docker' | 'systemd' | 'bare'

function detectDeployment(): DeploymentType {
  // Skip Docker detection in bare-metal mode
  if (process.env.RIVETOS_BARE_METAL === '1' || process.argv.includes('--bare-metal')) {
    // Fall through to systemd/bare detection
  } else {
    // Check for the unified compose stack at infra/docker/rivetos/.
    const composePath = resolve(process.cwd(), 'infra/docker/rivetos/docker-compose.yml')
    if (existsSync(composePath)) {
      try {
        execSync(`docker compose -f ${composePath} ps --quiet 2>/dev/null`, { timeout: 5000 })
        return 'docker'
      } catch {
        // Compose file exists but containers not running
      }
    }
  }

  // Check for systemd service
  const isRoot = process.getuid?.() === 0
  const userFlag = isRoot ? '' : '--user'
  try {
    const output = execSync(`systemctl ${userFlag} is-enabled rivetos 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim()
    if (output === 'enabled' || output === 'disabled') {
      return 'systemd'
    }
  } catch {
    // Not a systemd service
  }

  return 'bare'
}

// ---------------------------------------------------------------------------
// Docker Logs
// ---------------------------------------------------------------------------

function dockerLogs(opts: LogOptions): void {
  const composePath = resolve(process.cwd(), 'infra/docker/rivetos/docker-compose.yml')
  const args: string[] = ['compose', '-f', composePath, 'logs']

  if (opts.follow) args.push('-f')
  if (!opts.follow) args.push('-n', String(opts.lines))
  if (opts.since) args.push('--since', opts.since)
  if (opts.agent) args.push(`rivetos-${opts.agent}`)

  // Pipe through grep for level/pattern filtering
  let child: ChildProcess

  if (opts.level || opts.grep) {
    const dockerProc = spawn('docker', args, { stdio: ['inherit', 'pipe', 'inherit'] })
    const patterns: string[] = []
    if (opts.level) patterns.push(`\\[${opts.level.toUpperCase()}`)
    if (opts.grep) patterns.push(opts.grep)
    const grepPattern = patterns.join('|')

    child = spawn('grep', ['-iE', '--line-buffered', grepPattern], {
      stdio: ['pipe', 'inherit', 'inherit'],
    })
    dockerProc.stdout.pipe(child.stdin!)
  } else {
    child = spawn('docker', args, { stdio: 'inherit' })
  }

  process.on('SIGINT', () => {
    child.kill('SIGINT')
  })
  child.on('exit', (code) => {
    process.exit(code ?? 0)
  })
}

// ---------------------------------------------------------------------------
// Systemd Logs
// ---------------------------------------------------------------------------

function systemdLogs(opts: LogOptions): void {
  const isRoot = process.getuid?.() === 0
  const userFlag = isRoot ? '' : '--user'
  const args: string[] = ['journalctl', userFlag, '-u', 'rivetos', '--no-pager'].filter(Boolean)

  if (opts.follow) {
    args.push('-f')
  } else {
    args.push('-n', String(opts.lines))
  }

  if (opts.since) args.push('--since', opts.since)
  if (opts.grep || opts.level) {
    const patterns: string[] = []
    if (opts.level) patterns.push(`\\[${opts.level.toUpperCase()}`)
    if (opts.grep) patterns.push(opts.grep)
    args.push('--grep', patterns.join('|'))
  }

  if (opts.json) args.push('-o', 'json')
  else args.push('-o', 'short-iso')

  const child = spawn(args[0], args.slice(1), { stdio: 'inherit' })
  process.on('SIGINT', () => {
    child.kill('SIGINT')
  })
  child.on('exit', (code) => {
    process.exit(code ?? 0)
  })
}

// ---------------------------------------------------------------------------
// Bare Metal Logs
// ---------------------------------------------------------------------------

function bareLogs(_opts: LogOptions): void {
  console.log('RivetOS is running in bare metal mode (no Docker, no systemd).')
  console.log('')
  console.log("Logs are written to stdout. If running interactively, they're in your terminal.")
  console.log('To capture logs, redirect output:')
  console.log('')
  console.log('  rivetos start 2>&1 | tee ~/.rivetos/rivetos.log')
  console.log('')
  console.log('Or set up the systemd service:')
  console.log('  rivetos service init')
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`Usage: rivetos logs [agent] [options]

Arguments:
  agent                    Agent name to filter (e.g. opus, grok, local)

Options:
  -f, --follow             Follow mode (default: on)
  --no-follow              Show recent logs and exit
  -n, --lines <count>      Lines to show in no-follow mode (default: 50)
  --since <timespec>       Show entries since time (e.g. "1h", "30m", "2025-04-01")
  --level <level>          Filter by log level (error, warn, info, debug)
  --grep <pattern>         Filter by pattern
  --json                   Raw JSON output
  -h, --help               Show this help

Examples:
  rivetos logs                         Follow all agents
  rivetos logs opus                    Follow opus agent only
  rivetos logs --level error           Only errors
  rivetos logs --no-follow -n 200      Last 200 lines
  rivetos logs --since 1h              Last hour
  rivetos logs opus --level warn       Opus warnings
`)
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export default function logs(): void {
  const opts = parseArgs()
  const deployment = detectDeployment()

  switch (deployment) {
    case 'docker':
      dockerLogs(opts)
      break
    case 'systemd':
      systemdLogs(opts)
      break
    case 'bare':
      bareLogs(opts)
      break
  }
}
