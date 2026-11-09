import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { copySharedAssets } from './assets.mjs';
import { renderPage, renderRobots, renderSitemap } from './render-page.mjs';

export async function writeSite({ site, destDir, pages }) {
  await mkdir(destDir, { recursive: true });
  await copySharedAssets(destDir);
  for (const page of pages) {
    const html = renderPage({
      siteId: site.id,
      path: page.path,
      title: page.title,
      description: page.description,
      navId: page.navId,
      body: page.body,
    });
    await writeFile(join(destDir, page.file), html);
  }
  const paths = pages.map((page) => page.path);
  await writeFile(join(destDir, 'sitemap.xml'), renderSitemap(site, paths));
  await writeFile(join(destDir, 'robots.txt'), renderRobots(site));
}
