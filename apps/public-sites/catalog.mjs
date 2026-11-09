import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_URL } from './family.mjs';

/** Generator examples from CONTRIBUTING.md. Not in-repo packages. */
export const PROPOSED_STARTERS = Object.freeze([
  Object.freeze({
    id: 'proposal-channel-slack',
    kind: 'proposal',
    title: 'Slack channel plugin',
    status: 'proposal',
    sourcePath: 'CONTRIBUTING.md',
    href: `${REPO_URL}/blob/main/CONTRIBUTING.md`,
    command:
      'npx nx g @rivetos/nx:plugin --type=channel --name=slack --description="Slack workspace integration"',
    summary:
      'CONTRIBUTING.md uses this command as a generator example. There is no Slack plugin directory in this repository.',
  }),
  Object.freeze({
    id: 'proposal-provider-mistral',
    kind: 'proposal',
    title: 'Mistral provider plugin',
    status: 'proposal',
    sourcePath: 'CONTRIBUTING.md',
    href: `${REPO_URL}/blob/main/CONTRIBUTING.md`,
    command:
      'npx nx g @rivetos/nx:plugin --type=provider --name=mistral --description="Mistral AI models"',
    summary:
      'CONTRIBUTING.md uses this command as a generator example. There is no Mistral provider directory in this repository.',
  }),
  Object.freeze({
    id: 'proposal-tool-database',
    kind: 'proposal',
    title: 'Database tool plugin',
    status: 'proposal',
    sourcePath: 'CONTRIBUTING.md',
    href: `${REPO_URL}/blob/main/CONTRIBUTING.md`,
    command:
      'npx nx g @rivetos/nx:plugin --type=tool --name=database --description="SQL query tool"',
    summary:
      'CONTRIBUTING.md uses this command as a generator example. There is no database tool directory in this repository.',
  }),
]);

export async function scanCatalog(root) {
  const [plugins, examples, integrations] = await Promise.all([
    scanPlugins(root),
    scanExamples(root),
    scanIntegrations(root),
  ]);
  return {
    plugins,
    examples,
    integrations,
    proposals: [...PROPOSED_STARTERS],
    workspaceTemplates: {
      path: 'workspace-templates',
      href: `${REPO_URL}/tree/main/workspace-templates`,
      summary:
        'Repo-root workspace-templates/ is copied into packages/cli at publish time by packages/cli/scripts/bundle-templates.mjs. rivetos init / rivetos local copy those files into a workspace. This page does not reprint their contents.',
    },
    supportMatrix: {
      path: 'integrations/SUPPORT-MATRIX.md',
      href: `${REPO_URL}/blob/main/integrations/SUPPORT-MATRIX.md`,
      summary:
        'Honest harness status. Rows marked vendor-claimed, untested are not listed here as working community projects.',
    },
  };
}

async function scanPlugins(root) {
  const pluginsRoot = join(root, 'plugins');
  const categories = await readDirs(pluginsRoot);
  const out = [];
  for (const category of categories) {
    const names = await readDirs(join(pluginsRoot, category));
    for (const name of names) {
      const rel = `plugins/${category}/${name}`;
      const pkg = await readJson(join(root, rel, 'package.json'));
      if (!pkg?.rivetos) continue;
      out.push({
        id: `plugin-${category}-${name}`,
        kind: 'plugin',
        status: 'in-repo',
        category,
        name: pkg.rivetos.name || name,
        type: pkg.rivetos.type || category,
        packageName: pkg.name || `@rivetos/${category}-${name}`,
        title: pkg.name || name,
        summary: String(pkg.description || '').trim(),
        path: rel,
        href: `${REPO_URL}/tree/main/${rel}`,
      });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function scanExamples(root) {
  const dir = join(root, 'docs/examples');
  let names = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.yaml')).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const file of names) {
    const rel = `docs/examples/${file}`;
    const text = await readFile(join(root, rel), 'utf8');
    const intro = yamlIntro(text);
    out.push({
      id: `example-${file}`,
      kind: 'example',
      status: 'in-repo',
      title: intro.title || file,
      summary: intro.summary,
      path: rel,
      href: `${REPO_URL}/blob/main/${rel}`,
    });
  }
  return out;
}

async function scanIntegrations(root) {
  const dir = join(root, 'integrations');
  let top = [];
  try {
    top = await readDirs(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of top) {
    if (name === 'shared') continue;
    const topReadme = `integrations/${name}/README.md`;
    if (await exists(join(root, topReadme))) {
      out.push(await integrationEntry(root, topReadme));
    }
    const kids = await readDirs(join(dir, name));
    for (const kit of kids) {
      const rel = `integrations/${name}/${kit}/README.md`;
      if (await exists(join(root, rel))) out.push(await integrationEntry(root, rel));
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function integrationEntry(root, readmeRel) {
  const text = await readFile(join(root, readmeRel), 'utf8');
  const dir = readmeRel.replace(/\/README\.md$/, '');
  return {
    id: `integration-${dir.replaceAll('/', '-')}`,
    kind: 'integration',
    status: 'in-repo',
    title: headingOrPath(text, dir),
    summary: firstParagraph(text),
    path: dir,
    href: `${REPO_URL}/tree/main/${dir}`,
    readme: `${REPO_URL}/blob/main/${readmeRel}`,
  };
}

export function yamlIntro(text) {
  const lines = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) {
      const body = line.replace(/^#\s?/, '').trim();
      if (body) lines.push(body);
      continue;
    }
    if (line.trim() === '') {
      if (lines.length) break;
      continue;
    }
    break;
  }
  return { title: lines[0] || '', summary: lines.slice(1).join(' ') };
}

export function firstParagraph(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const block = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (block.length) break;
      continue;
    }
    if (trimmed.startsWith('#') || trimmed.startsWith('|') || trimmed.startsWith('-') || trimmed.startsWith('```')) {
      if (block.length) break;
      continue;
    }
    block.push(trimmed);
  }
  return block.join(' ').replace(/\s+/g, ' ').trim();
}

function headingOrPath(markdown, fallback) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

async function readDirs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
