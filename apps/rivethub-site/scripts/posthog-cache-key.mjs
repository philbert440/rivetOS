import { posthogCacheDigest, ASTRO_ENV_FILES, HUB_ENV_FILES } from './posthog-env.mjs';

const root = process.argv[2];
const preset = process.argv[3] || 'hub';
if (!root) {
  process.stderr.write('usage: posthog-cache-key.mjs <project-root> [hub|astro]\n');
  process.exit(2);
}
const files = preset === 'astro' ? ASTRO_ENV_FILES : HUB_ENV_FILES;
process.stdout.write(posthogCacheDigest(root, process.env, files) + '\n');
