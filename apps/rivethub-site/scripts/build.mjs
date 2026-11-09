import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { injectFamilyChrome } from '../../public-sites/chrome.mjs';
import { renderPosthogConfig, resolvePosthogEnv } from './posthog-env.mjs';

const source = new URL('../public/', import.meta.url);
const output = new URL('../dist/', import.meta.url);
const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
await cp(new URL('../../public-sites/family.css', import.meta.url), new URL('family.css', output));

const distDir = fileURLToPath(output);
for (const name of await readdir(distDir)) {
  if (!name.endsWith('.html')) continue;
  const file = new URL(name, output);
  const html = await readFile(file, 'utf8');
  await writeFile(file, injectFamilyChrome(html, 'io'));
}

const posthog = resolvePosthogEnv();
await writeFile(new URL('posthog-config.js', output), renderPosthogConfig(posthog));
console.log(
  posthog.key
    ? 'Built RivetHub static site in apps/rivethub-site/dist (PostHog pageviews enabled)'
    : 'Built RivetHub static site in apps/rivethub-site/dist (PostHog pageviews off — no PUBLIC_POSTHOG_KEY)',
);
