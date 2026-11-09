import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FAMILY_SITES, LEGACY_DOCS } from './family.mjs';
import { REPO_ROOT } from './assets.mjs';

const ARTIFACTS = join(REPO_ROOT, 'artifacts');
const PORTAL = '/opt/cursor/artifacts';

await rm(ARTIFACTS, { recursive: true, force: true });
await mkdir(ARTIFACTS, { recursive: true });

execFileSync(process.execPath, [join(REPO_ROOT, 'apps/public-sites/build-family.mjs')], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    PUBLIC_POSTHOG_KEY: '',
    NEXT_PUBLIC_POSTHOG_KEY: '',
  },
});

const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const files = [];

for (const site of FAMILY_SITES) {
  const dest = join(ARTIFACTS, site.domain);
  await cp(join(REPO_ROOT, site.distDir), dest, { recursive: true });
  const tarName = `${site.domain}.tar.gz`;
  execFileSync('tar', ['-czf', join(ARTIFACTS, tarName), '-C', ARTIFACTS, site.domain], {
    cwd: REPO_ROOT,
  });
  files.push(tarName);
}

const sums = [];
for (const name of files) {
  const buf = await readFile(join(ARTIFACTS, name));
  const hash = createHash('sha256').update(buf).digest('hex');
  sums.push(`${hash}  ${name}`);
}
await writeFile(join(ARTIFACTS, 'SHA256SUMS'), `${sums.join('\n')}\n`);

const posthogIo = await readFile(join(ARTIFACTS, 'rivethub.io/posthog-config.js'), 'utf8');
const manifest = {
  gitSha: sha,
  builtAt: new Date().toISOString(),
  analytics: {
    publicPosthogKeyBaked: !/RIVET_POSTHOG_KEY = ""/.test(posthogIo),
    note: 'Family builds in this pack run with PUBLIC_POSTHOG_KEY unset.',
  },
  family: FAMILY_SITES.map((site) => ({
    domain: site.domain,
    origin: site.origin,
    nxProject: site.nxProject,
    sourceRoot: site.sourceRoot,
    distDir: site.distDir,
    buildScript: site.buildScript,
    artifactDir: `artifacts/${site.domain}`,
    tarball: `artifacts/${site.domain}.tar.gz`,
  })),
  legacyDocs: {
    ...LEGACY_DOCS,
    note: 'Not packed here. Keep serving from nx site / apps/site/dist with canonical https://rivetos.dev.',
  },
  deployFromRepoSource: {
    io: 'Publish apps/rivethub-site/dist to the rivethub.io web root. Preserve an existing releases/ directory. See apps/rivethub-site/README.md.',
    org: 'Publish apps/rivethub-org/dist to the rivethub.org web root.',
    dev: 'Publish apps/rivethub-dev/dist to the rivethub.dev web root. Do not replace apps/site/dist or rivetos.dev with this tree.',
    hosting: 'Caddy routing, rsync hosts, and the private ops deploy.yml are not in this repository.',
  },
  hashes: Object.fromEntries(sums.map((line) => {
    const [hash, name] = line.split(/\s+/);
    return [name, hash];
  })),
};

await writeFile(join(ARTIFACTS, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

if (existsSync(PORTAL)) {
  const portalDir = join(PORTAL, 'rivethub-family-sites');
  await mkdir(portalDir, { recursive: true });
  for (const name of ['manifest.json', 'SHA256SUMS', ...files]) {
    await cp(join(ARTIFACTS, name), join(portalDir, name));
  }
}

console.log(`Packed family sites into ${ARTIFACTS}`);
