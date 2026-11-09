import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { scanCatalog } from '../../public-sites/catalog.mjs';
import { familySite } from '../../public-sites/family.mjs';
import { writeSite } from '../../public-sites/write-site.mjs';
import { REPO_ROOT } from '../../public-sites/assets.mjs';
import { orgPages } from './pages.mjs';

const site = familySite('org');
const destDir = join(REPO_ROOT, site.distDir);

await rm(destDir, { recursive: true, force: true });
const catalog = await scanCatalog(REPO_ROOT);
await writeSite({ site, destDir, pages: orgPages(catalog) });
console.log(`Built ${site.domain} in ${site.distDir} (canonical ${site.origin})`);
