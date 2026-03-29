/**
 * rivetos config <subcommand>
 *
 * config init — generate default config.yaml
 */

import { writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const DEFAULT_CONFIG = `# RivetOS Configuration
# API keys via environment variables — never in this file.

runtime:
  workspace: ~/.rivetos/workspace
  default_agent: opus
  max_tool_iterations: 15

agents:
  opus:
    provider: anthropic
    default_thinking: medium
  grok:
    provider: xai
    default_thinking: low
  gemini:
    provider: google
    default_thinking: medium
  local:
    provider: llama-server
    default_thinking: off

providers:
  anthropic:
    model: claude-opus-4-6
    max_tokens: 8192
    # auth: ANTHROPIC_API_KEY env var, or run 'rivetos login anthropic'
  xai:
    model: grok-4-1-fast
    max_tokens: 8192
    # auth: XAI_API_KEY env var
  google:
    model: gemini-2.5-pro
    max_tokens: 8192
    # auth: GOOGLE_API_KEY env var
  llama-server:
    base_url: http://10.4.20.12:8000/v1
    model: rivet-v0.1
    temperature: 0.6

channels:
  telegram:
    # auth: TELEGRAM_BOT_TOKEN env var
    owner_id: "8093148723"
    allowed_users:
      - "8093148723"

memory:
  postgres:
    # auth: RIVETOS_PG_URL env var
`;

export default async function config(): Promise<void> {
  const subcommand = process.argv[3];

  if (!subcommand || subcommand === 'help') {
    console.log('Usage: rivetos config <subcommand>');
    console.log('');
    console.log('Subcommands:');
    console.log('  init    Generate default config.yaml');
    console.log('  show    Print current config path');
    return;
  }

  switch (subcommand) {
    case 'init': {
      const configPath = resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml');

      try {
        await access(configPath);
        console.log(`Config already exists: ${configPath}`);
        console.log('Delete it first if you want to regenerate.');
        return;
      } catch {}

      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, DEFAULT_CONFIG, 'utf-8');
      console.log(`✅ Config created: ${configPath}`);
      console.log('Edit it to match your setup, then run: rivetos start');
      break;
    }

    case 'show': {
      const configPath = resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml');
      try {
        await access(configPath);
        console.log(configPath);
      } catch {
        console.log('No config found. Run: rivetos config init');
      }
      break;
    }

    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      process.exit(1);
  }
}
