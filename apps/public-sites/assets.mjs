import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '../..');
const IO_PUBLIC = join(REPO_ROOT, 'apps/rivethub-site/public');

const FILES = [
  'robot.png',
  'favicon.png',
  'social-preview.png',
  'theme.js',
];

export async function copySharedAssets(destDir) {
  await mkdir(destDir, { recursive: true });
  for (const name of FILES) {
    await cp(join(IO_PUBLIC, name), join(destDir, name));
  }
  await cp(join(IO_PUBLIC, 'fonts'), join(destDir, 'fonts'), { recursive: true });
  await cp(join(HERE, 'family.css'), join(destDir, 'family.css'));
  await cp(join(HERE, 'family-site.css'), join(destDir, 'family-site.css'));
}

