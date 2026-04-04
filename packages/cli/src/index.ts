#!/usr/bin/env node

/**
 * RivetOS CLI — @rivetos/cli
 *
 * Usage:
 *   rivetos init                     — first-run setup
 *   rivetos start                    — start the runtime
 *   rivetos start --config <path>    — start with specific config
 *   rivetos stop                     — stop the running instance
 *   rivetos status                   — show runtime status
 *   rivetos update                   — pull latest, rebuild, re-symlink
 *   rivetos login anthropic          — OAuth login for Anthropic (Claude subscription)
 *   rivetos doctor                   — check config, providers, connectivity
 *   rivetos config init              — generate default config.yaml
 *   rivetos logs                     — tail runtime logs with filtering
 *   rivetos skills list              — show all discovered skills
 *   rivetos plugins list             — show loaded plugins with status
 *   rivetos version                  — show version
 */

const COMMANDS: Record<string, () => Promise<void>> = {
  init: () => import('./commands/init.js').then((m) => m.default()),
  start: () => import('./commands/start.js').then((m) => m.default()),
  stop: () => import('./commands/stop.js').then((m) => m.default()),
  status: () => import('./commands/status.js').then((m) => m.default()),
  update: () => import('./commands/update.js').then((m) => m.default()),
  doctor: () => import('./commands/doctor.js').then((m) => m.default()),
  config: () => import('./commands/config.js').then((m) => m.default()),
  version: () => import('./commands/version.js').then((m) => m.default()),
  service: () => import('./commands/service.js').then((m) => m.default()),
  logs: () => import('./commands/logs.js').then((m) => m.default()),
  skills: () => import('./commands/skills.js').then((m) => m.default()),
  plugins: () => import('./commands/plugins.js').then((m) => m.default()),
  help: () => showHelp(),
  // Provider commands — rivetos <provider> <action>
  anthropic: () => import('./commands/provider.js').then((m) => m.default('anthropic')),
  xai: () => import('./commands/provider.js').then((m) => m.default('xai')),
  google: () => import('./commands/provider.js').then((m) => m.default('google')),
  ollama: () => import('./commands/provider.js').then((m) => m.default('ollama')),
}

function showHelp(): Promise<void> {
  console.log(`
  rivetos — Lightweight, stable agent runtime

  Setup:
    rivetos init                        First-run setup (config, workspace, symlink)
    rivetos update                      Pull latest, rebuild, re-symlink

  Usage:
    rivetos start [--config <path>]     Start the runtime
    rivetos stop                        Stop the running instance
    rivetos status                      Show runtime status
    rivetos doctor                      Check config and connectivity
    rivetos config init                 Generate default config.yaml
    rivetos version                     Show version

  Introspection:
    rivetos logs [options]              Tail runtime logs (--lines, --follow, --since, --grep)
    rivetos skills list                 Show all discovered skills
    rivetos plugins list                Show configured plugins with status

  Service:
    rivetos service init                Generate systemd unit file
    rivetos service start               Start the service
    rivetos service stop                Stop the service
    rivetos service restart             Restart the service
    rivetos service status              Show service status
    rivetos service logs                Tail service logs

  Providers:
    rivetos anthropic setup             OAuth login for Claude subscription
    rivetos anthropic status            Check auth status
    rivetos xai status                  Check xAI connectivity
    rivetos google status               Check Google connectivity
    rivetos ollama status               Check Ollama connectivity
    rivetos ollama models               List available models
    rivetos ollama pull <model>         Pull a model

  Docs: https://rivetos.dev
  `)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]

  if (!command || command === '--help' || command === '-h') {
    await showHelp()
    return
  }

  const handler = COMMANDS[command]
  if (!handler) {
    console.error(`Unknown command: ${command}`)
    await showHelp()
    process.exit(1)
  }

  try {
    await handler()
  } catch (err: unknown) {
    console.error(`Error: ${(err as Error).message}`)
    process.exit(1)
  }
}

void main()
