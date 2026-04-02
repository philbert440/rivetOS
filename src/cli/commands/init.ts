/**
 * rivetos init
 *
 * First-run setup:
 * 1. Create ~/.rivetos/ directory structure
 * 2. Generate default config.yaml (if not exists)
 * 3. Create workspace directory with template files
 * 4. Symlink binary to /usr/local/bin/rivetos
 * 5. Print next steps
 */

import { writeFile, mkdir, access, readlink, symlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..');

const DEFAULT_CONFIG = `# RivetOS Configuration
# API keys via environment variables — never in this file.

runtime:
  workspace: ~/.rivetos/workspace
  default_agent: opus
  max_tool_iterations: 15
  heartbeats:
    - agent: opus
      schedule: 30m
      prompt: "Read HEARTBEAT.md if it exists. Follow it. If nothing needs attention, reply HEARTBEAT_OK."
      output_channel: ""
      quiet_hours:
        start: 23
        end: 7

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
  xai:
    model: grok-4-1-fast
    max_tokens: 8192
  google:
    model: gemini-2.5-pro
    max_tokens: 8192
  llama-server:
    base_url: http://localhost:8000/v1
    model: local-model
    temperature: 0.4
    max_tokens: 16384

channels:
  telegram:
    owner_id: ""
    allowed_users: []

  discord:
    owner_id: ""
    channel_bindings: {}

memory:
  postgres: {}
`;

const TEMPLATES: Record<string, string> = {
  'SOUL.md': '# SOUL.md\n\nDefine who you are here.\n',
  'AGENTS.md': '# AGENTS.md\n\nAgent workspace configuration.\n',
  'IDENTITY.md': '# IDENTITY.md\n\nYour identity.\n',
  'USER.md': '# USER.md\n\nAbout your human.\n',
  'TOOLS.md': '# TOOLS.md\n\nTool notes and configurations.\n',
  'MEMORY.md': '# MEMORY.md\n\nLong-term memory.\n',
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export default async function init(): Promise<void> {
  const home = process.env.HOME ?? '/root';
  const rivetDir = resolve(home, '.rivetos');
  const workspaceDir = resolve(rivetDir, 'workspace');
  const memoryDir = resolve(workspaceDir, 'memory');
  const configPath = resolve(rivetDir, 'config.yaml');
  const binSource = resolve(ROOT, 'bin', 'rivetos');
  const binTarget = '/usr/local/bin/rivetos';

  console.log('RivetOS Init\n');

  // 1. Create directories
  for (const dir of [rivetDir, workspaceDir, memoryDir]) {
    if (await exists(dir)) {
      console.log(`  ⏭️  ${dir} (exists)`);
    } else {
      await mkdir(dir, { recursive: true });
      console.log(`  ✅ ${dir}`);
    }
  }

  // 2. Config
  if (await exists(configPath)) {
    console.log(`  ⏭️  ${configPath} (exists)`);
  } else {
    await writeFile(configPath, DEFAULT_CONFIG, 'utf-8');
    console.log(`  ✅ ${configPath}`);
  }

  // 3. Workspace templates
  for (const [name, content] of Object.entries(TEMPLATES)) {
    const filePath = resolve(workspaceDir, name);
    if (await exists(filePath)) {
      console.log(`  ⏭️  ${name} (exists)`);
    } else {
      await writeFile(filePath, content, 'utf-8');
      console.log(`  ✅ ${name}`);
    }
  }

  // 4. Symlink binary
  console.log('');
  try {
    if (await exists(binTarget)) {
      const current = await readlink(binTarget);
      if (current === binSource) {
        console.log(`  ⏭️  ${binTarget} → ${binSource} (exists)`);
      } else {
        console.log(`  ⚠️  ${binTarget} exists but points to ${current}`);
        console.log(`      Remove it manually if you want to re-link.`);
      }
    } else {
      await symlink(binSource, binTarget);
      console.log(`  ✅ ${binTarget} → ${binSource}`);
    }
  } catch (err: any) {
    if (err.code === 'EACCES') {
      console.log(`  ❌ Permission denied creating symlink. Try: sudo rivetos init`);
    } else {
      console.log(`  ❌ Symlink error: ${err.message}`);
    }
  }

  // 5. Next steps
  console.log(`
Done! Next steps:
  1. Edit ${configPath} with your API keys and settings
  2. Run: rivetos doctor    — verify connectivity
  3. Run: rivetos start     — launch the runtime
`);
}
