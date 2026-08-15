/**
 * RivetOS CLI — command registry, help text and dispatch.
 *
 * Kept separate from `index.ts` (the bin shebang wrapper) so the registry,
 * the help text and the argv routing are importable — and therefore
 * testable — without executing the CLI as a side effect of the import.
 */

/** Args passed to a handler are everything *after* the command name. */
export type CommandHandler = (args: string[]) => Promise<void> | void

/**
 * Where `rivetos plugin <sub>` / `rivetos skill <sub>` dispatch to.
 * Resolved by a pure function so routing is testable without importing
 * (and thereby running) the underlying command modules.
 */
export type SubRoute =
  | { module: 'plugin-init'; args: string[] }
  | { module: 'plugins'; args: string[] }
  | { module: 'skill-init'; args: string[] }
  | { module: 'skill-validate'; args: string[] }
  | { module: 'skills'; args: string[] }

/** `rivetos plugin …` — only `init` has its own module; anything else lists. */
export function routePlugin(args: string[]): SubRoute {
  if (args[0] === 'init') return { module: 'plugin-init', args: args.slice(1) }
  return { module: 'plugins', args: [] }
}

/** `rivetos skill …` — `init` and `validate` have modules; anything else lists. */
export function routeSkill(args: string[]): SubRoute {
  if (args[0] === 'init') return { module: 'skill-init', args: args.slice(1) }
  if (args[0] === 'validate') return { module: 'skill-validate', args: args.slice(1) }
  return { module: 'skills', args: [] }
}

async function runSubRoute(route: SubRoute): Promise<void> {
  switch (route.module) {
    case 'plugin-init':
      return import('./commands/plugin-init.js').then((m) => m.default(route.args))
    case 'plugins':
      return import('./commands/plugins.js').then((m) => m.default())
    case 'skill-init':
      return import('./commands/skill-init.js').then((m) => m.default(route.args))
    case 'skill-validate':
      return import('./commands/skill-validate.js').then((m) => m.default(route.args))
    case 'skills':
      return import('./commands/skills.js').then((m) => m.default())
  }
}

export const COMMANDS: Partial<Record<string, CommandHandler>> = {
  init: () => import('./commands/init.js').then((m) => m.default()),
  start: () => import('./commands/start.js').then((m) => m.default()),
  stop: () => import('./commands/stop.js').then((m) => m.default()),
  status: () => import('./commands/status.js').then((m) => m.default()),
  update: () => import('./commands/update.js').then((m) => m.default()),
  doctor: () => import('./commands/doctor.js').then((m) => m.default()),
  config: () => import('./commands/config.js').then((m) => m.default()),
  agent: () => import('./commands/agent.js').then((m) => m.default()),
  build: () => import('./commands/build.js').then((m) => m.default()),
  version: () => import('./commands/version.js').then((m) => m.default()),
  model: () => import('./commands/model.js').then((m) => m.default()),
  service: () => import('./commands/service.js').then((m) => m.default()),
  logs: () => import('./commands/logs.js').then((m) => m.default()),
  keys: () => import('./commands/keys.js').then((m) => m.default()),
  mesh: () => import('./commands/mesh.js').then((m) => m.default()),
  gateway: () => import('./commands/gateway.js').then((m) => m.default()),
  memory: () => import('./commands/memory.js').then((m) => m.default()),
  db: () => import('./commands/db.js').then((m) => m.default()),
  test: () => import('./commands/test.js').then((m) => m.default()),
  skills: () => import('./commands/skills.js').then((m) => m.default()),
  plugins: () => import('./commands/plugins.js').then((m) => m.default()),
  plugin: (args) => runSubRoute(routePlugin(args)),
  skill: (args) => runSubRoute(routeSkill(args)),
  workflow: () => import('./commands/workflow.js').then((m) => m.default()),
  help: () => showHelp(),
  // Provider commands — rivetos <provider> <action>
  anthropic: () => import('./commands/provider.js').then((m) => m.default('anthropic')),
  xai: () => import('./commands/provider.js').then((m) => m.default('xai')),
  google: () => import('./commands/provider.js').then((m) => m.default('google')),
  ollama: () => import('./commands/provider.js').then((m) => m.default('ollama')),
}

/**
 * The `rivetos --help` screen.
 *
 * Every key in {@link COMMANDS} must appear here as a `rivetos <command>`
 * line — `cli.test.ts` enforces it, so a new command without a help entry
 * fails CI rather than shipping undiscoverable.
 */
export function helpText(): string {
  return `
  rivetos — Lightweight, stable agent runtime

  Setup:
    rivetos init                        Interactive setup wizard
    rivetos update                      Pull latest, rebuild containers
    rivetos doctor                      Check config and connectivity
    rivetos version                     Show CLI version and commit

  Runtime:
    rivetos start [--config <path>]     Start the runtime
    rivetos stop                        Stop the running instance
    rivetos status                      Show runtime status

  Service:
    rivetos service init                Generate the systemd unit file
    rivetos service start|stop|restart  Control the systemd service
    rivetos service status              Show systemd service status
    rivetos service logs                Tail systemd service logs

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

  Containers:
    rivetos build                       Build container images from source

  Keys:
    rivetos keys rotate                 Push new SSH key to all nodes
    rivetos keys list                   Show key status for each node

  Mesh:
    rivetos mesh list                   List all known mesh nodes
    rivetos mesh ping                   Health-check all mesh peers
    rivetos mesh join <host>            Join an existing mesh
    rivetos mesh status                 Show local mesh status

  Gateway:
    rivetos gateway token               Print the per-node gateway token
    rivetos gateway token --rotate      Mint a new gateway token
    rivetos gateway caps                Allow the gateway to bind :80/:443

  Memory:
    rivetos memory backfill-tool-synth  Enqueue historical tool calls for synthesis
    rivetos memory queue-status         Show graphile-worker job queue state
    rivetos memory retry-failed         Reset dead graphile jobs (after a code fix)

  Database:
    rivetos db migrate                  Apply pending Postgres migrations
    rivetos db status                   Show applied migrations

  Testing:
    rivetos test                        Run smoke tests (config, provider, memory, tools)
    rivetos test --quick                Skip provider test (saves tokens)

  Introspection:
    rivetos logs [options]              Tail runtime logs (--lines, --follow, --since, --grep)
    rivetos help                        Show this help

  Skills:
    rivetos skills list                 Show all discovered skills
    rivetos skill init <name>           Scaffold a new skill
    rivetos skill validate [name]       Validate a skill's SKILL.md

  Plugins:
    rivetos plugins list                Show configured plugins with status
    rivetos plugins sync                Refresh TUI plugin installs from source
    rivetos plugin init <type> <name>   Scaffold a new plugin

  Workflows:
    rivetos workflow new <name>         Scaffold a workflow directory

  Providers:
    rivetos anthropic status            Check Anthropic connectivity
    rivetos xai status                  Check xAI connectivity
    rivetos google status               Check Google connectivity
    rivetos ollama status               Check Ollama connectivity
    rivetos ollama models               List available Ollama models

  Docs: https://rivetos.dev
  `
}

export function showHelp(): void {
  console.log(helpText())
}

/** Result of splitting argv into a command plus its arguments. */
export interface ParsedInvocation {
  /** The command name, or `undefined` when the user asked for help. */
  command?: string
  /** Everything after the command name. */
  args: string[]
  /** True for a bare invocation, `--help` or `-h`. */
  wantsHelp: boolean
}

export function parseArgv(argv: string[]): ParsedInvocation {
  const [command, ...args] = argv
  if (!command || command === '--help' || command === '-h') {
    return { args, wantsHelp: true }
  }
  return { command, args, wantsHelp: false }
}

/**
 * Dispatch an invocation. Returns the process exit code rather than calling
 * `process.exit` itself, so callers (and tests) stay in control — and so a
 * successful long-lived command like `start` keeps the event loop open.
 */
export async function run(argv: string[]): Promise<number> {
  const { command, args, wantsHelp } = parseArgv(argv)

  if (wantsHelp) {
    showHelp()
    return 0
  }

  const handler = COMMANDS[command!]
  if (!handler) {
    console.error(`Unknown command: ${command}`)
    showHelp()
    return 1
  }

  try {
    await handler(args)
    return 0
  } catch (err: unknown) {
    console.error(`Error: ${(err as Error).message}`)
    return 1
  }
}
