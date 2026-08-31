#!/usr/bin/env node

/**
 * RivetOS CLI — @rivetos/cli
 *
 * Thin bin wrapper. The command registry, help text and argv routing live in
 * `./cli.js` so they can be imported (and tested) without running the CLI.
 *
 * Usage:
 *   rivetos init                     — first-run setup
 *   rivetos start                    — start the runtime
 *   rivetos start --config <path>    — start with specific config
 *   rivetos stop                     — stop the running instance
 *   rivetos status                   — show runtime status
 *   rivetos update                   — pull latest, rebuild, re-symlink
 *   rivetos doctor                   — check config, providers, connectivity
 *   rivetos config init              — run setup wizard (alias of rivetos init)
 *   rivetos model                    — show providers + current models
 *   rivetos model <provider>         — show current model for a provider
 *   rivetos model <provider> <model> — switch default model (persistent)
 *   rivetos logs                     — tail runtime logs with filtering
 *   rivetos test                     — run smoke tests
 *   rivetos skills list              — show all discovered skills
 *   rivetos plugins list             — show loaded plugins with status
 *   rivetos plugins sync             — refresh TUI plugin installs from source
 *   rivetos version                  — show version
 *
 * `rivetos help` prints the full list.
 */

import { run } from './cli.js'

void run(process.argv.slice(2)).then((code) => {
  // Only exit explicitly on failure: a clean run must leave long-lived
  // commands (`rivetos start`) holding the event loop open.
  if (code !== 0) process.exit(code)
})
