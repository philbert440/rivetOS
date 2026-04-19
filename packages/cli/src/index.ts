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
 *   rivetos doctor                   — check config, providers, connectivity
 *   rivetos config init              — generate default config.yaml
 *   rivetos model                    — show providers + current models
 *   rivetos model <provider>         — show current model for a provider
 *   rivetos model <provider> <model> — switch default model (persistent)
 *   rivetos logs                     — tail runtime logs with filtering
 *   rivetos test                     — run smoke tests
 *   rivetos skills list              — show all discovered skills
 *   rivetos plugins list             — show loaded plugins with status
 *   rivetos version                  — show version
 */

const COMMANDS: Partial<Record<string, () => Promise<void> | void>> = {
  init: () => import('./commands/init.js').then((m) => m.default()),
  start: () => import('./commands/start.js').then((m) => m.default()),
  stop: () => import('./commands/stop.js').then((m) => m.default()),
  status: () => import('./commands/status.js').then((m) => m.default()),
  update: () => import('./commands/update.js').then((m) => m.default()),
  doctor: () => import('./commands/doctor.js').then((m) => m.default()),
  config: () => import('./commands/config.js').then((m) => m.default()),
  agent: () => import('./commands/agent.js').then((m) => m.default()),
  build: () => import('./commands/build.js').then((m) => m.default()),
  infra: () => import('./commands/infra.js').then((m) => m.default()),
  version: () => import('./commands/version.js').then((m) => m.default()),
  model: () => import('./commands/model.js').then((m) => m.default()),
  service: () => import('./commands/service.js').then((m) => m.default()),
  logs: () => import('./commands/logs.js').then((m) => m.default()),
  keys: () => import('./commands/keys.js').then((m) => m.default()),
  mesh: () => import('./commands/mesh.js').then((m) => m.default()),
  memory: () => import('./commands/memory.js').then((m) => m.default()),
  test: () => import('./commands/test.js').then((m) => m.default()),
  skills: () => import('./commands/skills.js').then((m) => m.default()),
  plugins: () => import('./commands/plugins.js').then((m) => m.default()),
  plugin: () => {
    const subArgs = process.argv.slice(3)
    const sub = subArgs[0]
    if (sub === 'init') {
      return import('./commands/plugin-init.js').then((m) => m.default(subArgs.slice(1)))
    }
    // Fall through to plugins list for unknown sub-commands
    return import('./commands/plugins.js').then((m) => m.default())
  },
  skill: () => {
    const subArgs = process.argv.slice(3)
    const sub = subArgs[0]
    if (sub === 'init') {
      return import('./commands/skill-init.js').then((m) => m.default(subArgs.slice(1)))
    }
    if (sub === 'validate') {
      return import('./commands/skill-validate.js').then((m) => m.default(subArgs.slice(1)))
    }
    // Fall through to skills list for unknown sub-commands
    return import('./commands/skills.js').then((m) => m.default())
  },
  help: () => showHelp(),
  // Provider commands — rivetos <provider> <action>
  anthropic: () => import('./commands/provider.js').then((m) => m.default('anthropic')),
  xai: () => import('./commands/provider.js').then((m) => m.default('xai')),
  google: () => import('./commands/provider.js').then((m) => m.default('google')),
  ollama: () => import('./commands/provider.js').then((m) => m.default('ollama')),
}

function showHelp(): void {
  console.log(`
  rivetos — Lightweight, stable agent runtime

  Setup:
    rivetos init                        Interactive setup wizard
    rivetos update                      Pull latest, rebuild containers
    rivetos doctor                      Check config and connectivity

  Runtime:
    rivetos start [--config <path>]     Start the runtime
    rivetos stop                        Stop the running instance
    rivetos status                      Show runtime status

  Configuration:
    rivetos config show                 Print config summary
    rivetos config validate             Validate config schema
    rivetos config edit                 Open config in $EDITOR
    rivetos config path                 Print config file path

  Agents:
    rivetos agent list                  List configured agents
    rivetos agent add                   Add a new agent interactively
    rivetos agent remove                Remove an agent

  Models:
    rivetos model                       Show all providers + current models
    rivetos model <provider>            Show current model for a provider
    rivetos model <provider> <model>    Switch default model (persistent)

  Infrastructure:
    rivetos infra up                    Deploy containers
    rivetos infra preview               Preview infrastructure changes
    rivetos infra destroy               Tear down containers
    rivetos build                       Build container images from source

  Keys:
    rivetos keys rotate                 Push new SSH key to all nodes
    rivetos keys list                   Show key status for each node

  Mesh:
    rivetos mesh list                   List all known mesh nodes
    rivetos mesh ping                   Health-check all mesh peers
    rivetos mesh join <host>            Join an existing mesh
    rivetos mesh status                 Show local mesh status

  Memory:
    rivetos memory backfill-tool-synth  Synthesize content for historical tool calls
    rivetos memory queue-status         Show ros_tool_synth_queue state

  Testing:
    rivetos test                        Run smoke tests (config, provider, memory, tools)
    rivetos test --quick                Skip provider test (saves tokens)

  Introspection:
    rivetos logs [options]              Tail runtime logs (--lines, --follow, --since, --grep)
    rivetos skills list                 Show all discovered skills
    rivetos plugins list                Show configured plugins with status

  Providers:
    rivetos <provider> status           Check provider connectivity
    rivetos ollama models               List available Ollama models

  Docs: https://rivetos.dev
  `)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]

  if (!command || command === '--help' || command === '-h') {
    showHelp()
    return
  }

  const handler = COMMANDS[command]
  if (!handler) {
    console.error(`Unknown command: ${command}`)
    showHelp()
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
