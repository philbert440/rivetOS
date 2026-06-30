#!/usr/bin/env node
/**
 * Sync canonical docs/ (and CHANGELOG.md) into Starlight content.
 * Preserves existing frontmatter; rewrites internal doc links to site paths.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../..');
const CONTENT_ROOT = join(__dirname, '../src/content/docs');

const LINK_MAP = {
  'CONFIG-REFERENCE.md': '/reference/config/',
  'GETTING-STARTED.md': '/guides/getting-started/',
  'ARCHITECTURE.md': '/reference/architecture/',
  'PLUGINS.md': '/guides/plugins/',
  'SKILLS.md': '/guides/skills/',
  'DEPLOYMENT.md': '/guides/deployment/',
  'TROUBLESHOOTING.md': '/reference/troubleshooting/',
  'CONTRIBUTING.md': '/reference/contributing/',
  'CHANGELOG.md': '/reference/changelog/',
  'mesh.md': '/guides/mesh/',
  'mcp-auth.md': '/guides/mcp-auth/',
  'FILESYSTEM.md': '/reference/filesystem/',
  'MEMORY-DESIGN.md': '/reference/memory-design/',
  'docs/mesh.md': '/guides/mesh/',
  'docs/mcp-auth.md': '/guides/mcp-auth/',
  'docs/FILESYSTEM.md': '/reference/filesystem/',
  'docs/MEMORY-DESIGN.md': '/reference/memory-design/',
  'docs/CONFIG-REFERENCE.md': '/reference/config/',
  'docs/GETTING-STARTED.md': '/guides/getting-started/',
  'docs/ARCHITECTURE.md': '/reference/architecture/',
  'docs/PLUGINS.md': '/guides/plugins/',
  'docs/SKILLS.md': '/guides/skills/',
  'docs/DEPLOYMENT.md': '/guides/deployment/',
  'docs/TROUBLESHOOTING.md': '/reference/troubleshooting/',
};

const MAPPINGS = [
  {
    src: 'docs/GETTING-STARTED.md',
    dest: 'guides/getting-started.md',
    frontmatter: {
      title: 'Quick Start',
      sidebar: { order: 2 },
      description: 'Get RivetOS running in under 5 minutes',
    },
    bodyTransform: (body) => body.replace(/^# Getting Started/, '# Quick Start'),
  },
  {
    src: 'docs/DEPLOYMENT.md',
    dest: 'guides/deployment.md',
    frontmatter: {
      title: 'Deployment',
      sidebar: { order: 3 },
      description: 'Deploy RivetOS with Docker, Proxmox, or bare-metal',
    },
    bodyTransform: (body) =>
      body.replace(/^# Deployment Guide/, '# Deployment'),
  },
  {
    src: 'docs/PLUGINS.md',
    dest: 'guides/plugins.md',
    frontmatter: {
      title: 'Plugin Development',
      sidebar: { order: 4 },
      description: 'Write custom provider, channel, tool, and memory plugins',
    },
  },
  {
    src: 'docs/SKILLS.md',
    dest: 'guides/skills.md',
    frontmatter: {
      title: 'Skills',
      sidebar: { order: 7 },
      description: 'Write, test, and distribute agent skills',
    },
  },
  {
    src: 'docs/mesh.md',
    dest: 'guides/mesh.md',
    frontmatter: {
      title: 'Mesh Networking',
      sidebar: { order: 8 },
      description: 'Multi-node agent mesh with mTLS delegation',
    },
  },
  {
    src: 'docs/mcp-auth.md',
    dest: 'guides/mcp-auth.md',
    frontmatter: {
      title: 'MCP & Mesh Auth',
      sidebar: { order: 9 },
      description: 'Single-CA mTLS trust model for MCP and mesh',
    },
  },
  {
    src: 'docs/CONFIG-REFERENCE.md',
    dest: 'reference/config.md',
    frontmatter: {
      title: 'Configuration Reference',
      sidebar: { order: 1 },
      description: 'Every config option with types, defaults, and examples',
    },
  },
  {
    src: 'docs/ARCHITECTURE.md',
    dest: 'reference/architecture.md',
    frontmatter: {
      title: 'Architecture',
      sidebar: { order: 2 },
      description: 'System design, packages, plugins, and runtime lifecycle',
    },
  },
  {
    src: 'docs/TROUBLESHOOTING.md',
    dest: 'reference/troubleshooting.md',
    frontmatter: {
      title: 'Troubleshooting',
      sidebar: { order: 3 },
      description: 'Common issues and fixes',
    },
  },
  {
    src: 'CONTRIBUTING.md',
    dest: 'reference/contributing.md',
    frontmatter: {
      title: 'Contributing',
      sidebar: { order: 4 },
      description: 'Development setup, Nx workflow, and PR guidelines',
    },
  },
  {
    src: 'docs/FILESYSTEM.md',
    dest: 'reference/filesystem.md',
    frontmatter: {
      title: 'Filesystem Layout',
      sidebar: { order: 6 },
      description: 'Canonical paths for runtime, workspace, and shared storage',
    },
  },
  {
    src: 'docs/MEMORY-DESIGN.md',
    dest: 'reference/memory-design.md',
    frontmatter: {
      title: 'Memory System',
      sidebar: { order: 7 },
      description: 'Memory architecture, compaction, and retrieval design',
    },
  },
  {
    src: 'CHANGELOG.md',
    dest: 'reference/changelog.md',
    frontmatter: {
      title: 'Changelog',
      sidebar: { order: 5 },
      description: 'Version history and release notes',
    },
  },
];

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return { frontmatter: null, body: content };
  return { frontmatter: match[1], body: content.slice(match[0].length) };
}

function serializeFrontmatter(data) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const [subKey, subValue] of Object.entries(value)) {
        lines.push(`  ${subKey}: ${subValue}`);
      }
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

function rewriteLinks(body) {
  let out = body;
  for (const [from, to] of Object.entries(LINK_MAP)) {
    out = out.replaceAll(`](${from})`, `](${to})`);
  }
  // Site-friendly next-steps block for getting started
  out = out.replace(
    /## Next Steps\n\n([\s\S]*?)\n\n---/,
    `## Next Steps

- **[Channel Setup](/guides/channels/)** — Connect to Discord, Telegram, voice, and agent-to-agent messaging
- **[Provider Setup](/guides/providers/)** — Configure Anthropic, xAI, Google, Ollama, vLLM, llama-server, and claude-cli
- **[Mesh Networking](/guides/mesh/)** — Multi-node fleets with mTLS delegation
- **[Configuration Reference](/reference/config/)** — Every config option explained
- **[Architecture](/reference/architecture/)** — How the system works
- **[Plugins](/guides/plugins/)** — How to write your own channel, provider, or tool
- **[Skills](/guides/skills/)** — How to write and share skills
- **[Deployment](/guides/deployment/)** — Docker, Proxmox, multi-agent, networking
- **[Troubleshooting](/reference/troubleshooting/)** — Common issues and fixes

---`,
  );
  return out;
}

function syncOne({ src, dest, frontmatter, bodyTransform = (b) => b }) {
  const srcPath = join(REPO_ROOT, src);
  const destPath = join(CONTENT_ROOT, dest);

  if (!existsSync(srcPath)) {
    console.error(`skip (missing source): ${src}`);
    return;
  }

  let body = readFileSync(srcPath, 'utf8');
  if (src !== 'CHANGELOG.md') {
    body = body.replace(/^#[^\n]+\n+/, '');
  }
  body = bodyTransform(body);
  body = rewriteLinks(body);

  const existing = existsSync(destPath) ? readFileSync(destPath, 'utf8') : '';
  const parsed = parseFrontmatter(existing);
  const fm = parsed.frontmatter ? parseYamlFrontmatter(parsed.frontmatter) : frontmatter;
  const merged = { ...frontmatter, ...fm, sidebar: { ...frontmatter.sidebar, ...(fm.sidebar || {}) } };

  const output = serializeFrontmatter(merged) + body.trimStart();
  writeFileSync(destPath, output.endsWith('\n') ? output : output + '\n');
  console.log(`synced ${src} → ${dest}`);
}

function parseYamlFrontmatter(text) {
  const result = {};
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('  ') && current) {
      const m = line.trim().match(/^(\w+):\s*(.*)$/);
      if (m) result[current][m[1]] = m[2];
      continue;
    }
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (value === '') {
      result[key] = {};
      current = key;
    } else {
      result[key] = value;
      current = null;
    }
  }
  return result;
}

for (const mapping of MAPPINGS) {
  syncOne(mapping);
}

console.log('done');