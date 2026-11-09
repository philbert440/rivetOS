import { LEGACY_DOCS, REPO_URL, familySite } from '../../public-sites/family.mjs';
import { attr, escapeHtml } from '../../public-sites/html.mjs';
import { badge, commandBlock, sourceNote } from '../../public-sites/render-page.mjs';

export function devPages(catalog) {
  return [
    {
      path: '/',
      file: 'index.html',
      navId: '/',
      title: 'RivetHub developer docs',
      description:
        'Contributor guidance for plugins and integrations in philbert440/rivetOS. Independent of rivetos.dev.',
      body: home(catalog),
    },
    {
      path: '/contributing.html',
      file: 'contributing.html',
      navId: '/contributing.html',
      title: 'Contributing — RivetHub developer docs',
      description: 'Development setup and PR guidelines from CONTRIBUTING.md.',
      body: contributing(),
    },
    {
      path: '/plugins.html',
      file: 'plugins.html',
      navId: '/plugins.html',
      title: 'Plugins — RivetHub developer docs',
      description: 'How to scaffold and write RivetOS plugins, from docs/PLUGINS.md.',
      body: plugins(catalog),
    },
    {
      path: '/integrations.html',
      file: 'integrations.html',
      navId: '/integrations.html',
      title: 'Integrations — RivetHub developer docs',
      description: 'In-repo integration kits and the support matrix.',
      body: integrations(catalog),
    },
    {
      path: '/architecture.html',
      file: 'architecture.html',
      navId: '/architecture.html',
      title: 'Architecture — RivetHub developer docs',
      description: 'Layering rules from CONTRIBUTING.md and docs/ARCHITECTURE.md.',
      body: architecture(),
    },
    {
      path: '/policies.html',
      file: 'policies.html',
      navId: '/policies.html',
      title: 'Policies — RivetHub developer docs',
      description: 'Approved repo policy versus draft statements.',
      body: policies(),
    },
  ];
}

function home(catalog) {
  const io = familySite('io');
  return `
<section class="hero">
  <p class="kicker">rivethub.dev</p>
  <h1>Developer docs for plugins and integrations</h1>
  <p class="lede">This site is a separate static build from the RivetOS docs at <a href="${attr(LEGACY_DOCS.origin)}/">${escapeHtml(LEGACY_DOCS.domain)}</a>. Install and downloads stay on <a href="${attr(io.origin)}/">${escapeHtml(io.domain)}</a>. Full runtime guides remain on <a href="${attr(LEGACY_DOCS.origin)}/">${escapeHtml(LEGACY_DOCS.domain)}</a>.</p>
</section>
<ul class="card-grid">
  <li><a href="contributing.html"><span class="title">Contributing</span><span>Fork, npm install, npm run ci, Nx, pull requests. From CONTRIBUTING.md.</span></a></li>
  <li><a href="plugins.html"><span class="title">Write a plugin</span><span>${catalog.plugins.length} in-repo plugins. Scaffold with npx rivetos plugin init.</span></a></li>
  <li><a href="integrations.html"><span class="title">Integrations</span><span>${catalog.integrations.length} README trees under integrations/, plus SUPPORT-MATRIX.md.</span></a></li>
  <li><a href="architecture.html"><span class="title">Architecture</span><span>Plugins depend on @rivetos/types only. From CONTRIBUTING.md.</span></a></li>
</ul>
<p>Source checkout path from CONTRIBUTING.md:</p>
${commandBlock('npx rivetos local')}
${sourceNote('CONTRIBUTING.md', `${REPO_URL}/blob/main/CONTRIBUTING.md`)}
`;
}

function contributing() {
  return `
<section class="hero">
  <p class="kicker">Contributing</p>
  <h1>Development setup from CONTRIBUTING.md</h1>
</section>
${sourceNote('CONTRIBUTING.md', `${REPO_URL}/blob/main/CONTRIBUTING.md`)}
<h2>Prerequisites</h2>
<ul class="rules">
  <li>Node.js ≥ 22 for npm install and rivetos local. rivetos init requires Node ≥ 24 (24 is used in CI and containers).</li>
  <li>npm (comes with Node)</li>
  <li>Git</li>
</ul>
<h2>Getting started</h2>
<ol class="rules">
  <li>Fork the repo on GitHub.</li>
  <li>Clone your fork.</li>
  <li>Install dependencies with <code>npm install</code> (automatically builds all packages).</li>
  <li>Verify with <code>npm run ci</code> (lint + build + test across every workspace project).</li>
  <li>Create a branch from main.</li>
</ol>
${commandBlock('npm install')}
${commandBlock('npm run ci')}
<h2>Nx</h2>
<p>CONTRIBUTING.md: RivetOS uses Nx to orchestrate the monorepo. Everyday commands include npm run lint, npm run build, npm test, npm run typecheck, and npx nx affected -t test.</p>
${commandBlock('npx nx g @rivetos/nx:plugin')}
${commandBlock('npx nx g @rivetos/nx:pr')}
<h2>Conventional commits</h2>
<p>CONTRIBUTING.md requires Conventional Commits: feat, fix, docs, test, chore, refactor. Scope is optional but encouraged for plugin work.</p>
<p>The Starlight copy of this file is at <a href="${attr(LEGACY_DOCS.origin)}/reference/contributing/">${escapeHtml(LEGACY_DOCS.domain)}/reference/contributing/</a>.</p>
`;
}

function plugins(catalog) {
  const items = catalog.plugins
    .map(
      (item) => `<article class="entry">
  <p>${badge('in-repo', 'In repo')} <span class="meta">${escapeHtml(item.type)}</span></p>
  <h2 class="title"><a href="${attr(item.href)}">${escapeHtml(item.title)}</a></h2>
  <p class="meta">${escapeHtml(item.path)}</p>
  <p>${escapeHtml(item.summary || '')}</p>
</article>`,
    )
    .join('\n');
  return `
<section class="hero">
  <p class="kicker">Plugins</p>
  <h1>Plugin development guide</h1>
  <p class="lede">docs/PLUGINS.md: RivetOS supports five plugin types: Providers, Channels, Tools, Memory, and Transports. Every plugin uses the same self-registration contract.</p>
</section>
${sourceNote('docs/PLUGINS.md', `${REPO_URL}/blob/main/docs/PLUGINS.md`)}
<h2>Scaffold a plugin</h2>
${commandBlock('npx rivetos plugin init')}
<p>Or: <code>npx nx g @rivetos/nx:plugin</code>. This creates plugins/{category}/{name}/ with package.json, tsconfig.json, src/index.ts, and a test file.</p>
<h2>Architecture rules</h2>
<ol class="rules">
  <li>Depend on @rivetos/types only. Plugins do not import from @rivetos/core or @rivetos/boot. (The MCP server transport is the exception; it ships a binary that runs outside the runtime. Memory plugin workers are separate packages under services/.)</li>
  <li>Export a manifest: PluginManifest const. This is the entry point boot uses.</li>
  <li>Declare package.json#rivetos. This is what discovery reads, without importing the package.</li>
  <li>Handle platform concerns internally. Message splitting, rate limits, API quirks: all inside the plugin.</li>
</ol>
<p>docs/PLUGINS.md: Boot scans every plugins/*/*/package.json (and any plugin_dirs from config). The descriptor's type and name must match the exported manifest.</p>
<p>Synced copy: <a href="${attr(LEGACY_DOCS.origin)}/guides/plugins/">${escapeHtml(LEGACY_DOCS.domain)}/guides/plugins/</a>.</p>
<h2>In-repo plugins</h2>
<div class="entries">${items}</div>
`;
}

function integrations(catalog) {
  const items = catalog.integrations
    .map(
      (item) => `<article class="entry">
  <p>${badge('in-repo', 'In repo')}</p>
  <h2 class="title"><a href="${attr(item.href)}">${escapeHtml(item.title)}</a></h2>
  <p class="meta">${escapeHtml(item.path)}</p>
  <p>${escapeHtml(item.summary || '')}</p>
</article>`,
    )
    .join('\n');
  return `
<section class="hero">
  <p class="kicker">Integrations</p>
  <h1>Capture and den kits</h1>
  <p class="lede">${escapeHtml(catalog.supportMatrix.summary)}</p>
  ${sourceNote(catalog.supportMatrix.path, catalog.supportMatrix.href)}
</section>
<div class="entries">${items}</div>
`;
}

function architecture() {
  return `
<section class="hero">
  <p class="kicker">Architecture</p>
  <h1>Layering from CONTRIBUTING.md</h1>
</section>
${sourceNote('CONTRIBUTING.md', `${REPO_URL}/blob/main/CONTRIBUTING.md`)}
<p>CONTRIBUTING.md: RivetOS follows a strict layered architecture: Types → Domain → Runtime → Boot.</p>
<p>The most important rule: plugins depend on @rivetos/types only. Never on @rivetos/core, never on other plugins, never on boot.</p>
<ul class="rules">
  <li>packages/types — Interfaces and contracts. Its only workspace dependency is @rivetos/den-protocol.</li>
  <li>packages/core/src/domain — Pure domain logic. Depends on types only.</li>
  <li>packages/core/src/runtime/ — Application layer.</li>
  <li>packages/boot/ — Composition root. The only layer that knows concrete plugin types.</li>
  <li>packages/cli/ — Command-line interface. Imports from @rivetos/boot.</li>
  <li>plugins/* — Implement interfaces from @rivetos/types. No cross-plugin imports.</li>
</ul>
<p>Full write-up: <a href="${REPO_URL}/blob/main/docs/ARCHITECTURE.md">docs/ARCHITECTURE.md</a> and <a href="${attr(LEGACY_DOCS.origin)}/reference/architecture/">${escapeHtml(LEGACY_DOCS.domain)}/reference/architecture/</a>.</p>
`;
}

function policies() {
  return `
<section class="hero">
  <p class="kicker">Policies</p>
  <h1>Approved files versus draft text</h1>
</section>
<h2>Approved in the repository</h2>
<ul class="rules">
  <li>LICENSE is Apache License 2.0.</li>
  <li>CONTRIBUTING.md: by contributing, you agree that your contributions will be licensed under the Apache License 2.0.</li>
  <li>apps/site/src/content/docs/privacy.md and apps/rivethub-site/public/privacy.html describe marketing-site pageviews and that the runtime does not phone home.</li>
  <li>apps/site/src/content/docs/terms.md describes the software as provided as-is.</li>
</ul>
<div class="callout"><strong>DRAFT / PROPOSED.</strong> This page does not add a CLA, a security bounty, or a code of conduct. Those documents are not in the repository root. The existing RivetOS docs landing at rivetos.dev states "Apache 2.0 · no CLA · no Rivet account"; that sentence lives on apps/site/src/pages/index.astro and is not restated here as a new legal promise.</div>
<p>This rivethub.dev build ships without an analytics snippet. Product pageviews, when a PostHog key is baked, are described on <a href="https://rivethub.io/privacy.html">rivethub.io/privacy.html</a>.</p>
`;
}
