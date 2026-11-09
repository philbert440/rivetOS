import { REPO_URL } from '../../public-sites/family.mjs';
import { attr, escapeHtml } from '../../public-sites/html.mjs';
import { badge, commandBlock, sourceNote } from '../../public-sites/render-page.mjs';

export function orgPages(catalog) {
  return [
    {
      path: '/',
      file: 'index.html',
      navId: '/',
      title: 'RivetHub community',
      description:
        'In-repo examples, plugins, and integrations from philbert440/rivetOS. Proposed starters are marked.',
      body: home(catalog),
    },
    {
      path: '/examples.html',
      file: 'examples.html',
      navId: '/examples.html',
      title: 'Examples — RivetHub community',
      description: 'Config examples that live in docs/examples/ in philbert440/rivetOS.',
      body: examples(catalog),
    },
    {
      path: '/plugins.html',
      file: 'plugins.html',
      navId: '/plugins.html',
      title: 'Plugins — RivetHub community',
      description: 'Plugin packages in plugins/ that declare package.json#rivetos.',
      body: plugins(catalog),
    },
    {
      path: '/integrations.html',
      file: 'integrations.html',
      navId: '/integrations.html',
      title: 'Integrations — RivetHub community',
      description: 'Capture and den kits under integrations/ in philbert440/rivetOS.',
      body: integrations(catalog),
    },
    {
      path: '/starters.html',
      file: 'starters.html',
      navId: '/starters.html',
      title: 'Starters — RivetHub community',
      description: 'In-repo workspace templates and generator examples marked as proposals.',
      body: starters(catalog),
    },
    {
      path: '/contribute.html',
      file: 'contribute.html',
      navId: '/contribute.html',
      title: 'Contribute — RivetHub community',
      description: 'How to contribute using CONTRIBUTING.md in philbert440/rivetOS.',
      body: contribute(),
    },
  ];
}

function home(catalog) {
  return `
<section class="hero">
  <p class="kicker">rivethub.org</p>
  <h1>Community index for philbert440/rivetOS</h1>
  <p class="lede">This site lists files that already exist in the repository. It does not add a third-party showcase. Entries marked ${badge('proposal', 'Proposal')} are generator examples from CONTRIBUTING.md, not shipped packages.</p>
  ${sourceNote('philbert440/rivetOS', REPO_URL)}
</section>
<ul class="card-grid">
  <li><a href="examples.html"><span class="title">Examples</span><span class="meta">${catalog.examples.length} yaml files in docs/examples/</span><span>Comment headers from those files, plus a link to each path.</span></a></li>
  <li><a href="plugins.html"><span class="title">Plugins</span><span class="meta">${catalog.plugins.length} packages with package.json#rivetos</span><span>Descriptions come from each package.json.</span></a></li>
  <li><a href="integrations.html"><span class="title">Integrations</span><span class="meta">${catalog.integrations.length} README trees under integrations/</span><span>Also links integrations/SUPPORT-MATRIX.md.</span></a></li>
  <li><a href="starters.html"><span class="title">Starters</span><span class="meta">workspace-templates/ plus ${catalog.proposals.length} proposals</span><span>Proposals stay labeled. Nothing here is a live community gallery.</span></a></li>
</ul>
`;
}

function examples(catalog) {
  const items = catalog.examples
    .map(
      (item) => `<article class="entry">
  <p>${badge('in-repo', 'In repo')}</p>
  <h2 class="title"><a href="${attr(item.href)}">${escapeHtml(item.title)}</a></h2>
  <p class="meta">${escapeHtml(item.path)}</p>
  <p>${escapeHtml(item.summary || 'See the file.')}</p>
</article>`,
    )
    .join('\n');
  return `
<section class="hero">
  <p class="kicker">Examples</p>
  <h1>docs/examples/</h1>
  <p class="lede">Each card quotes the comment header of a yaml file in docs/examples/. docs/examples/README.md is the index in the repo. Some sentences in that README still mention Discord; the yaml files themselves say social bots were removed in Phase 5 and that human UX is RivetHub.</p>
  ${sourceNote('docs/examples/', `${REPO_URL}/tree/main/docs/examples`)}
</section>
<div class="entries">${items}</div>
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
  <h1>Packages that declare rivetos</h1>
  <p class="lede">Listed by scanning plugins/*/*/package.json for a rivetos field. The scaffold command is in docs/PLUGINS.md.</p>
  ${commandBlock('npx rivetos plugin init')}
  ${sourceNote('docs/PLUGINS.md', `${REPO_URL}/blob/main/docs/PLUGINS.md`)}
</section>
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
  <p class="source"><a href="${attr(item.readme)}">README</a></p>
</article>`,
    )
    .join('\n');
  return `
<section class="hero">
  <p class="kicker">Integrations</p>
  <h1>Kits under integrations/</h1>
  <p class="lede">Each card is a README that exists in the tree. Status of harnesses is in SUPPORT-MATRIX.md, including rows marked vendor-claimed, untested.</p>
  ${sourceNote(catalog.supportMatrix.path, catalog.supportMatrix.href)}
</section>
<div class="entries">${items}</div>
`;
}

function starters(catalog) {
  const proposals = catalog.proposals
    .map(
      (item) => `<article class="entry">
  <p>${badge('proposal', 'Proposal')}</p>
  <h2 class="title">${escapeHtml(item.title)}</h2>
  <p class="meta">${escapeHtml(item.sourcePath)}</p>
  <p>${escapeHtml(item.summary)}</p>
  ${commandBlock(item.command)}
  ${sourceNote(item.sourcePath, item.href)}
</article>`,
    )
    .join('\n');
  return `
<section class="hero">
  <p class="kicker">Starters</p>
  <h1>Templates in the repo, proposals labeled</h1>
  <p class="lede">${escapeHtml(catalog.workspaceTemplates.summary)}</p>
  <p class="source"><a href="${attr(catalog.workspaceTemplates.href)}">${escapeHtml(catalog.workspaceTemplates.path)}</a></p>
</section>
<h2>Proposed starters</h2>
<p>These commands appear in CONTRIBUTING.md as generator examples. They are not shipped packages.</p>
<div class="entries">${proposals}</div>
`;
}

function contribute() {
  return `
<section class="hero">
  <p class="kicker">Contribute</p>
  <h1>Follow CONTRIBUTING.md</h1>
  <p class="lede">The repository guide covers fork, clone, npm install, npm run ci, Nx, conventional commits, and pull requests. This community site does not add a second process.</p>
  ${sourceNote('CONTRIBUTING.md', `${REPO_URL}/blob/main/CONTRIBUTING.md`)}
</section>
<div class="callout"><strong>DRAFT.</strong> Extra community norms that are not already in CONTRIBUTING.md or LICENSE are not published here.</div>
<p>CONTRIBUTING.md ends with: by contributing, you agree that your contributions will be licensed under the Apache License 2.0.</p>
<p>The repository LICENSE file is Apache License 2.0. Some plugin package.json files declare MIT. Read the LICENSE file in the directory you are using.</p>
<p>Developer docs for plugins and integrations: <a href="https://rivethub.dev/">rivethub.dev</a>. RivetOS reference docs: <a href="https://rivetos.dev/">rivetos.dev</a>.</p>
`;
}
