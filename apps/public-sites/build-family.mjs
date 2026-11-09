import { execFileSync } from 'node:child_process';
import { FAMILY_SITES } from './family.mjs';
import { REPO_ROOT } from './assets.mjs';

for (const site of FAMILY_SITES) {
  execFileSync(process.execPath, [site.buildScript], { cwd: REPO_ROOT, stdio: 'inherit' });
}
