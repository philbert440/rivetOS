/** Family public sites. One registry, three independent canonical outputs. */

export const REPO_URL = 'https://github.com/philbert440/rivetOS';

export const FAMILY_SITES = Object.freeze([
  Object.freeze({
    id: 'io',
    domain: 'rivethub.io',
    origin: 'https://rivethub.io',
    label: 'Product',
    title: 'RivetHub',
    description:
      'Product site for most users: install, downloads, support, privacy, and releases.',
    nxProject: 'rivethub-site',
    sourceRoot: 'apps/rivethub-site',
    distDir: 'apps/rivethub-site/dist',
    buildScript: 'apps/rivethub-site/scripts/build.mjs',
    localNav: Object.freeze([
      { href: '/install-local.html', label: 'Quickstart' },
      { href: '/apps.html', label: 'Downloads' },
      { href: '/support.html', label: 'Support' },
      { href: '/releases.html', label: 'Releases' },
      { href: '/privacy.html', label: 'Privacy' },
    ]),
  }),
  Object.freeze({
    id: 'org',
    domain: 'rivethub.org',
    origin: 'https://rivethub.org',
    label: 'Community',
    title: 'RivetHub community',
    description:
      'Open-source community index: in-repo examples, plugins, integrations, and proposed starters.',
    nxProject: 'rivethub-org',
    sourceRoot: 'apps/rivethub-org',
    distDir: 'apps/rivethub-org/dist',
    buildScript: 'apps/rivethub-org/scripts/build.mjs',
    localNav: Object.freeze([
      { href: '/', label: 'Home' },
      { href: '/examples.html', label: 'Examples' },
      { href: '/plugins.html', label: 'Plugins' },
      { href: '/integrations.html', label: 'Integrations' },
      { href: '/starters.html', label: 'Starters' },
      { href: '/contribute.html', label: 'Contribute' },
    ]),
  }),
  Object.freeze({
    id: 'dev',
    domain: 'rivethub.dev',
    origin: 'https://rivethub.dev',
    label: 'Developer docs',
    title: 'RivetHub developer docs',
    description:
      'Contributor guidance for modifying and building plugins and integrations.',
    nxProject: 'rivethub-dev',
    sourceRoot: 'apps/rivethub-dev',
    distDir: 'apps/rivethub-dev/dist',
    buildScript: 'apps/rivethub-dev/scripts/build.mjs',
    localNav: Object.freeze([
      { href: '/', label: 'Home' },
      { href: '/contributing.html', label: 'Contributing' },
      { href: '/plugins.html', label: 'Plugins' },
      { href: '/integrations.html', label: 'Integrations' },
      { href: '/architecture.html', label: 'Architecture' },
      { href: '/policies.html', label: 'Policies' },
    ]),
  }),
]);

/** Existing RivetOS docs app. Not a family output. Do not retarget. */
export const LEGACY_DOCS = Object.freeze({
  id: 'rivetos',
  domain: 'rivetos.dev',
  origin: 'https://rivetos.dev',
  label: 'RivetOS docs',
  nxProject: 'site',
  sourceRoot: 'apps/site',
  distDir: 'apps/site/dist',
  astroConfig: 'apps/site/astro.config.mjs',
  note: 'Canonical URL stays https://rivetos.dev. rivethub.dev is a separate build.',
});

export function familySite(id) {
  const site = FAMILY_SITES.find((entry) => entry.id === id);
  if (!site) throw new Error(`unknown family site: ${id}`);
  return site;
}

export function canonicalUrl(site, path = '/') {
  if (path === '/' || path === '') return `${site.origin}/`;
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${site.origin}${suffix}`;
}

export function otherFamilySites(id) {
  return FAMILY_SITES.filter((entry) => entry.id !== id);
}
